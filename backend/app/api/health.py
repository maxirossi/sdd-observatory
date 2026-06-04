"""Project Health + Cycle Intelligence + Progress Tracking.

Estos tres bloques del roadmap comparten el mismo agregador subyacente —
son vistas distintas del mismo set de queries sobre agents/docs/tasks/runtime.
"""
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func
from sqlmodel import Session, select

from app.db import get_session
from app.models import (
    Agent,
    AgentInvocation,
    AgentMention,
    CycleSnapshot,
    Project,
    RuntimeEvent,
    SddDocument,
    SddTask,
)
from app.services.git_audit import container_repo_path, get_audit

router = APIRouter(prefix="/api/projects", tags=["health"])


# ───────────────────── Schemas ─────────────────────


class CycleStatusCounts(BaseModel):
    done: int = 0
    in_progress: int = 0
    pending: int = 0
    unknown: int = 0


class DomainBreakdown(BaseModel):
    domain: str
    total: int
    done: int
    in_progress: int
    pending: int
    unknown: int


class CycleSummary(BaseModel):
    cycle: str
    label: str
    total_tasks: int
    status: CycleStatusCounts
    completion_pct: int  # 0..100, basado en done / total
    docs_count: int
    agents_referenced: int
    runtime_events: int
    last_activity: datetime | None
    state: str  # "wip" | "done" | "idle" | "empty"
    domains: list[DomainBreakdown]
    # Avance en la ventana (?since_hours). None si no se pidió o no hay baseline.
    delta_done: int | None = None
    baseline_at: datetime | None = None
    # Estado del ciclo en el inicio de la ventana (para mostrar el % a esa fecha).
    baseline: CycleStatusCounts | None = None
    baseline_total: int | None = None


class ProgressGlobal(BaseModel):
    tasks_total: int
    tasks_done: int
    tasks_in_progress: int
    tasks_pending: int
    tasks_unknown: int
    tasks_with_file: int  # tasks que apuntan a un file_path (proxy de "con código")
    traceability_pct: int  # cuántas tasks están mencionadas por runtime / total con file
    runtime_active: bool


class HealthDimension(BaseModel):
    """Una de las dimensiones del health score. score 0..100, weight es el peso
    en el cálculo final. Si la dimensión no tiene datos, score=None y su peso se
    redistribuye entre las demás (renormalización)."""

    key: str
    label: str
    score: int | None
    weight: float
    detail: str | None = None


class HealthRead(BaseModel):
    project_id: UUID
    last_scanned_at: datetime | None
    agents_total: int
    agents_used_runtime: int
    agents_coverage_pct: int
    docs_total: int
    docs_referenced: int  # docs que aparecen como source_type='document' en mentions
    cycles_total: int
    cycles_wip: int
    progress: ProgressGlobal
    runtime_last_24h: int
    health_score: int  # 0..100 ponderado (ver health_breakdown)
    health_breakdown: list[HealthDimension] = []


def _audit_score(mount_path: str) -> tuple[int | None, str | None]:
    """Score de auditoría 0..100 (penaliza pushes directos a base + branches
    grandes). None si el repo no está disponible. Determinístico y explicable."""
    try:
        report = get_audit(mount_path)
    except Exception:  # noqa: BLE001 — repo no montado / git ausente → dimensión sin datos
        return None, None
    if not report.get("available"):
        return None, report.get("reason")
    direct_recent = len(report.get("direct_to_base_recent") or [])
    large = len(report.get("large_branches") or [])
    direct_pen = min(30, direct_recent)          # 1 pto por push directo reciente, cap 30
    large_pen = min(25, large * 2)               # 2 ptos por branch grande, cap 25
    score = max(0, 100 - direct_pen - large_pen)
    detail = f"{direct_recent} pushes directos · {large} branches grandes"
    return score, detail


def _weighted_score(dims: list[HealthDimension]) -> int:
    """Promedio ponderado, renormalizando entre las dimensiones con datos."""
    present = [d for d in dims if d.score is not None]
    total_w = sum(d.weight for d in present)
    if total_w <= 0:
        return 0
    return round(sum(d.score * d.weight for d in present) / total_w)  # type: ignore[operator]


# ───────────────────── Helpers ─────────────────────


