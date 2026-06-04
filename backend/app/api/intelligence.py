"""Wave 4 — inteligencia del proceso.

Endpoints:
- /dependency-graph     refs cross-task tipo T260→T263 parseadas de docs/tasks
- /scope-drift          paths esperados vs runtime real (sin código aún → drift)
- /dead-agents          clasificación active / inactive / runtime-only / declared-only
- /coverage-matrix      runtime vs declared por agent
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from app.config import settings
from app.db import get_session
from app.models import (
    Agent,
    AgentInvocation,
    AgentMention,
    Project,
    RuntimeEvent,
    SddDocument,
    SddTask,
)

router = APIRouter(prefix="/api/projects", tags=["intelligence"])


# ───────────────────── Schemas ─────────────────────


class DepNode(BaseModel):
    id: UUID
    task_code: str | None
    title: str
    status: str | None
    cycle: str | None


class DepEdge(BaseModel):
    source: UUID  # task que menciona
    target_code: str  # T260, T263a, etc — porque a veces el target no tiene row
    resolved_id: UUID | None


class DependencyGraph(BaseModel):
    nodes: list[DepNode]
    edges: list[DepEdge]
    unresolved_codes: list[str]


class ScopeDriftRow(BaseModel):
    task_id: UUID
    task_code: str | None
    title: str
    expected_prefix: str
    actual_paths: list[str]
    drift: bool


class DeadAgentRow(BaseModel):
    agent_id: UUID
    name: str
    type: str
    doc_mentions: int
    runtime_mentions: int
    classification: str  # active | inactive | runtime_only | declared_only


class CoverageRow(BaseModel):
    agent_id: UUID
    name: str
    declared: bool   # tiene archivo .agent.md
    runtime_high: bool   # > 50 menciones
    runtime_count: int
    tasks_linked: int
    docs_coverage: int   # docs que lo mencionan


# ───────────────────── Helpers ─────────────────────


# Captura referencias tipo T260 / T260a / HU-WRP-C3-02 / T260-T263
TASK_REF_RE = re.compile(r"\b([TH][A-Z0-9]*-?\d+[A-Za-z0-9]*)\b")


def _resolve_root(project: Project) -> Path:
    raw = Path(project.path)
    if not raw.exists() and settings.scan_target_host_path == str(raw):
        return Path(settings.scan_target_mount_path)
    return raw


def _read_text_safe(p: Path, max_bytes: int = 64 * 1024) -> str:
    try:
        with p.open("rb") as fh:
            data = fh.read(max_bytes)
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


# ───────────────────── /dependency-graph ─────────────────────


@router.get("/{project_id}/dependency-graph", response_model=DependencyGraph)
def dependency_graph(
    project_id: UUID, session: Session = Depends(get_session)
) -> DependencyGraph:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    tasks = session.exec(
        select(SddTask).where(SddTask.project_id == project_id)
    ).all()

    # Index por código
    by_code: dict[str, SddTask] = {}
    for t in tasks:
        if t.task_code:
            by_code[t.task_code.upper()] = t

    root = _resolve_root(project)
    nodes = [
        DepNode(
            id=t.id,
            task_code=t.task_code,
            title=t.title,
            status=t.status,
            cycle=t.cycle,
        )
        for t in tasks
    ]

    edges: list[DepEdge] = []
    unresolved: set[str] = set()
    for t in tasks:
        if not t.file_path:
            continue
        text = _read_text_safe(root / t.file_path)
        if not text:
            continue
        # Buscamos refs y excluimos la propia
        own = (t.task_code or "").upper()
        for m in TASK_REF_RE.finditer(text):
            code = m.group(1).upper()
            if code == own:
                continue
            resolved = by_code.get(code)
            edges.append(
                DepEdge(
                    source=t.id,
                    target_code=code,
                    resolved_id=resolved.id if resolved else None,
                )
            )
            if resolved is None:
                unresolved.add(code)

    # Dedup edges (source, code)
    seen: set[tuple[UUID, str]] = set()
    deduped: list[DepEdge] = []
    for e in edges:
        key = (e.source, e.target_code)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(e)

    return DependencyGraph(nodes=nodes, edges=deduped, unresolved_codes=sorted(unresolved))


# ───────────────────── /scope-drift ─────────────────────


@router.get("/{project_id}/scope-drift", response_model=list[ScopeDriftRow])
def scope_drift(
    project_id: UUID, session: Session = Depends(get_session)
) -> list[ScopeDriftRow]:
    """Heurística MVP: una task que vive en `docs/A/B/tasks.md` "espera" que sus
    referencias toquen paths que empiezan con `A/B/`. Si las mentions runtime
    asociadas a esa task tocan otros prefijos, marcamos drift.

    Limitación conocida: no parseamos "Expected paths" del task description.
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    tasks = session.exec(
        select(SddTask)
        .where(SddTask.project_id == project_id, SddTask.file_path.is_not(None))  # type: ignore[union-attr]
    ).all()

    # Por simplicidad: mentions runtime asociadas a una task son las que se
    # crearon con file_path apuntando a `claude://session/...` cuyo snippet
    # menciona el task_code. Como no tenemos eso indexado todavía, usamos
    # mentions sobre el archivo de la task como aproximación.
    if not tasks:
        return []

    paths_of_interest = {t.file_path for t in tasks if t.file_path}
    mention_rows = session.exec(
        select(AgentMention.file_path)
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            ~AgentMention.file_path.like("claude://%"),  # type: ignore[operator]
        )
    ).all()
    actuals_by_task: dict[str, set[str]] = defaultdict(set)
    for fp in mention_rows:
        # Asociamos esta mention al task más cercano por prefijo común.
        for tp in paths_of_interest:
            prefix = "/".join(tp.split("/")[:-1]) + "/"
            if fp.startswith(prefix):
                actuals_by_task[tp].add(fp)
                break

    out: list[ScopeDriftRow] = []
    for t in tasks:
        if not t.file_path:
            continue
        prefix = "/".join(t.file_path.split("/")[:-1]) + "/"
        actuals = actuals_by_task.get(t.file_path, set())
        drift = any(not a.startswith(prefix) for a in actuals)
        if not actuals:
            continue
        out.append(
            ScopeDriftRow(
                task_id=t.id,
                task_code=t.task_code,
                title=t.title,
                expected_prefix=prefix,
                actual_paths=sorted(actuals)[:10],
                drift=drift,
            )
        )
    return out


