"""Runtime API surface.

Reúne bajo `/api/runtime/*` los endpoints del módulo de captura runtime.
Las queries pesadas (timeline, sessions, runtime-sources) reusan las
implementaciones existentes. Lo nuevo aquí: `/runtime/health`,
`/runtime/top-agents` y `/runtime/collector/run` (admin).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.models import (
    Agent,
    AgentInvocation,
    AgentMention,
    ProviderConfig,
    RuntimeEvent,
)
from app.services.runtime import (
    SOURCE_KIND_LOCAL_LOGS,
    SOURCE_KIND_MANUAL_IMPORT,
    SOURCE_KIND_NETWORK_PROXY,
    SOURCE_KIND_PROJECT_SCAN,
)
from app.services.runtime import collector as runtime_collector
from app.services.runtime.registry import available_adapters

router = APIRouter(prefix="/api/runtime", tags=["runtime"])


# ───────────────────── Schemas ─────────────────────


class RuntimeProviderRow(BaseModel):
    provider: str
    enabled: bool
    available: bool
    source_kinds: list[str]
    events_total: int
    last_event_at: datetime | None
    sessions_total: int
    capture_metadata: bool
    capture_payload: bool
    capture_response: bool


class RuntimeHealth(BaseModel):
    providers_enabled: int
    providers_available: int
    providers_active_24h: int
    events_last_hour: int
    events_last_24h: int
    sessions_last_24h: int
    sources: dict[str, int]  # source_kind -> events count last 24h


class TopRuntimeAgent(BaseModel):
    agent_id: UUID
    name: str
    runtime_mentions: int
    sessions: int
    providers: list[str]


class CollectorRunResult(BaseModel):
    provider: str
    files_seen: int
    events_inserted: int
    skipped: int
    errors: int


class InvokedAgent(BaseModel):
    """Agente que REALMENTE intervino (delegación runSubagent/Task), no
    simplemente mencionado en texto."""

    agent_id: UUID | None
    agent_name: str
    declared: bool  # True si matchea un agent declarado del repo
    invocations: int
    sessions: int
    providers: list[str]
    last_invoked_at: datetime | None


class ClaimValidation(BaseModel):
    label: str
    status: str  # pass | fail


class AgentClaims(BaseModel):
    """Afirmaciones AUTO-REPORTADAS por el agente, parseadas de su `result`.
    NO son evidencia estructural — la UI las marca SELF REPORTED."""

    files: list[str] = []
    validations: list[ClaimValidation] = []


class AgentInvocationRow(BaseModel):
    id: UUID
    agent_id: UUID | None
    agent_name: str
    declared: bool
    provider: str
    tool: str
    session_id: str | None
    request_id: str | None
    runtime_event_id: UUID | None
    description: str | None
    model: str | None
    prompt_chars: int | None
    result_chars: int | None
    order_index: int
    timestamp: datetime
    # Solo poblados si privacy_mode ∈ (sanitized_payload, raw_local_only).
    sanitized_prompt: str | None = None
    sanitized_result: str | None = None
    # Claims parseados del result (self-reported, NO evidencia). None si no hay result.
    claims: AgentClaims | None = None


# ───────────────────── Helpers ─────────────────────


def _claude_session(re_obj: RuntimeEvent) -> str | None:
    md: dict[str, Any] | None = re_obj.event_metadata  # type: ignore[assignment]
    if not md:
        return None
    return md.get("session_id")


# ───────────────────── /runtime/providers ─────────────────────


@router.get("/providers", response_model=list[RuntimeProviderRow])
def list_runtime_providers(
    project_id: UUID | None = None,
    session: Session = Depends(get_session),
) -> list[RuntimeProviderRow]:
    """Estado por provider: enabled (config, global), available (adapter cargado),
    y eventos/sesiones/última actividad — scopeados al proyecto si se pasa project_id."""
    available = available_adapters()

    cfgs = {c.provider: c for c in session.exec(select(ProviderConfig)).all()}
    ev_q = select(
        RuntimeEvent.provider,
        func.count(RuntimeEvent.id),
        func.max(RuntimeEvent.timestamp),
    ).group_by(RuntimeEvent.provider)
    if project_id is not None:
        ev_q = ev_q.where(RuntimeEvent.project_id == project_id)
    event_rows = session.exec(ev_q).all()
    events_by_provider = {p: (int(c), ls) for p, c, ls in event_rows}

    # Sesiones distintas por provider (los claude logs guardan session_id en
    # event_metadata; los copilot logs no traen agrupador real, dejamos 0).
    sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]
    sess_q = (
        select(RuntimeEvent.provider, func.count(func.distinct(sid_expr)))
        .where(sid_expr.is_not(None))
        .group_by(RuntimeEvent.provider)
    )
    if project_id is not None:
        sess_q = sess_q.where(RuntimeEvent.project_id == project_id)
    session_rows = session.exec(sess_q).all()
    sessions_by_provider = {p: int(c) for p, c in session_rows}

    out: list[RuntimeProviderRow] = []
    providers_seen: set[str] = set()
    for name, adapter in available.items():
        providers_seen.add(name)
        cfg = cfgs.get(name)
        events, last = events_by_provider.get(name, (0, None))
        out.append(
            RuntimeProviderRow(
                provider=name,
                enabled=bool(cfg and cfg.enabled),
                available=True,
                source_kinds=[adapter.source_kind],
                events_total=events,
                last_event_at=last,
                sessions_total=sessions_by_provider.get(name, 0),
                capture_metadata=cfg.capture_metadata if cfg else True,
                capture_payload=cfg.capture_payload if cfg else False,
                capture_response=cfg.capture_response if cfg else False,
            )
        )

    # Providers que existen en DB pero no tienen adapter (legacy/orphans).
    for name, cfg in cfgs.items():
        if name in providers_seen:
            continue
        events, last = events_by_provider.get(name, (0, None))
        out.append(
            RuntimeProviderRow(
                provider=name,
                enabled=cfg.enabled,
                available=False,
                source_kinds=[],
                events_total=events,
                last_event_at=last,
                sessions_total=sessions_by_provider.get(name, 0),
                capture_metadata=cfg.capture_metadata,
                capture_payload=cfg.capture_payload,
                capture_response=cfg.capture_response,
            )
        )
    return out


# ───────────────────── /runtime/health ─────────────────────


@router.get("/health", response_model=RuntimeHealth)
def runtime_health(
    project_id: UUID | None = None,
    session: Session = Depends(get_session),
) -> RuntimeHealth:
    now = datetime.utcnow()
    h1 = now - timedelta(hours=1)
    h24 = now - timedelta(hours=24)

    # Filtro de proyecto reutilizable para todas las queries de RuntimeEvent.
    def _scoped(stmt):
        return stmt.where(RuntimeEvent.project_id == project_id) if project_id is not None else stmt

    # providers_enabled es config global (no depende del proyecto).
    providers_enabled = session.exec(
        select(func.count()).select_from(ProviderConfig).where(ProviderConfig.enabled.is_(True))  # type: ignore[union-attr]
    ).one()
    providers_enabled = providers_enabled[0] if isinstance(providers_enabled, tuple) else providers_enabled
    available = len(available_adapters())

    active_rows = session.exec(
        _scoped(
            select(RuntimeEvent.provider)
            .where(RuntimeEvent.timestamp >= h24)
            .group_by(RuntimeEvent.provider)
        )
    ).all()
    providers_active = len(active_rows)

    events_1h = session.exec(
        _scoped(select(func.count(RuntimeEvent.id)).where(RuntimeEvent.timestamp >= h1))
    ).one()
    events_1h = events_1h[0] if isinstance(events_1h, tuple) else events_1h
    events_24h = session.exec(
        _scoped(select(func.count(RuntimeEvent.id)).where(RuntimeEvent.timestamp >= h24))
    ).one()
    events_24h = events_24h[0] if isinstance(events_24h, tuple) else events_24h

    sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]
    sessions_24h = session.exec(
        _scoped(
            select(func.count(func.distinct(sid_expr))).where(
                RuntimeEvent.timestamp >= h24, sid_expr.is_not(None)
            )
        )
    ).one()
    sessions_24h = sessions_24h[0] if isinstance(sessions_24h, tuple) else sessions_24h

    source_rows = session.exec(
        _scoped(
            select(RuntimeEvent.source_kind, func.count(RuntimeEvent.id))
            .where(RuntimeEvent.timestamp >= h24)
            .group_by(RuntimeEvent.source_kind)
        )
    ).all()
    sources = {
        SOURCE_KIND_LOCAL_LOGS: 0,
        SOURCE_KIND_NETWORK_PROXY: 0,
        SOURCE_KIND_PROJECT_SCAN: 0,
        SOURCE_KIND_MANUAL_IMPORT: 0,
    }
    for kind, c in source_rows:
        sources[kind] = int(c)

    return RuntimeHealth(
        providers_enabled=int(providers_enabled),
        providers_available=available,
        providers_active_24h=providers_active,
        events_last_hour=int(events_1h),
        events_last_24h=int(events_24h),
        sessions_last_24h=int(sessions_24h),
        sources=sources,
    )


# ───────────────────── /runtime/top-agents ─────────────────────


@router.get("/top-agents", response_model=list[TopRuntimeAgent])
def top_agents(
    project_id: UUID | None = None,
    limit: int = Query(15, ge=1, le=100),
    session: Session = Depends(get_session),
) -> list[TopRuntimeAgent]:
    stmt = (
        select(
            Agent.id,
            Agent.name,
            func.count(AgentMention.id).label("mentions"),
        )
        .join(AgentMention, AgentMention.agent_id == Agent.id)
        .where(AgentMention.source_type.like("runtime_%"))  # type: ignore[attr-defined]
        .group_by(Agent.id, Agent.name)
        .order_by(func.count(AgentMention.id).desc())
        .limit(limit)
    )
    if project_id:
        stmt = stmt.where(Agent.project_id == project_id)
    base_rows = session.exec(stmt).all()
    if not base_rows:
        return []

    # Sessions distintas + providers — derivamos del file_path "claude://session/<sid>#..."
    agent_ids = [r[0] for r in base_rows]
    detail_rows = session.exec(
        select(AgentMention.agent_id, AgentMention.file_path, AgentMention.source_type)
        .where(
            AgentMention.agent_id.in_(agent_ids),  # type: ignore[attr-defined]
            AgentMention.source_type.like("runtime_%"),  # type: ignore[attr-defined]
        )
    ).all()
    sessions_per_agent: dict[UUID, set[str]] = {}
    providers_per_agent: dict[UUID, set[str]] = {}
    for aid, fp, src in detail_rows:
        if src and src.startswith("runtime_"):
            providers_per_agent.setdefault(aid, set()).add(
                src.replace("runtime_", "").split("_")[0]
            )
        if fp and "://session/" in fp:
            sid = fp.split("://session/", 1)[1].split("#", 1)[0]
            sessions_per_agent.setdefault(aid, set()).add(sid)

    return [
        TopRuntimeAgent(
            agent_id=aid,
            name=name,
            runtime_mentions=int(count),
            sessions=len(sessions_per_agent.get(aid, set())),
            providers=sorted(providers_per_agent.get(aid, set())),
        )
        for aid, name, count in base_rows
    ]


# ───────────────────── /runtime/live-status ─────────────────────


class LiveStatus(BaseModel):
    active: bool
    provider: str | None = None  # copilot | claude (el de la sesión más reciente)
    session_id: str | None = None
    age_seconds: int | None = None
    branch: str | None = None
    task_ref: str | None = None
    auto_run: bool = False  # disparado por el runner host (no manual)
    phase: str | None = None  # starting | delegating | agent_working | verifying
    pending_subagent: bool | None = None
    current_step: str | None = None
    active_agent: str | None = None
    agents_done: list[str] = []
    delegations_total: int | None = None
    todos_done: int | None = None
    todos_total: int | None = None


@router.get("/live-status", response_model=LiveStatus)
def live_status(
    project_id: UUID, session: Session = Depends(get_session)
) -> LiveStatus:
    """Estado en vivo del chatSession más reciente del proyecto (lee el tail del
    archivo, no la DB). Para polling ~2s desde el front."""
    from app.services.live_status import get_live_status

    return LiveStatus(**get_live_status(project_id, session))


# ───────────────────── /runtime/insights ─────────────────────


class ProviderInsight(BaseModel):
    provider: str
    events: int
    sessions: int
    executions: int
    distinct_agents: int
    avg_agents_per_session: float
    avg_session_duration_s: float
    avg_execution_duration_s: float
    delegations: int
    pct_delegated: float
    pct_inline: float
    pct_read_only: float


class ComparativeRow(BaseModel):
    metric: str
    unit: str = ""  # "", "s", "%", "x"
    claude: float | None = None
    copilot: float | None = None


class RuntimeInsights(BaseModel):
    providers: list[ProviderInsight]
    comparative: list[ComparativeRow]
    insights: list[str]  # frases determinísticas (sin IA)


def _gen_insights(by: dict[str, ProviderInsight]) -> list[str]:
    """Insights determinísticos comparando claude vs copilot. Solo se emiten
    cuando ambos providers tienen datos y la diferencia es significativa."""
    c = by.get("claude")
    g = by.get("copilot")
    out: list[str] = []
    if not c or not g:
        return out
    label = {"claude": "Claude", "copilot": "Copilot"}

    # Tasa de delegación: ratio entre el mayor y el menor.
    if c.pct_delegated > 0 and g.pct_delegated > 0:
        hi, lo = (("claude", c), ("copilot", g)) if c.pct_delegated >= g.pct_delegated else (("copilot", g), ("claude", c))
        ratio = hi[1].pct_delegated / lo[1].pct_delegated if lo[1].pct_delegated else 0
        if ratio >= 1.5:
            other = "copilot" if hi[0] == "claude" else "claude"
            out.append(f"{label[hi[0]]} delega {ratio:.1f}x más que {label[other]} ({hi[1].pct_delegated:.0f}% vs {lo[1].pct_delegated:.0f}% de ejecuciones).")
    elif c.pct_delegated > 0 and g.pct_delegated == 0:
        out.append(f"Claude delega ({c.pct_delegated:.0f}% de ejecuciones); Copilot no registra delegación.")
    elif g.pct_delegated > 0 and c.pct_delegated == 0:
        out.append(f"Copilot delega ({g.pct_delegated:.0f}% de ejecuciones); Claude no registra delegación.")

    # Inline.
    if abs(c.pct_inline - g.pct_inline) >= 10:
        if c.pct_inline >= g.pct_inline:
            name, hi_pi, lo_pi = "Claude", c, g
        else:
            name, hi_pi, lo_pi = "Copilot", g, c
        diff = hi_pi.pct_inline - lo_pi.pct_inline
        out.append(f"{name} ejecuta {diff:.0f} puntos % más tareas inline ({hi_pi.pct_inline:.0f}% vs {lo_pi.pct_inline:.0f}%).")

    # Variedad de agentes.
    if c.distinct_agents != g.distinct_agents and max(c.distinct_agents, g.distinct_agents) > 0:
        hi = "Claude" if c.distinct_agents > g.distinct_agents else "Copilot"
        out.append(f"{hi} usa más variedad de agentes ({c.distinct_agents} vs {g.distinct_agents}).")

    # Duración de sesión.
    if c.avg_session_duration_s > 0 and g.avg_session_duration_s > 0:
        ratio = max(c.avg_session_duration_s, g.avg_session_duration_s) / min(c.avg_session_duration_s, g.avg_session_duration_s)
        if ratio >= 1.5:
            hi = "Claude" if c.avg_session_duration_s > g.avg_session_duration_s else "Copilot"
            out.append(f"Las sesiones de {hi} duran {ratio:.1f}x más en promedio.")
    return out


@router.get("/insights", response_model=RuntimeInsights)
def runtime_insights_endpoint(
    project_id: UUID, session: Session = Depends(get_session)
) -> RuntimeInsights:
    """Análisis comparativo entre providers: KPIs por provider, tabla comparativa
    y insights determinísticos (sin IA)."""
    from collections import defaultdict

    from app.api.sessions import _build_executions  # local: evita ciclo de imports

    events = session.exec(
        select(RuntimeEvent)
        .where(RuntimeEvent.project_id == project_id)
        .where(RuntimeEvent.event_type.in_(["user", "assistant"]))  # type: ignore[attr-defined]
        .order_by(RuntimeEvent.timestamp.asc())  # type: ignore[attr-defined]
    ).all()
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.project_id == project_id)
    ).all()

    # Conteo total de eventos (todos los tipos) por provider.
    events_by_provider = {
        p: int(c)
        for p, c in session.exec(
            select(RuntimeEvent.provider, func.count(RuntimeEvent.id))
            .where(RuntimeEvent.project_id == project_id)
            .group_by(RuntimeEvent.provider)
        ).all()
    }

    # session_id → provider + ventana temporal (de los user/assistant cargados).
    sess_provider: dict[str, str] = {}
    sess_min: dict[str, datetime] = {}
    sess_max: dict[str, datetime] = {}
    for ev in events:
        sid = (ev.event_metadata or {}).get("session_id")
        if not sid:
            continue
        sess_provider.setdefault(sid, ev.provider)
        if sid not in sess_min or ev.timestamp < sess_min[sid]:
            sess_min[sid] = ev.timestamp
        if sid not in sess_max or ev.timestamp > sess_max[sid]:
            sess_max[sid] = ev.timestamp

    agents_by_provider: dict[str, set[str]] = defaultdict(set)
    agents_per_session: dict[str, set[str]] = defaultdict(set)
    deleg_by_provider: dict[str, int] = defaultdict(int)
    for iv in invs:
        agents_by_provider[iv.provider].add(iv.agent_name)
        deleg_by_provider[iv.provider] += 1
        if iv.session_id:
            agents_per_session[iv.session_id].add(iv.agent_name)

    execs = _build_executions(list(events), list(invs), {})
    ex_dur: dict[str, list[int]] = defaultdict(list)
    status_count: dict[str, dict[str, int]] = defaultdict(
        lambda: {"delegated": 0, "inline": 0, "read_only": 0}
    )
    ex_total: dict[str, int] = defaultdict(int)
    for ex in execs:
        prov = sess_provider.get(ex.session_id)
        if not prov:
            continue
        ex_total[prov] += 1
        if ex.duration_s is not None:
            ex_dur[prov].append(ex.duration_s)
        status_count[prov][ex.status] = status_count[prov].get(ex.status, 0) + 1

    providers_seen = sorted(set(events_by_provider) | set(sess_provider.values()))
    by: dict[str, ProviderInsight] = {}
    for prov in providers_seen:
        prov_sessions = [s for s, p in sess_provider.items() if p == prov]
        n = len(prov_sessions)
        durs = [
            (sess_max[s] - sess_min[s]).total_seconds()
            for s in prov_sessions
            if s in sess_min and s in sess_max
        ]
        per_sess = [len(agents_per_session.get(s, set())) for s in prov_sessions]
        exq = ex_total.get(prov, 0)
        sc = status_count.get(prov, {})

        def _pct(x: int) -> float:
            return round(100.0 * x / exq, 1) if exq else 0.0

        durex = ex_dur.get(prov, [])
        by[prov] = ProviderInsight(
            provider=prov,
            events=events_by_provider.get(prov, 0),
            sessions=n,
            executions=exq,
            distinct_agents=len(agents_by_provider.get(prov, set())),
            avg_agents_per_session=round(sum(per_sess) / n, 2) if n else 0.0,
            avg_session_duration_s=round(sum(durs) / len(durs), 1) if durs else 0.0,
            avg_execution_duration_s=round(sum(durex) / len(durex), 1) if durex else 0.0,
            delegations=deleg_by_provider.get(prov, 0),
            pct_delegated=_pct(sc.get("delegated", 0)),
            pct_inline=_pct(sc.get("inline", 0)),
            pct_read_only=_pct(sc.get("read_only", 0)),
        )

    # Solo claude/copilot van en la tabla comparativa (los dos principales).
    def _v(prov: str, attr: str) -> float | None:
        pi = by.get(prov)
        return getattr(pi, attr) if pi else None

    comparative = [
        ComparativeRow(metric="Sessions", claude=_v("claude", "sessions"), copilot=_v("copilot", "sessions")),
        ComparativeRow(metric="Executions", claude=_v("claude", "executions"), copilot=_v("copilot", "executions")),
        ComparativeRow(metric="Delegations", claude=_v("claude", "delegations"), copilot=_v("copilot", "delegations")),
        ComparativeRow(metric="Distinct agents", claude=_v("claude", "distinct_agents"), copilot=_v("copilot", "distinct_agents")),
        ComparativeRow(metric="Avg agents / session", claude=_v("claude", "avg_agents_per_session"), copilot=_v("copilot", "avg_agents_per_session")),
        ComparativeRow(metric="Avg session duration", unit="s", claude=_v("claude", "avg_session_duration_s"), copilot=_v("copilot", "avg_session_duration_s")),
        ComparativeRow(metric="Avg execution duration", unit="s", claude=_v("claude", "avg_execution_duration_s"), copilot=_v("copilot", "avg_execution_duration_s")),
        ComparativeRow(metric="% delegated", unit="%", claude=_v("claude", "pct_delegated"), copilot=_v("copilot", "pct_delegated")),
        ComparativeRow(metric="% inline", unit="%", claude=_v("claude", "pct_inline"), copilot=_v("copilot", "pct_inline")),
        ComparativeRow(metric="% read-only", unit="%", claude=_v("claude", "pct_read_only"), copilot=_v("copilot", "pct_read_only")),
    ]

    return RuntimeInsights(
        providers=[by[p] for p in providers_seen],
        comparative=comparative,
        insights=_gen_insights(by),
    )


# ───────────────────── /runtime/invoked-agents ─────────────────────


@router.get("/invoked-agents", response_model=list[InvokedAgent])
def invoked_agents(
    project_id: UUID | None = None,
    limit: int = Query(30, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[InvokedAgent]:
    """Agentes que efectivamente intervinieron, derivado de las delegaciones
    reales (AgentInvocation: runSubagent/Task). Esta es la respuesta correcta a
    "qué agentes intervienen" — sin los falsos positivos del match de texto."""
    stmt = select(
        AgentInvocation.agent_id,
        AgentInvocation.agent_name,
        func.count(AgentInvocation.id),
        func.count(func.distinct(AgentInvocation.session_id)),
        func.max(AgentInvocation.timestamp),
    ).group_by(AgentInvocation.agent_id, AgentInvocation.agent_name)
    if project_id:
        stmt = stmt.where(AgentInvocation.project_id == project_id)
    stmt = stmt.order_by(func.count(AgentInvocation.id).desc()).limit(limit)
    rows = session.exec(stmt).all()
    if not rows:
        return []

    # Providers por (agent_id, agent_name).
    prov_stmt = select(
        AgentInvocation.agent_name, AgentInvocation.provider
    ).distinct()
    if project_id:
        prov_stmt = prov_stmt.where(AgentInvocation.project_id == project_id)
    providers_by_name: dict[str, set[str]] = {}
    for name, prov in session.exec(prov_stmt).all():
        providers_by_name.setdefault(name, set()).add(prov)

    return [
        InvokedAgent(
            agent_id=aid,
            agent_name=name,
            declared=aid is not None,
            invocations=int(count),
            sessions=int(sessions),
            providers=sorted(providers_by_name.get(name, set())),
            last_invoked_at=last,
        )
        for aid, name, count, sessions, last in rows
    ]


# ── Extracción de CLAIMS (self-reported) del result del agente ──
# Convenience visual: parsea files/validaciones del texto. NO es evidencia.
# Conservador: solo emite una validación cuando hay keyword + verdict claro.

_FILE_RE = re.compile(r"`?([A-Za-z0-9_][A-Za-z0-9_./-]*/[A-Za-z0-9_./-]+\.[A-Za-z]{1,6})(?::\d[\d-]*)?`?")
_CHECK_KEYS = [
    ("typecheck", ("typecheck", "type-check", "tsc")),
    ("tests", ("test",)),
    ("lint", ("lint",)),
    ("contract", ("contract", "contrato")),
    ("scope", ("scope", "alcance")),
    ("traceability", ("trazabilidad", "traceability")),
    ("build", ("build", "compil")),
]
_POS_RE = re.compile(r"(?:\bpass(?:ed|es)?\b|\bok\b|\bclean\b|\bgreen\b|respect|✓|✅|\bsuccess)", re.I)
_NEG_RE = re.compile(r"(?:\bfail(?:ed|s)?\b|violat|forbidden|missing|✗|❌|\bred\b|broke|\berror)", re.I)
_VERDICT_RE = re.compile(r"verdict[:\s*]+\**\s*(pass|fail|green|red|approved|rejected|blocked)", re.I)


def _extract_claims(text: str | None) -> AgentClaims:
    if not text or not text.strip():
        return AgentClaims()
    # Files: paths con / y extensión. Dedup, cap 25.
    files: list[str] = []
    seen: set[str] = set()
    for m in _FILE_RE.finditer(text):
        p = m.group(1)
        if p in seen or p.startswith(("http", "www.")):
            continue
        seen.add(p)
        files.append(p)
        if len(files) >= 25:
            break

    validations: list[ClaimValidation] = []
    labels_seen: dict[str, str] = {}
    mv = _VERDICT_RE.search(text)
    if mv:
        g = mv.group(1).lower()
        labels_seen["verdict"] = "pass" if g in ("pass", "green", "approved") else "fail"

    for raw in text.splitlines():
        line = raw.strip()
        if not line or len(line) > 220:
            continue
        low = line.lower()
        for label, keys in _CHECK_KEYS:
            if label in labels_seen:
                continue
            if not any(k in low for k in keys):
                continue
            pos, neg = bool(_POS_RE.search(line)), bool(_NEG_RE.search(line))
            if pos and not neg:
                labels_seen[label] = "pass"
            elif neg and not pos:
                labels_seen[label] = "fail"
            # ambiguo (ambos o ninguno) → se ignora

    # verdict primero, luego el resto en orden estable
    order = ["verdict", "tests", "typecheck", "lint", "contract", "scope", "traceability", "build"]
    for lbl in order:
        if lbl in labels_seen:
            validations.append(ClaimValidation(label=lbl, status=labels_seen[lbl]))

    return AgentClaims(files=files, validations=validations)


@router.get("/invocations", response_model=list[AgentInvocationRow])
def list_invocations(
    project_id: UUID | None = None,
    agent_name: str | None = Query(None, description="Filtra por agentName delegado."),
    session_id: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[AgentInvocationRow]:
    """Lista de delegaciones reales, más recientes primero."""
    stmt = select(AgentInvocation)
    if project_id:
        stmt = stmt.where(AgentInvocation.project_id == project_id)
    if agent_name:
        stmt = stmt.where(AgentInvocation.agent_name == agent_name)
    if session_id:
        stmt = stmt.where(AgentInvocation.session_id == session_id)
    stmt = stmt.order_by(AgentInvocation.timestamp.desc()).limit(limit)  # type: ignore[attr-defined]
    rows = session.exec(stmt).all()
    return [
        AgentInvocationRow(
            id=r.id,
            agent_id=r.agent_id,
            agent_name=r.agent_name,
            declared=r.agent_id is not None,
            provider=r.provider,
            tool=r.tool,
            session_id=r.session_id,
            request_id=r.request_id,
            runtime_event_id=r.runtime_event_id,
            description=r.description,
            model=r.model,
            prompt_chars=r.prompt_chars,
            result_chars=r.result_chars,
            order_index=r.order_index,
            timestamp=r.timestamp,
            sanitized_prompt=r.sanitized_prompt,
            sanitized_result=r.sanitized_result,
            claims=_extract_claims(r.sanitized_result) if r.sanitized_result else None,
        )
        for r in rows
    ]


# ───────────────────── /runtime/collector/run ─────────────────────


@router.post("/collector/run", response_model=list[CollectorRunResult])
def collector_run_now(
    provider: str | None = Query(None, description="Si se especifica, corre solo ese provider."),
) -> list[CollectorRunResult]:
    """Trigger manual del collector — útil para forzar un tick desde la UI
    cuando se acaban de cambiar paths o flags."""
    if provider:
        adapter_names = [provider]
    else:
        adapter_names = list(available_adapters().keys())

    out: list[CollectorRunResult] = []
    for name in adapter_names:
        if provider is None:
            # Para corridas globales respetamos el flag enabled
            stats = runtime_collector.run_once().get(name)
            if stats is None:
                continue
        else:
            stats = runtime_collector.run_once_for(name)
            if stats is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Provider '{name}' no disponible o sin path configurado",
                )
        out.append(
            CollectorRunResult(
                provider=name,
                files_seen=stats.files_seen,
                events_inserted=stats.events_inserted,
                skipped=stats.skipped,
                errors=stats.errors,
            )
        )
    return out