def _classify_state(counts: CycleStatusCounts, last_activity: datetime | None) -> str:
    total = counts.done + counts.in_progress + counts.pending + counts.unknown
    if total == 0:
        return "empty"
    if counts.in_progress > 0:
        return "wip"
    if counts.done == total:
        return "done"
    if last_activity and (datetime.utcnow() - last_activity) < timedelta(days=14):
        return "wip"
    return "idle"


def _label_cycle(cycle: str) -> str:
    # cycle-2-security-hardening → "Cycle 2 · Security Hardening"
    parts = cycle.split("-")
    if len(parts) >= 2 and parts[0] == "cycle" and parts[1].isdigit():
        suffix = " · " + " ".join(p.capitalize() for p in parts[2:]) if len(parts) > 2 else ""
        return f"Cycle {parts[1]}{suffix}"
    return cycle


# ───────────────────── /cycles ─────────────────────


def _baseline_by_cycle(
    project_id: UUID, since_hours: int, session: Session
) -> dict[str, CycleSnapshot]:
    """Para cada ciclo, el snapshot baseline: el más reciente ANTES del inicio de
    la ventana; si no hay, el más viejo dentro de la ventana (primer dato
    conocido). Devuelve {cycle: CycleSnapshot}."""
    cutoff = datetime.utcnow() - timedelta(hours=since_hours)
    snaps = session.exec(
        select(CycleSnapshot)
        .where(CycleSnapshot.project_id == project_id)
        .order_by(CycleSnapshot.captured_at.asc())  # type: ignore[attr-defined]
    ).all()
    before: dict[str, CycleSnapshot] = {}
    earliest: dict[str, CycleSnapshot] = {}
    for s in snaps:
        if s.cycle not in earliest:
            earliest[s.cycle] = s
        if s.captured_at <= cutoff:
            before[s.cycle] = s
    out: dict[str, CycleSnapshot] = {}
    for cyc in set(before) | set(earliest):
        out[cyc] = before.get(cyc) or earliest[cyc]
    return out