# ───────────────────── /dead-agents ─────────────────────


@router.get("/{project_id}/dead-agents", response_model=list[DeadAgentRow])
def dead_agents(
    project_id: UUID, session: Session = Depends(get_session)
) -> list[DeadAgentRow]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    rows = session.exec(
        select(Agent.id, Agent.name, Agent.type).where(Agent.project_id == project_id)
    ).all()

    # mentions by agent, splitting runtime vs other
    mention_rows = session.exec(
        select(AgentMention.agent_id, AgentMention.source_type, func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id)
        .group_by(AgentMention.agent_id, AgentMention.source_type)
    ).all()
    rt: dict[UUID, int] = defaultdict(int)
    doc: dict[UUID, int] = defaultdict(int)
    for aid, src, count in mention_rows:
        n = int(count)
        if src and src.startswith("runtime_"):
            rt[aid] += n
        else:
            doc[aid] += n

    out: list[DeadAgentRow] = []
    for aid, name, atype in rows:
        r = rt.get(aid, 0)
        d = doc.get(aid, 0)
        if r > 0 and d > 0:
            cls = "active"
        elif r > 0 and d == 0:
            cls = "runtime_only"
        elif r == 0 and d > 0:
            cls = "declared_only"
        else:
            cls = "inactive"
        out.append(
            DeadAgentRow(
                agent_id=aid, name=name, type=atype,
                doc_mentions=d, runtime_mentions=r, classification=cls,
            )
        )
    # Ordenamos por "más muerto" arriba (inactive, declared_only, runtime_only, active)
    order = {"inactive": 0, "declared_only": 1, "runtime_only": 2, "active": 3}
    out.sort(key=lambda r: (order[r.classification], r.name))
    return out


# ───────────────────── /coverage-matrix ─────────────────────


