"""Sessions: list + replay timeline + agent co-occurrence graph.

Construye la narrativa real del proceso agéntico a partir de runtime_events
agrupados por `event_metadata->>'session_id'`.
"""
import re
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import BigInteger, desc, func
from sqlmodel import Session, select

from app.db import get_session
from app.services.turn_reader import read_session_previews, read_turn_text
from app.models import Agent, AgentInvocation, AgentMention, Project, RuntimeEvent

router = APIRouter(tags=["sessions"])


# ───────────────────── Schemas ─────────────────────


class SessionSummary(BaseModel):
    session_id: str
    provider: str
    project_id: UUID | None
    events: int
    started_at: datetime
    ended_at: datetime
    duration_seconds: int
    distinct_agents: int
    distinct_files: int
    models: list[str]
    turns: int = 0
    tokens_input: int = 0
    tokens_output: int = 0


class SessionTokens(BaseModel):
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_creation: int = 0

    @property
    def total(self) -> int:
        return self.input + self.output


class SessionEvent(BaseModel):
    id: UUID
    timestamp: datetime
    event_type: str
    provider: str
    model: str | None
    agent_mentions: list[str]
    files_touched: list[str]
    error: str | None
    tokens_input: int | None = None
    tokens_output: int | None = None
    request_id: str | None = None  # para fetch on-demand del texto (Fase B)
    turn_id: str | None = None  # turno real (Claude); linkea con invocation.request_id
    prompt_preview: str | None = None  # primeros chars del prompt (solo user turns)


class SessionReplay(BaseModel):
    session_id: str
    provider: str
    project_id: UUID | None
    started_at: datetime
    ended_at: datetime
    events_total: int
    turns: int
    agents_in_order: list[str]
    models: list[str]
    tokens: SessionTokens
    events: list[SessionEvent]


class AgentGraphNode(BaseModel):
    # id = agent_name delegado (la delegación viaja por nombre; agent_id puede
    # ser None para built-ins como Explore). Stable como clave del grafo.
    id: str
    name: str
    type: str
    runtime_count: int  # cantidad de delegaciones reales (runSubagent/Agent)
    sessions: int       # cantidad de sesiones distintas donde fue delegado
    declared: bool = True   # mapea a un agente declarado del repo
    with_result: int = 0    # delegaciones con result (output) no vacío


class AgentGraphEdge(BaseModel):
    source: str
    target: str
    sessions: int       # sesiones donde co-fueron-delegados


class AgentGraph(BaseModel):
    nodes: list[AgentGraphNode]
    edges: list[AgentGraphEdge]


# ───────────────────── /projects/:id/sessions ─────────────────────