@router.get("/{project_id}/cycles", response_model=list[CycleSummary])
def list_cycles(
    project_id: UUID,
    since_hours: int | None = Query(None, ge=1, le=8760),
    session: Session = Depends(get_session),
) -> list[CycleSummary]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    baseline = _baseline_by_cycle(project_id, since_hours, session) if since_hours else {}

    # Tasks por (cycle, status)
    task_rows = session.exec(
        select(SddTask.cycle, SddTask.status, func.count(SddTask.id))
        .where(SddTask.project_id == project_id, SddTask.cycle.is_not(None))  # type: ignore[union-attr]
        .group_by(SddTask.cycle, SddTask.status)
    ).all()

    cycle_data: dict[str, dict] = {}
    for cyc, status, count in task_rows:
        bucket = cycle_data.setdefault(cyc, {"counts": CycleStatusCounts(), "domains": {}})
        c = bucket["counts"]
        n = int(count)
        if status == "done":
            c.done += n
        elif status == "in_progress":
            c.in_progress += n
        elif status == "pending":
            c.pending += n
        else:
            c.unknown += n

    # Por (cycle, domain, status) — para el stacked chart
    dom_rows = session.exec(
        select(SddTask.cycle, SddTask.domain, SddTask.status, func.count(SddTask.id))
        .where(SddTask.project_id == project_id, SddTask.cycle.is_not(None))  # type: ignore[union-attr]
        .group_by(SddTask.cycle, SddTask.domain, SddTask.status)
    ).all()
    for cyc, dom, status, count in dom_rows:
        bucket = cycle_data.setdefault(cyc, {"counts": CycleStatusCounts(), "domains": {}})
        dom_key = dom or "unknown"
        d = bucket["domains"].setdefault(
            dom_key,
            {"total": 0, "done": 0, "in_progress": 0, "pending": 0, "unknown": 0},
        )
        n = int(count)
        d["total"] += n
        if status in d:
            d[status] += n
        else:
            d["unknown"] += n

    # Docs por ciclo — heurística por path (.../Cycles/<cycle>/ o cycles/<cycle>/)
    doc_rows = session.exec(
        select(SddDocument.file_path).where(SddDocument.project_id == project_id)
    ).all()
    doc_count: dict[str, int] = {}
    for fp in doc_rows:
        # Capturamos primer segmento cycle-N
        parts = fp.split("/")
        for p in parts:
            if p.startswith("cycle-") and len(p) > 6 and "." not in p:
                doc_count[p] = doc_count.get(p, 0) + 1
                break

    # Runtime per cycle — usando agent mentions cuyo file_path contiene "cycle-X"
    mention_rows = session.exec(
        select(AgentMention.file_path, AgentMention.source_type)
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id)
    ).all()
    runtime_per_cycle: dict[str, int] = {}
    agents_per_cycle: dict[str, set[str]] = {}
    for fp, source_type in mention_rows:
        for p in fp.split("/"):
            if p.startswith("cycle-") and len(p) > 6:
                if source_type and source_type.startswith("runtime_"):
                    runtime_per_cycle[p] = runtime_per_cycle.get(p, 0) + 1
                else:
                    agents_per_cycle.setdefault(p, set()).add(fp)
                break

    all_cycles = set(cycle_data) | set(doc_count) | set(runtime_per_cycle)
    out: list[CycleSummary] = []
    for cyc in sorted(all_cycles):
        counts = cycle_data.get(cyc, {"counts": CycleStatusCounts()})["counts"]
        total = counts.done + counts.in_progress + counts.pending + counts.unknown
        pct = int(round((counts.done / total) * 100)) if total else 0
        state = _classify_state(counts, None)
        base = baseline.get(cyc)
        delta_done = (counts.done - base.done) if base else None
        domains_bucket = cycle_data.get(cyc, {}).get("domains", {}) if isinstance(cycle_data.get(cyc), dict) else {}
        domain_breakdown = [
            DomainBreakdown(
                domain=k,
                total=v["total"],
                done=v["done"],
                in_progress=v["in_progress"],
                pending=v["pending"],
                unknown=v["unknown"],
            )
            for k, v in sorted(domains_bucket.items(), key=lambda kv: -kv[1]["total"])
        ]
        out.append(
            CycleSummary(
                cycle=cyc,
                label=_label_cycle(cyc),
                total_tasks=total,
                status=counts,
                completion_pct=pct,
                docs_count=doc_count.get(cyc, 0),
                agents_referenced=len(agents_per_cycle.get(cyc, set())),
                runtime_events=runtime_per_cycle.get(cyc, 0),
                last_activity=None,
                state=state,
                domains=domain_breakdown,
                delta_done=delta_done,
                baseline_at=base.captured_at if base else None,
                baseline=(
                    CycleStatusCounts(
                        done=base.done,
                        in_progress=base.in_progress,
                        pending=base.pending,
                        unknown=base.unknown,
                    )
                    if base
                    else None
                ),
                baseline_total=base.total if base else None,
            )
        )
    return out


# ───────────────────── /health ─────────────────────