@router.get("/{project_id}/coverage-matrix", response_model=list[CoverageRow])
def coverage_matrix(
    project_id: UUID, session: Session = Depends(get_session)
) -> list[CoverageRow]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    agents = session.exec(
        select(Agent).where(Agent.project_id == project_id)
    ).all()

    # runtime count per agent
    rt_rows = session.exec(
        select(AgentMention.agent_id, func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            AgentMention.source_type.like("runtime_%"),  # type: ignore[attr-defined]
        )
        .group_by(AgentMention.agent_id)
    ).all()
    rt = {aid: int(c) for aid, c in rt_rows}

    # docs that mention each agent
    docs_rows = session.exec(
        select(AgentMention.agent_id, func.count(func.distinct(AgentMention.file_path)))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            ~AgentMention.source_type.like("runtime_%"),  # type: ignore[operator]
        )
        .group_by(AgentMention.agent_id)
    ).all()
    docs_cov = {aid: int(c) for aid, c in docs_rows}

    # tasks linked (mentions sobre paths de tasks)
    task_paths = {
        t.file_path
        for t in session.exec(
            select(SddTask).where(SddTask.project_id == project_id)
        ).all()
        if t.file_path
    }
    task_link_rows = session.exec(
        select(AgentMention.agent_id, func.count(func.distinct(AgentMention.file_path)))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            AgentMention.file_path.in_(list(task_paths) or [""]),  # type: ignore[attr-defined]
        )
        .group_by(AgentMention.agent_id)
    ).all() if task_paths else []
    tasks_linked = {aid: int(c) for aid, c in task_link_rows}

    out: list[CoverageRow] = []
    for a in agents:
        runtime = rt.get(a.id, 0)
        out.append(
            CoverageRow(
                agent_id=a.id,
                name=a.name,
                declared=True,
                runtime_high=runtime > 50,
                runtime_count=runtime,
                tasks_linked=tasks_linked.get(a.id, 0),
                docs_coverage=docs_cov.get(a.id, 0),
            )
        )
    out.sort(key=lambda r: -r.runtime_count)
    return out


# ───────────────────── /task-flows ─────────────────────
# Flow de delegación REAL por tarea: qué agentes intervinieron (runSubagent) en
# cada tarea, con detección de patrones por dominio y anomalías.

_TASK_CODE_RE = re.compile(r"\b(T\d{2,}[a-z]?)\b")
_HU_RE = re.compile(r"\b(HU-\d+-[A-Z]+)\b")
# Agentes "agnósticos de dominio" — no disparan anomalía de mismatch.
_DOMAIN_AGNOSTIC = {"test", "planning", "other"}
# Dominios de desarrollo concretos (sí disparan mismatch si no coinciden).
_DEV_DOMAINS = {"frontend", "backend", "wrapper", "devops"}


def _infer_task_ref(description: str | None, event_task_ids: list[str] | None) -> str | None:
    if description:
        m = _TASK_CODE_RE.search(description)
        if m:
            return m.group(1).upper()
        m = _HU_RE.search(description)
        if m:
            return m.group(1).upper()
    if event_task_ids:
        return str(event_task_ids[0]).upper()
    return None


def _expected_domain(agent_name: str) -> str:
    n = agent_name.lower()
    if "tdd" in n or "test" in n or "e2e" in n or "playwright" in n:
        return "test"
    if "frontend" in n:
        return "frontend"
    if "backend" in n:
        return "backend"
    if "satellite" in n or "sync-api" in n:
        return "wrapper"
    if "devops" in n or "observability" in n:
        return "devops"
    if any(k in n for k in ("architect", "orchestrator", "refinement", "speckit", "plan", "explore")):
        return "planning"
    return "other"


def _hu_domain(task_ref: str) -> str | None:
    if task_ref.startswith("HU-"):
        if task_ref.endswith("-FE"):
            return "frontend"
        if task_ref.endswith("-BE"):
            return "backend"
    return None


class FlowAgent(BaseModel):
    agent_name: str
    declared: bool
    invocations: int
    with_result: int
    expected_domain: str
    domain_mismatch: bool


class TaskFlow(BaseModel):
    task_ref: str
    task_id: UUID | None
    domain: str | None
    status: str | None
    title: str | None
    agents: list[FlowAgent]
    distinct_agents: int
    total_invocations: int
    sessions: int
    first_at: str | None
    last_at: str | None
    warnings: list[str]  # few_agents | domain_mismatch | no_result


class DomainPattern(BaseModel):
    domain: str
    tasks: int
    typical_agents: list[dict]  # {agent_name, freq_pct}


class TaskFlowsResponse(BaseModel):
    flows: list[TaskFlow]
    patterns: list[DomainPattern]