@router.get("/api/projects/{project_id}/sessions", response_model=list[SessionSummary])
def list_sessions(
    project_id: UUID,
    limit: int = Query(40, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[SessionSummary]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]
    model_expr = RuntimeEvent.event_metadata["model"].astext  # type: ignore[attr-defined]
    file_expr = RuntimeEvent.event_metadata["file"].astext  # type: ignore[attr-defined]
    # Tokens reales (Claude). Cast a int del JSONB; null si no existe.
    in_tok = func.coalesce(
        RuntimeEvent.event_metadata["usage"]["input_tokens"].astext.cast(BigInteger), 0  # type: ignore[index]
    )
    out_tok = func.coalesce(
        RuntimeEvent.event_metadata["usage"]["output_tokens"].astext.cast(BigInteger), 0  # type: ignore[index]
    )
    # "turns" = turnos reales de usuario, NO mensajes assistant. Claude parte cada
    # tool_use en su propio mensaje assistant → contar assistants inflaba (28 vs 2).
    # Se cuenta la misma clave de turno que usa _build_executions (turn_id de Claude,
    # request_id de Copilot, external_id como último recurso) para que el header del
    # summary coincida con el panel de Ejecuciones.
    turn_key = func.coalesce(
        RuntimeEvent.event_metadata["turn_id"].astext,  # type: ignore[index]
        RuntimeEvent.event_metadata["request_id"].astext,  # type: ignore[index]
        RuntimeEvent.external_id,
    )
    turns_count = func.count(func.distinct(turn_key))

    rows = session.exec(
        select(
            sid_expr.label("sid"),
            RuntimeEvent.provider,
            func.count(RuntimeEvent.id).label("events"),
            func.min(RuntimeEvent.timestamp).label("start"),
            func.max(RuntimeEvent.timestamp).label("end"),
            func.count(func.distinct(file_expr)).label("files"),
            func.array_agg(func.distinct(model_expr)).label("models"),
            func.sum(in_tok).label("tok_in"),
            func.sum(out_tok).label("tok_out"),
            turns_count.label("turns"),
        )
        .where(RuntimeEvent.project_id == project_id, sid_expr.is_not(None))  # type: ignore[union-attr]
        .group_by(sid_expr, RuntimeEvent.provider)
        .order_by(desc("end"))
        .limit(limit)
    ).all()

    if not rows:
        return []

    sids = [r[0] for r in rows]
    # distinct_agents = agentes que REALMENTE intervinieron (delegación
    # runSubagent/Agent) por sesión, desde agent_invocations — NO menciones por
    # texto (que daban falsos positivos: 6 agentes "vistos" sin delegar nunca).
    agent_counts: dict[str, int] = {}
    if sids:
        inv_rows = session.exec(
            select(
                AgentInvocation.session_id,
                func.count(func.distinct(AgentInvocation.agent_name)),
            )
            .where(
                AgentInvocation.project_id == project_id,
                AgentInvocation.session_id.in_(sids),  # type: ignore[attr-defined]
            )
            .group_by(AgentInvocation.session_id)
        ).all()
        agent_counts = {sid: int(cnt) for sid, cnt in inv_rows}

    out: list[SessionSummary] = []
    for sid, provider, events, start, end, files, models, tok_in, tok_out, turns in rows:
        duration = int((end - start).total_seconds()) if start and end else 0
        clean_models = [m for m in (models or []) if m]
        out.append(
            SessionSummary(
                session_id=sid,
                provider=provider,
                project_id=project_id,
                events=int(events),
                started_at=start,
                ended_at=end,
                duration_seconds=duration,
                distinct_agents=int(agent_counts.get(sid, 0)),
                distinct_files=int(files or 0),
                models=clean_models,
                turns=int(turns or 0),
                tokens_input=int(tok_in or 0),
                tokens_output=int(tok_out or 0),
            )
        )
    return out


# ───────────────────── /sessions/:session_id ─────────────────────


@router.get("/api/sessions/{session_id}", response_model=SessionReplay)
def session_replay(
    session_id: str,
    limit: int = Query(500, ge=1, le=2000),
    session: Session = Depends(get_session),
) -> SessionReplay:
    sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]

    events = session.exec(
        select(RuntimeEvent)
        .where(sid_expr == session_id)
        .order_by(RuntimeEvent.timestamp.asc())  # type: ignore[attr-defined]
        .limit(limit)
    ).all()
    if not events:
        raise HTTPException(status_code=404, detail="Session not found or empty")

    # Mentions per session — file_path = <provider>://session/<sid>#<eid>
    from sqlalchemy import or_

    mention_rows = session.exec(
        select(AgentMention.file_path, AgentMention.agent_id).where(
            or_(
                AgentMention.file_path.like(f"claude://session/{session_id}#%"),  # type: ignore[attr-defined]
                AgentMention.file_path.like(f"copilot://session/{session_id}#%"),  # type: ignore[attr-defined]
            )
        )
    ).all()
    mentions_by_event: dict[str, list[UUID]] = {}
    for fp, aid in mention_rows:
        ext = fp.split("#", 1)[1] if "#" in fp else ""
        if ext:
            # Copilot mete sufijos :user/:assistant/:native — extraemos el req_id base
            ext = ext.split(":", 1)[0]
        if ext:
            mentions_by_event.setdefault(ext, []).append(aid)

    agent_ids = {aid for v in mentions_by_event.values() for aid in v}
    agent_map: dict[UUID, str] = {}
    if agent_ids:
        for a in session.exec(select(Agent.id, Agent.name).where(Agent.id.in_(agent_ids))).all():  # type: ignore[attr-defined]
            agent_map[a[0]] = a[1]

    # Previews del prompt — lee el archivo fuente UNA vez (best-effort, sin
    # persistir). Si falla (archivo no disponible) seguimos sin previews.
    try:
        previews = read_session_previews(list(events))
    except Exception:  # noqa: BLE001 — el replay no debe romper por esto
        previews = {}

    timeline: list[SessionEvent] = []
    tokens = SessionTokens()
    models_seen: list[str] = []
    # "turns" = turnos reales (misma clave que _build_executions), no mensajes
    # assistant: Claude parte cada tool_use en su propio assistant → inflaba.
    turn_keys: set[str] = set()
    for ev in events:
        meta: dict[str, Any] = ev.event_metadata or {}
        turn_keys.add(
            meta.get("turn_id") or meta.get("request_id") or ev.external_id or ""
        )
        # La clave de lookup difiere por provider:
        #   Claude:  external_id == uuid del jsonl == sufijo del file_path
        #   Copilot: external_id = "copilot:chat:user:<request_id>" pero el
        #            file_path del mention usa `request_id` solo.
        #            Usamos meta.request_id como key universal.
        lookup_key = meta.get("request_id") if isinstance(meta, dict) else None
        if not lookup_key:
            lookup_key = ev.external_id or ""
        # Menciones por texto — solo para el timeline CRUDO (señal débil,
        # NO se usan para "agentes que intervinieron").
        names = []
        for aid in mentions_by_event.get(lookup_key, []):
            n = agent_map.get(aid)
            if n:
                names.append(n)
        files = list(meta.get("files_touched") or [])
        f = meta.get("file")
        if f and f not in files:
            files.append(f)

        model = meta.get("model") if isinstance(meta, dict) else None
        if model and model not in models_seen:
            models_seen.append(model)

        # Tokens del usage (Claude). Copilot no trae usage → None.
        ev_in = ev_out = None
        usage = meta.get("usage") if isinstance(meta, dict) else None
        if isinstance(usage, dict):
            ev_in = usage.get("input_tokens")
            ev_out = usage.get("output_tokens")
            tokens.input += int(ev_in or 0)
            tokens.output += int(ev_out or 0)
            tokens.cache_read += int(usage.get("cache_read_input_tokens") or 0)
            tokens.cache_creation += int(usage.get("cache_creation_input_tokens") or 0)

        # Preview del prompt para user turns. Key: request_id (copilot) o
        # external_id (claude).
        preview = None
        if ev.event_type == "user":
            key = meta.get("request_id") if isinstance(meta, dict) else None
            preview = previews.get(key or ev.external_id or "")

        timeline.append(
            SessionEvent(
                id=ev.id,
                timestamp=ev.timestamp,
                event_type=ev.event_type,
                provider=ev.provider,
                model=model,
                agent_mentions=names,
                files_touched=files,
                error=ev.error_message,
                tokens_input=int(ev_in) if ev_in is not None else None,
                tokens_output=int(ev_out) if ev_out is not None else None,
                request_id=meta.get("request_id") if isinstance(meta, dict) else None,
                turn_id=meta.get("turn_id") if isinstance(meta, dict) else None,
                prompt_preview=preview,
            )
        )

    # "agents_in_order" = agentes que REALMENTE intervinieron (delegación
    # runSubagent/Agent), en orden, desde agent_invocations — NO menciones por
    # texto. Una sesión sin delegación real → lista vacía (sin chips engañosos).
    inv_rows = session.exec(
        select(AgentInvocation.agent_name)
        .where(AgentInvocation.session_id == session_id)
        .order_by(AgentInvocation.order_index, AgentInvocation.timestamp)  # type: ignore[arg-type]
    ).all()
    agents_in_order = list(dict.fromkeys(inv_rows))

    return SessionReplay(
        session_id=session_id,
        provider=events[0].provider,
        project_id=events[0].project_id,
        started_at=events[0].timestamp,
        ended_at=events[-1].timestamp,
        events_total=len(events),
        turns=len(turn_keys),
        agents_in_order=agents_in_order,
        models=models_seen,
        tokens=tokens,
        events=timeline,
    )