@router.get("/{project_id}/health", response_model=HealthRead)
def get_health(project_id: UUID, session: Session = Depends(get_session)) -> HealthRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    def _scalar(stmt) -> int:
        row = session.exec(stmt).one()
        return int(row[0] if isinstance(row, tuple) else row)

    agents_total = _scalar(
        select(func.count(Agent.id)).where(Agent.project_id == project_id)
    )
    agents_with_runtime = _scalar(
        select(func.count(func.distinct(AgentMention.agent_id)))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            AgentMention.source_type.like("runtime_%"),  # type: ignore[attr-defined]
        )
    )
    docs_total = _scalar(
        select(func.count(SddDocument.id)).where(SddDocument.project_id == project_id)
    )
    docs_referenced = _scalar(
        select(func.count(func.distinct(AgentMention.file_path)))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            ~AgentMention.source_type.like("runtime_%"),  # type: ignore[operator]
        )
    )

    # Tasks by status
    task_rows = session.exec(
        select(SddTask.status, func.count(SddTask.id))
        .where(SddTask.project_id == project_id)
        .group_by(SddTask.status)
    ).all()
    status_counts = {s: int(c) for s, c in task_rows}
    tasks_done = status_counts.get("done", 0)
    tasks_in_progress = status_counts.get("in_progress", 0)
    tasks_pending = status_counts.get("pending", 0)
    tasks_unknown = sum(c for s, c in status_counts.items() if s not in ("done", "in_progress", "pending"))
    tasks_total = tasks_done + tasks_in_progress + tasks_pending + tasks_unknown

    tasks_with_file = _scalar(
        select(func.count(SddTask.id))
        .where(SddTask.project_id == project_id, SddTask.file_path.is_not(None))  # type: ignore[union-attr]
    )

    # Cycles
    cycle_rows = session.exec(
        select(
            SddTask.cycle,
            func.count(SddTask.id),
            func.sum(case((SddTask.status == "in_progress", 1), else_=0)),
        )
        .where(SddTask.project_id == project_id, SddTask.cycle.is_not(None))  # type: ignore[union-attr]
        .group_by(SddTask.cycle)
    ).all()
    cycles_total = len(cycle_rows)
    cycles_wip = sum(1 for _, _, wip in cycle_rows if (wip or 0) > 0)

    since = datetime.utcnow() - timedelta(hours=24)
    runtime_24h = _scalar(
        select(func.count(RuntimeEvent.id))
        .where(RuntimeEvent.project_id == project_id, RuntimeEvent.timestamp >= since)
    )
    runtime_active = runtime_24h > 0

    # Traceability proxy: tasks_with_file / tasks_total (cuántas tasks tienen una landing
    # de código asociada — no es lo mismo que "tienen runtime", pero alcanza para MVP).
    traceability_pct = int(round((tasks_with_file / tasks_total) * 100)) if tasks_total else 0
    agents_coverage_pct = int(round((agents_with_runtime / agents_total) * 100)) if agents_total else 0

    # ── Health score v0.3: 5 dimensiones explicables y ponderadas ──
    # Tasks 30 · Traceability 20 · Agent Coverage 20 · Audit 15 · Runtime Quality 15.
    tasks_score = int(round(100 * tasks_done / tasks_total)) if tasks_total else None

    # Runtime Quality: % de delegaciones que devolvieron resultado (señal de que
    # el flujo agéntico produjo output útil). Sin delegaciones → proxy por actividad.
    inv_rows = session.exec(
        select(
            func.count(AgentInvocation.id),
            func.count(AgentInvocation.id).filter(AgentInvocation.result_chars > 0),  # type: ignore[attr-defined]
        ).where(AgentInvocation.project_id == project_id)
    ).first()
    inv_total = int(inv_rows[0]) if inv_rows else 0
    inv_with_result = int(inv_rows[1]) if inv_rows else 0
    if inv_total > 0:
        runtime_quality = int(round(100 * inv_with_result / inv_total))
        rq_detail = f"{inv_with_result}/{inv_total} delegaciones con resultado"
    else:
        runtime_quality = 100 if runtime_active else 0
        rq_detail = "sin delegaciones — proxy por actividad 24h"

    audit_sc, audit_detail = _audit_score(container_repo_path(project.path))

    breakdown = [
        HealthDimension(key="tasks", label="Tasks", score=tasks_score, weight=0.30,
                        detail=f"{tasks_done}/{tasks_total} done"),
        HealthDimension(key="traceability", label="Traceability", score=traceability_pct, weight=0.20,
                        detail=f"{tasks_with_file} tasks con código"),
        HealthDimension(key="coverage", label="Agent Coverage", score=agents_coverage_pct, weight=0.20,
                        detail=f"{agents_with_runtime}/{agents_total} agentes con runtime"),
        HealthDimension(key="audit", label="Audit", score=audit_sc, weight=0.15, detail=audit_detail),
        HealthDimension(key="runtime", label="Runtime Quality", score=runtime_quality, weight=0.15,
                        detail=rq_detail),
    ]
    score = _weighted_score(breakdown)

    return HealthRead(
        project_id=project_id,
        last_scanned_at=project.last_scanned_at,
        agents_total=agents_total,
        agents_used_runtime=agents_with_runtime,
        agents_coverage_pct=agents_coverage_pct,
        docs_total=docs_total,
        docs_referenced=docs_referenced,
        cycles_total=cycles_total,
        cycles_wip=cycles_wip,
        progress=ProgressGlobal(
            tasks_total=tasks_total,
            tasks_done=tasks_done,
            tasks_in_progress=tasks_in_progress,
            tasks_pending=tasks_pending,
            tasks_unknown=tasks_unknown,
            tasks_with_file=tasks_with_file,
            traceability_pct=traceability_pct,
            runtime_active=runtime_active,
        ),
        runtime_last_24h=int(runtime_24h),
        health_score=int(score),
        health_breakdown=breakdown,
    )