@router.get("/{project_id}/task-flows", response_model=TaskFlowsResponse)
def task_flows(project_id: UUID, session: Session = Depends(get_session)) -> TaskFlowsResponse:
    """Agrupa las delegaciones reales (agent_invocations) por tarea inferida y
    deriva: agentes que intervinieron, anomalías y patrones por dominio.

    Inferencia de tarea (cascada): description de la delegación → task_ids del
    evento padre (event_metadata.inference)."""
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.project_id == project_id)
    ).all()
    if not invs:
        return TaskFlowsResponse(flows=[], patterns=[])

    # Map runtime_event_id → task_ids inferidos (fallback).
    ev_ids = [iv.runtime_event_id for iv in invs if iv.runtime_event_id]
    ev_task_ids: dict[UUID, list[str]] = {}
    if ev_ids:
        for ev in session.exec(
            select(RuntimeEvent).where(RuntimeEvent.id.in_(ev_ids))  # type: ignore[attr-defined]
        ).all():
            md = ev.event_metadata or {}
            inf = md.get("inference") or {}
            tids = inf.get("task_ids") or []
            if tids:
                ev_task_ids[ev.id] = tids

    # Tasks declaradas → por task_code.
    tasks = session.exec(select(SddTask).where(SddTask.project_id == project_id)).all()
    task_by_code = {t.task_code.upper(): t for t in tasks if t.task_code}

    # Agrupar invocaciones por task_ref.
    groups: dict[str, list[AgentInvocation]] = defaultdict(list)
    for iv in invs:
        ref = _infer_task_ref(
            iv.description, ev_task_ids.get(iv.runtime_event_id) if iv.runtime_event_id else None
        )
        if ref is None:
            continue  # delegaciones sin tarea identificable: fuera del flow por tarea
        groups[ref].append(iv)

    flows: list[TaskFlow] = []
    # Para patrones: dominio → {agent → set(task_refs)}
    domain_agent_tasks: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    domain_task_count: dict[str, set[str]] = defaultdict(set)

    for ref, items in groups.items():
        task = task_by_code.get(ref)
        domain = (task.domain if task else None) or _hu_domain(ref)
        # Agregar por agente.
        per_agent: dict[str, dict] = {}
        sessions_set: set[str] = set()
        times: list = []
        for iv in items:
            a = per_agent.setdefault(
                iv.agent_name,
                {"declared": iv.agent_id is not None, "inv": 0, "wr": 0},
            )
            a["inv"] += 1
            if (iv.result_chars or 0) > 0:
                a["wr"] += 1
            if iv.session_id:
                sessions_set.add(iv.session_id)
            times.append(iv.timestamp)
        agents: list[FlowAgent] = []
        warnings: list[str] = []
        for name, agg in sorted(per_agent.items(), key=lambda kv: -kv[1]["inv"]):
            exp = _expected_domain(name)
            mismatch = bool(
                domain in _DEV_DOMAINS and exp in _DEV_DOMAINS and exp != domain
            )
            if mismatch:
                warnings.append(f"domain_mismatch:{name}")
            agents.append(
                FlowAgent(
                    agent_name=name,
                    declared=agg["declared"],
                    invocations=agg["inv"],
                    with_result=agg["wr"],
                    expected_domain=exp,
                    domain_mismatch=mismatch,
                )
            )
            # patrones
            if domain:
                domain_agent_tasks[domain][name].add(ref)
        if domain:
            domain_task_count[domain].add(ref)

        distinct = len(per_agent)
        # Warning pedido: tarea con < 2 agentes (flujo incompleto: esperado impl + test).
        if distinct < 2:
            warnings.append("few_agents")
        # Warning: ningún agente devolvió resultado.
        if all(a["wr"] == 0 for a in per_agent.values()):
            warnings.append("no_result")

        flows.append(
            TaskFlow(
                task_ref=ref,
                task_id=task.id if task else None,
                domain=domain,
                status=task.status if task else None,
                title=task.title if task else None,
                agents=agents,
                distinct_agents=distinct,
                total_invocations=len(items),
                sessions=len(sessions_set),
                first_at=min(times).isoformat() if times else None,
                last_at=max(times).isoformat() if times else None,
                warnings=warnings,
            )
        )

    flows.sort(key=lambda f: (f.last_at or ""), reverse=True)

    # Patrones por dominio: frecuencia de cada agente = % de tasks del dominio que lo usaron.
    patterns: list[DomainPattern] = []
    for dom, agent_tasks in domain_agent_tasks.items():
        ntasks = len(domain_task_count[dom]) or 1
        typ = [
            {"agent_name": a, "freq_pct": round(100 * len(ts) / ntasks)}
            for a, ts in sorted(agent_tasks.items(), key=lambda kv: -len(kv[1]))
        ]
        patterns.append(DomainPattern(domain=dom, tasks=len(domain_task_count[dom]), typical_agents=typ))
    patterns.sort(key=lambda p: -p.tasks)

    return TaskFlowsResponse(flows=flows, patterns=patterns)