class TurnText(BaseModel):
    event_id: UUID
    provider: str
    event_type: str
    prompt: str | None = None
    response: str | None = None
    sanitized: bool = False
    truncated: bool = False
    error: str | None = None


@router.get("/api/sessions/events/{event_id}/text", response_model=TurnText)
def turn_text(event_id: UUID, session: Session = Depends(get_session)) -> TurnText:
    """Lee el texto (prompt/response) de un turn on-demand desde el archivo
    fuente. NO persiste — sanitizado al vuelo. Respeta privacy_mode."""
    ev = session.get(RuntimeEvent, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="Event not found")
    result = read_turn_text(ev)
    return TurnText(
        event_id=event_id,
        provider=ev.provider,
        event_type=ev.event_type,
        prompt=result.get("prompt"),
        response=result.get("response"),
        sanitized=result.get("sanitized", False),
        truncated=result.get("truncated", False),
        error=result.get("error"),
    )


# ───────────────────── /projects/:id/agent-graph ─────────────────────


@router.get("/api/projects/{project_id}/agent-graph", response_model=AgentGraph)
def agent_graph(
    project_id: UUID, session: Session = Depends(get_session)
) -> AgentGraph:
    """Grafo de co-DELEGACIÓN REAL entre agentes en la misma sesión.

    Se construye desde `agent_invocations` (la señal estructural de intervención:
    `runSubagent` en Copilot / `Agent` en Claude), NO desde `agent_mentions`
    (nombre del agente en el texto = señal débil con falsos positivos). Un par
    (A, B) está conectado si AMBOS fueron delegados dentro de la misma sesión.

    Consecuencia buscada: un proyecto donde nadie delegó de verdad da grafo
    vacío aunque sus 6 agentes aparezcan mencionados por texto.
    """
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    rows = session.exec(
        select(
            AgentInvocation.agent_name,
            AgentInvocation.session_id,
            AgentInvocation.agent_id,
            AgentInvocation.result_chars,
        ).where(
            AgentInvocation.project_id == project_id,
            AgentInvocation.session_id.is_not(None),  # type: ignore[union-attr]
        )
    ).all()

    if not rows:
        return AgentGraph(nodes=[], edges=[])

    # Nodo identificado por agent_name (la delegación viaja por nombre).
    sessions_per_agent: dict[str, set[str]] = {}
    counts: dict[str, int] = {}
    with_result: dict[str, int] = {}
    declared_ids: dict[str, UUID] = {}  # agent_name → agent_id (si declarado)
    for name, sid, aid, rchars in rows:
        sessions_per_agent.setdefault(name, set()).add(sid)
        counts[name] = counts.get(name, 0) + 1
        if rchars and rchars > 0:
            with_result[name] = with_result.get(name, 0) + 1
        if aid is not None:
            declared_ids[name] = aid

    # type de los agentes declarados (los no declarados quedan "external").
    agent_types: dict[UUID, str] = {}
    if declared_ids:
        agent_types = {
            a.id: a.type
            for a in session.exec(
                select(Agent).where(Agent.id.in_(list(declared_ids.values())))  # type: ignore[attr-defined]
            ).all()
        }

    nodes = [
        AgentGraphNode(
            id=name,
            name=name,
            type=agent_types.get(declared_ids.get(name), "external")  # type: ignore[arg-type]
            if name in declared_ids
            else "external",
            runtime_count=counts[name],
            sessions=len(sids),
            declared=name in declared_ids,
            with_result=with_result.get(name, 0),
        )
        for name, sids in sessions_per_agent.items()
    ]

    # Edges: para cada par, |intersect(sessions)|. Solo guardamos si ≥ 1.
    names = list(sessions_per_agent.keys())
    edges: list[AgentGraphEdge] = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            shared = sessions_per_agent[a] & sessions_per_agent[b]
            if shared:
                edges.append(
                    AgentGraphEdge(source=a, target=b, sessions=len(shared))
                )
    edges.sort(key=lambda e: -e.sessions)
    return AgentGraph(nodes=nodes, edges=edges)