# ───────────────────── /agent-effectiveness ─────────────────────
# Calidad de participación por agente (no solo frecuencia). Score 0-100
# explicable y determinístico (sin IA), con trend y nivel de riesgo.

_ACTIVITY_FULL = 10  # nº de invocaciones que cuenta como "actividad plena" (100%)


class AgentEffectiveness(BaseModel):
    agent_name: str
    declared: bool
    invocations: int
    sessions: int
    tasks_associated: int
    tasks_completed: int
    with_result: int
    anomalies: int
    effectiveness_score: int  # 0..100
    # desglose (cada componente 0..100; None si no aplica → se renormaliza)
    completion_score: int | None
    result_score: int
    anomaly_free_score: int | None
    activity_score: int
    trend: float | None  # Δ result-rate (ventana reciente vs anterior), en puntos %
    risk: str  # low | medium | high


@router.get("/{project_id}/agent-effectiveness", response_model=list[AgentEffectiveness])
def agent_effectiveness(
    project_id: UUID, session: Session = Depends(get_session)
) -> list[AgentEffectiveness]:
    """Score de efectividad por agente. Determinístico:
    40% task-completion + 25% result-rate + 20% (1-anomaly-rate) + 15% actividad,
    renormalizando los componentes que no apliquen (agente sin tareas asociadas)."""
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.project_id == project_id)
    ).all()
    if not invs:
        return []

    # task_ids inferidos del evento padre (fallback de task_ref).
    ev_ids = [iv.runtime_event_id for iv in invs if iv.runtime_event_id]
    ev_task_ids: dict[UUID, list[str]] = {}
    if ev_ids:
        for ev in session.exec(
            select(RuntimeEvent).where(RuntimeEvent.id.in_(ev_ids))  # type: ignore[attr-defined]
        ).all():
            tids = ((ev.event_metadata or {}).get("inference") or {}).get("task_ids") or []
            if tids:
                ev_task_ids[ev.id] = tids

    tasks = session.exec(select(SddTask).where(SddTask.project_id == project_id)).all()
    task_by_code = {t.task_code.upper(): t for t in tasks if t.task_code}

    # Agregación por agente.
    agg: dict[str, dict] = {}
    for iv in invs:
        a = agg.setdefault(
            iv.agent_name,
            {
                "declared": iv.agent_id is not None,
                "inv": 0,
                "with_result": 0,
                "sessions": set(),
                "tasks": set(),       # task_refs asociados
                "anomaly_tasks": set(),
                "times": [],          # (timestamp, has_result) para el trend
            },
        )
        a["inv"] += 1
        has_result = (iv.result_chars or 0) > 0
        if has_result:
            a["with_result"] += 1
        if iv.session_id:
            a["sessions"].add(iv.session_id)
        a["times"].append((iv.timestamp, has_result))

        ref = _infer_task_ref(
            iv.description, ev_task_ids.get(iv.runtime_event_id) if iv.runtime_event_id else None
        )
        if ref:
            a["tasks"].add(ref)
            task = task_by_code.get(ref)
            domain = (task.domain if task else None) or _hu_domain(ref)
            exp = _expected_domain(iv.agent_name)
            mismatch = bool(domain in _DEV_DOMAINS and exp in _DEV_DOMAINS and exp != domain)
            if mismatch or not has_result:
                a["anomaly_tasks"].add(ref)

    out: list[AgentEffectiveness] = []
    for name, a in agg.items():
        inv = a["inv"]
        tasks_assoc = len(a["tasks"])
        tasks_done = sum(
            1
            for ref in a["tasks"]
            if (task_by_code.get(ref) and task_by_code[ref].status == "done")
        )
        result_rate = a["with_result"] / inv if inv else 0.0
        # Componentes 0..100 (None = no aplica → se excluye del promedio).
        completion = round(100 * tasks_done / tasks_assoc) if tasks_assoc else None
        result_sc = round(100 * result_rate)
        anomaly_free = round(100 * (1 - len(a["anomaly_tasks"]) / tasks_assoc)) if tasks_assoc else None
        activity = round(100 * min(1.0, inv / _ACTIVITY_FULL))

        weighted = [(completion, 0.40), (result_sc, 0.25), (anomaly_free, 0.20), (activity, 0.15)]
        present = [(s, w) for s, w in weighted if s is not None]
        total_w = sum(w for _, w in present)
        score = round(sum(s * w for s, w in present) / total_w) if total_w else 0

        # Trend: Δ result-rate entre la mitad reciente y la anterior de sus invocaciones.
        trend: float | None = None
        times = sorted(a["times"], key=lambda t: t[0])
        if len(times) >= 6:
            mid = len(times) // 2
            older, recent = times[:mid], times[mid:]
            rr_old = sum(1 for _, r in older if r) / len(older)
            rr_new = sum(1 for _, r in recent if r) / len(recent)
            trend = round(100 * (rr_new - rr_old), 1)

        anomalies = len(a["anomaly_tasks"])
        anomaly_rate = anomalies / tasks_assoc if tasks_assoc else 0.0
        if score < 50 or anomaly_rate > 0.4:
            risk = "high"
        elif score < 70 or anomalies > 0:
            risk = "medium"
        else:
            risk = "low"

        out.append(
            AgentEffectiveness(
                agent_name=name,
                declared=a["declared"],
                invocations=inv,
                sessions=len(a["sessions"]),
                tasks_associated=tasks_assoc,
                tasks_completed=tasks_done,
                with_result=a["with_result"],
                anomalies=anomalies,
                effectiveness_score=score,
                completion_score=completion,
                result_score=result_sc,
                anomaly_free_score=anomaly_free,
                activity_score=activity,
                trend=trend,
                risk=risk,
            )
        )

    out.sort(key=lambda e: -e.effectiveness_score)
    return out