# ───────────────────── Ejecuciones (subdivisión de la sesión) ─────────────────────
# Una "ejecución" = un turno (prompt del usuario → trabajo del agente → fin),
# etiquetado por la tarea que menciona. Divide la sesión gigante en unidades
# navegables por tarea.

_TASK_REF_RE = re.compile(r"\b(T\d{2,}[a-z]?|HU-\d+-[A-Z]+)\b")
_EDIT_TOOLS = {
    # Copilot
    "copilot_replaceString",
    "copilot_multiReplaceString",
    "copilot_createFile",
    "copilot_applyPatch",
    # Claude Code (ver _CLAUDE_EDIT_TOOLS en services/claude_logs.py)
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
}


def _infer_task_ref(text: str | None) -> str | None:
    if not text:
        return None
    m = _TASK_REF_RE.search(text)
    return m.group(1).upper() if m else None


class ExecDelegation(BaseModel):
    agent_name: str
    declared: bool
    result_chars: int
    description: str | None


class ExecutionRead(BaseModel):
    session_id: str
    request_id: str | None
    index: int
    task_ref: str | None
    label: str | None
    model: str | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_s: int | None
    delegations: list[ExecDelegation]
    delegated_agents: list[str]
    tool_calls: int
    edits: int
    files_touched: list[str]
    status: str  # delegated | inline | read_only


def _build_executions(
    events: list[RuntimeEvent],
    invs: list[AgentInvocation],
    previews: dict[str, str],
) -> list[ExecutionRead]:
    """Agrupa eventos por (session_id, request_id) → una ejecución por turno."""
    # invocaciones por (session_id, request_id)
    invs_by_key: dict[tuple, list[AgentInvocation]] = {}
    for iv in invs:
        invs_by_key.setdefault((iv.session_id, iv.request_id), []).append(iv)

    groups: dict[tuple, list[RuntimeEvent]] = {}
    order: list[tuple] = []
    for ev in events:
        meta = ev.event_metadata or {}
        sid = meta.get("session_id") or ""
        # turn_id agrupa por turno de usuario (Claude); Copilot no lo trae y cae
        # a request_id (= su turno). Así una "ejecución" = un turno en ambos.
        req = meta.get("turn_id") or meta.get("request_id") or ev.external_id or ""
        key = (sid, req)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(ev)

    out: list[ExecutionRead] = []
    per_session_idx: dict[str, int] = {}
    for key in order:
        sid, req = key
        evs = groups[key]
        user_ev = next((e for e in evs if e.event_type == "user"), None)
        asst_evs = [e for e in evs if e.event_type == "assistant"]
        asst_ev = asst_evs[0] if asst_evs else None
        ameta = (asst_ev.event_metadata or {}) if asst_ev else {}
        prompt = previews.get(req) if previews else None

        evs_invs = invs_by_key.get(key, [])

        # Agregamos metadata de TODOS los assistant del turno: Claude parte cada
        # tool en su propio mensaje, Copilot trae todo en uno → equivalente.
        edits = tool_calls = 0
        files: list[str] = []
        delegated: list[str] = []
        model: str | None = None
        task_ids: list = []
        for ae in asst_evs:
            am = ae.event_metadata or {}
            d = am.get("tool_calls_detail") or []
            edits += sum(1 for x in d if isinstance(x, dict) and x.get("tool") in _EDIT_TOOLS)
            tool_calls += len(am.get("tool_calls") or [])
            files.extend(am.get("files_touched") or [])
            delegated.extend(am.get("delegated_agents") or [])
            if model is None and am.get("model"):
                model = am.get("model")
            if not task_ids:
                task_ids = (am.get("inference") or {}).get("task_ids") or []
        # dedup preservando orden
        files = list(dict.fromkeys(files))
        delegated = list(dict.fromkeys(delegated))
        if not delegated and evs_invs:
            delegated = [iv.agent_name for iv in evs_invs]

        # Cascada de task_ref: prompt → description de la 1ra delegación → inferidos.
        ref = _infer_task_ref(prompt)
        if not ref and evs_invs:
            ref = _infer_task_ref(evs_invs[0].description)
        if not ref and task_ids:
            ref = str(task_ids[0]).upper()

        started = user_ev.timestamp if user_ev else (asst_ev.timestamp if asst_ev else None)
        ended = asst_evs[-1].timestamp if asst_evs else started
        dur = int((ended - started).total_seconds()) if started and ended else None

        status = "delegated" if evs_invs else ("inline" if edits > 0 else "read_only")
        idx = per_session_idx.get(sid, 0) + 1
        per_session_idx[sid] = idx

        out.append(
            ExecutionRead(
                session_id=sid,
                request_id=req or None,
                index=idx,
                task_ref=ref,
                label=(prompt[:90] if prompt else (ref or None)),
                model=model or ameta.get("model"),
                started_at=started,
                ended_at=ended,
                duration_s=dur,
                delegations=[
                    ExecDelegation(
                        agent_name=iv.agent_name,
                        declared=iv.agent_id is not None,
                        result_chars=iv.result_chars or 0,
                        description=iv.description,
                    )
                    for iv in sorted(evs_invs, key=lambda x: x.order_index)
                ],
                delegated_agents=delegated,
                tool_calls=tool_calls,
                edits=edits,
                files_touched=files[:50],
                status=status,
            )
        )
    return out