# ───────────────────── /task-timeline ─────────────────────
# Task Replay: reconstruye la secuencia completa de una tarea (request → agentes
# → commit → cierre) desde las delegaciones reales. Sin prompts completos.

_COMMIT_RE = re.compile(r"\bgit\s+commit\b", re.IGNORECASE)
# Tools de edición (mismas que el visor de Ejecuciones, ambos providers).
_TIMELINE_EDIT_TOOLS = {
    "copilot_replaceString", "copilot_multiReplaceString", "copilot_createFile",
    "copilot_applyPatch", "Edit", "Write", "MultiEdit", "NotebookEdit",
}


class TimelineStep(BaseModel):
    kind: str  # request | agent | commit | closed
    label: str
    at: str
    agent_name: str | None = None
    declared: bool = False
    description: str | None = None  # consigna corta — NUNCA el prompt completo
    result_chars: int = 0
    provider: str | None = None
    tools: list[str] = []
    files: list[str] = []
    duration_s: int | None = None


class TaskTimeline(BaseModel):
    task_ref: str
    task_id: UUID | None
    title: str | None
    status: str | None
    domain: str | None
    sessions: int
    agents: list[str]
    total_duration_s: int | None
    files_touched: list[str]
    steps: list[TimelineStep]


@router.get("/{project_id}/task-timeline/{task_ref}", response_model=TaskTimeline)
def task_timeline(
    project_id: UUID, task_ref: str, session: Session = Depends(get_session)
) -> TaskTimeline:
    """Línea de tiempo de una tarea: request → delegaciones de agentes (orden,
    duración, resultado) → commit → cierre. Privacidad: solo consignas cortas."""
    task_ref = task_ref.upper()
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.project_id == project_id)
    ).all()

    ev_ids = [iv.runtime_event_id for iv in invs if iv.runtime_event_id]
    ev_task_ids: dict[UUID, list[str]] = {}
    if ev_ids:
        for ev in session.exec(
            select(RuntimeEvent).where(RuntimeEvent.id.in_(ev_ids))  # type: ignore[attr-defined]
        ).all():
            tids = ((ev.event_metadata or {}).get("inference") or {}).get("task_ids") or []
            if tids:
                ev_task_ids[ev.id] = tids

    matched = [
        iv
        for iv in invs
        if _infer_task_ref(
            iv.description, ev_task_ids.get(iv.runtime_event_id) if iv.runtime_event_id else None
        )
        == task_ref
    ]

    task = session.exec(
        select(SddTask).where(SddTask.project_id == project_id, SddTask.task_code.ilike(task_ref))  # type: ignore[attr-defined]
    ).first()

    if not matched:
        return TaskTimeline(
            task_ref=task_ref,
            task_id=task.id if task else None,
            title=task.title if task else None,
            status=task.status if task else None,
            domain=(task.domain if task else None) or _hu_domain(task_ref),
            sessions=0,
            agents=[],
            total_duration_s=None,
            files_touched=[],
            steps=[],
        )

    matched.sort(key=lambda iv: iv.timestamp)
    sessions_involved = {iv.session_id for iv in matched if iv.session_id}
    turn_keys = {(iv.session_id, iv.request_id) for iv in matched}

    # Eventos de los turnos involucrados → tools/files/commit por turno.
    turn_tools: dict[tuple, list[str]] = defaultdict(list)
    turn_files: dict[tuple, list[str]] = defaultdict(list)
    commit_steps: list[TimelineStep] = []
    if sessions_involved:
        sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]
        evs = session.exec(
            select(RuntimeEvent)
            .where(RuntimeEvent.project_id == project_id, sid_expr.in_(sessions_involved))
            .where(RuntimeEvent.event_type == "assistant")  # type: ignore[attr-defined]
            .order_by(RuntimeEvent.timestamp.asc())  # type: ignore[attr-defined]
        ).all()
        for ev in evs:
            md = ev.event_metadata or {}
            sid = md.get("session_id")
            tkey = (sid, md.get("turn_id") or md.get("request_id"))
            if tkey not in turn_keys:
                continue
            for t in md.get("tool_calls") or []:
                if isinstance(t, str):
                    turn_tools[tkey].append(t)
            turn_files[tkey].extend(md.get("files_touched") or [])
            for d in md.get("tool_calls_detail") or []:
                if isinstance(d, dict) and isinstance(d.get("command"), str) and _COMMIT_RE.search(d["command"]):
                    commit_steps.append(
                        TimelineStep(kind="commit", label="git commit", at=ev.timestamp.isoformat(),
                                     provider=ev.provider, tools=["commit"])
                    )

    steps: list[TimelineStep] = []
    # 1) Request inicial.
    first = matched[0]
    steps.append(
        TimelineStep(kind="request", label="User request", at=first.timestamp.isoformat(),
                     provider=first.provider, description=first.description)
    )
    # 2) Una step por delegación (orden temporal).
    agents_order: list[str] = []
    all_files: list[str] = []
    for iv in matched:
        tkey = (iv.session_id, iv.request_id)
        tools = list(dict.fromkeys(turn_tools.get(tkey, [])))
        files = list(dict.fromkeys(turn_files.get(tkey, [])))
        all_files.extend(files)
        if iv.agent_name not in agents_order:
            agents_order.append(iv.agent_name)
        steps.append(
            TimelineStep(
                kind="agent", label=iv.agent_name, at=iv.timestamp.isoformat(),
                agent_name=iv.agent_name, declared=iv.agent_id is not None,
                description=iv.description, result_chars=iv.result_chars or 0,
                provider=iv.provider, tools=tools[:12], files=files[:12],
            )
        )
    # 3) Commits detectados (intercalados por tiempo).
    steps.extend(commit_steps)
    # 4) Cierre si la tarea está done.
    if task and task.status == "done":
        steps.append(
            TimelineStep(kind="closed", label="Task closed",
                         at=max(iv.timestamp for iv in matched).isoformat())
        )

    steps.sort(key=lambda s: s.at)
    # Duración por step = hasta el siguiente.
    for i in range(len(steps) - 1):
        try:
            t0 = datetime.fromisoformat(steps[i].at)
            t1 = datetime.fromisoformat(steps[i + 1].at)
            steps[i].duration_s = int((t1 - t0).total_seconds())
        except ValueError:
            pass

    total = None
    if len(steps) >= 2:
        try:
            total = int(
                (datetime.fromisoformat(steps[-1].at) - datetime.fromisoformat(steps[0].at)).total_seconds()
            )
        except ValueError:
            total = None

    return TaskTimeline(
        task_ref=task_ref,
        task_id=task.id if task else None,
        title=task.title if task else None,
        status=task.status if task else None,
        domain=(task.domain if task else None) or _hu_domain(task_ref),
        sessions=len(sessions_involved),
        agents=agents_order,
        total_duration_s=total,
        files_touched=list(dict.fromkeys(all_files))[:50],
        steps=steps,
    )