@router.get("/api/sessions/{session_id}/executions", response_model=list[ExecutionRead])
def session_executions(
    session_id: str, session: Session = Depends(get_session)
) -> list[ExecutionRead]:
    """Ejecuciones (turnos) de UNA sesión, con prompt real."""
    sid_expr = RuntimeEvent.event_metadata["session_id"].astext  # type: ignore[attr-defined]
    events = session.exec(
        select(RuntimeEvent)
        .where(sid_expr == session_id)
        .order_by(RuntimeEvent.timestamp.asc())  # type: ignore[attr-defined]
    ).all()
    if not events:
        return []
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.session_id == session_id)
    ).all()
    try:
        previews = read_session_previews(list(events))
    except Exception:  # noqa: BLE001
        previews = {}
    return _build_executions(list(events), list(invs), previews)


@router.get("/api/projects/{project_id}/executions", response_model=list[ExecutionRead])
def project_executions(
    project_id: UUID,
    limit: int = Query(150, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[ExecutionRead]:
    """Ejecuciones de TODO el proyecto (lista plana por tarea/fecha). Sin leer
    archivos (label = task_ref); para el prompt completo, abrir la sesión."""
    events = session.exec(
        select(RuntimeEvent)
        .where(RuntimeEvent.project_id == project_id)
        .where(RuntimeEvent.event_type.in_(["user", "assistant"]))  # type: ignore[attr-defined]
        .order_by(RuntimeEvent.timestamp.desc())  # type: ignore[attr-defined]
        .limit(2000)
    ).all()
    if not events:
        return []
    invs = session.exec(
        select(AgentInvocation).where(AgentInvocation.project_id == project_id)
    ).all()
    execs = _build_executions(list(reversed(events)), list(invs), {})
    execs.sort(key=lambda e: (e.started_at or datetime.min), reverse=True)
    return execs[:limit]
