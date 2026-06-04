"""Ingest local Claude Code session logs.

Claude Code persists every conversational turn as one JSON line under
`~/.claude/projects/<encoded-path>/<session>.jsonl`. The schema is informal but
each line usually carries:

  - `uuid` — message id (idempotency key)
  - `sessionId` — conversation id
  - `type` — "user" | "assistant" | "tool_use" | "tool_result" | "summary" | ...
  - `timestamp` — ISO8601
  - `message.model` — model name (only on assistant)
  - `message.usage` — `{ input_tokens, output_tokens, ... }`
  - `cwd` — working directory the session ran on
  - `requestId`, `parentUuid`, etc.

We collapse anything unknown into the JSONB `event_metadata` so future fields
keep working without schema changes.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from uuid import UUID

from sqlalchemy import delete as sql_delete, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Agent,
    AgentInvocation,
    AgentMention,
    LlmInteraction,
    Project,
    RuntimeEvent,
)
from app.services.runtime.inference import enrich_metadata
from app.services.sanitizer import estimate_chars, sanitize


PROVIDER = "claude"

# Tools de delegación de Claude Code: el sub-agente que efectivamente corre por
# orden del agente padre. El nombre cambió entre versiones (`Task` → `Agent`);
# soportamos ambos. El sub-agente delegado viaja en `input.subagent_type`.
_DELEGATION_TOOLS = ("Agent", "Task")

# Tools de Claude Code que escriben/crean archivos. Análogo a los copilot_* del
# visor de Ejecuciones; mantener en sync con _EDIT_TOOLS en api/sessions.py.
_CLAUDE_EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# Tope de detalle por turno (igual criterio que el adapter de Copilot).
_MAX_TOOL_DETAIL = 300


@dataclass
class IngestStats:
    files_seen: int = 0
    lines_seen: int = 0
    events_inserted: int = 0
    interactions_inserted: int = 0
    mentions_inserted: int = 0
    invocations_inserted: int = 0
    skipped: int = 0


@dataclass
class _AgentPattern:
    agent_id: UUID
    project_id: UUID
    name: str
    pattern: re.Pattern[str]


def _extract_text(message: Any) -> str:
    """Best-effort text extraction from a Claude message payload.

    Claude Code messages can be a string, a list of blocks (text/tool_use/tool_result),
    or a dict already. We only persist the plain text portions — tool args / outputs
    stay opaque to keep the surface minimal.
    """
    if message is None:
        return ""
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        content = message.get("content")
        if content is not None:
            return _extract_text(content)
        return ""
    if isinstance(message, list):
        parts: list[str] = []
        for block in message:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                btype = block.get("type")
                if btype == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif btype == "tool_result":
                    inner = block.get("content")
                    if isinstance(inner, str):
                        parts.append(inner)
                    elif isinstance(inner, list):
                        parts.append(_extract_text(inner))
                # tool_use we skip — args may include paths/keys.
        return "\n".join(parts)
    return ""


def _agent_name_map(session: Session) -> dict[UUID, dict[str, Any]]:
    """project_id → {"by_key": {nombre normalizado: agent_id}, "by_id": {agent_id:
    nombre display}}. by_key incluye la variante sin sufijo `.agent`, para resolver
    el `subagent_type` delegado a un agente declarado. by_id permite mostrar el
    nombre del rol resuelto. Análogo a copilot_storage_adapter._agents_by_name."""
    out: dict[UUID, dict[str, Any]] = {}
    for a in session.exec(select(Agent)).all():
        proj = out.setdefault(a.project_id, {"by_key": {}, "by_id": {}})
        display = a.name.replace(".agent", "")
        proj["by_id"][a.id] = display
        for variant in (a.name, display):
            proj["by_key"][variant.lower()] = a.id
    return out


def _resolve_agent_id(by_key: dict[str, UUID], agent_name: str) -> UUID | None:
    """Resuelve un subagent_type delegado a un agente declarado. None si no está
    declarado en el repo (p.ej. built-ins 'Explore', 'general-purpose')."""
    if not agent_name:
        return None
    key = agent_name.lower()
    return by_key.get(key) or by_key.get(key.replace(".agent", ""))


def _resolve_from_description(
    by_key: dict[str, UUID], by_id: dict[UUID, str], description: str | None
) -> tuple[UUID | None, str | None]:
    """Cuando el subagent_type es un built-in (general-purpose/Explore) y NO mapea
    a un agente declarado, intenta resolver el ROL desde la `description` de la
    delegación — un campo ESTRUCTURADO de la tool Agent (no prosa suelta).

    Claude Code no carga los `.github/agents/*.agent.md`: el orchestrator delega a
    `general-purpose` y nombra el rol en la description (p.ej. "Architect: ...",
    "Backend: ...", "Frontend: ..."). Tomamos el token antes del primer ":" y lo
    matcheamos contra los agentes declarados (exacto / prefijo / primera palabra).
    Conservador: solo devuelve match si es ÚNICO. Devuelve (agent_id, display)."""
    if not isinstance(description, str) or not description.strip():
        return None, None
    head = description.split(":", 1)[0].strip().lower()
    if not head or len(head) < 3:
        return None, None
    # match exacto primero
    aid = by_key.get(head)
    if aid is not None:
        return aid, by_id.get(aid)
    cands: set[UUID] = set()
    for key, kid in by_key.items():
        if key.endswith(".agent"):
            continue
        if key.startswith(head) or head.startswith(key) or key.split("-", 1)[0] == head:
            cands.add(kid)
    if len(cands) == 1:
        aid = next(iter(cands))
        return aid, by_id.get(aid)
    return None, None


def _result_text(content: Any) -> str:
    """Texto de un tool_result. El content puede ser str o lista de bloques."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return _extract_text(content)
    return ""


def _index_tool_results(objs: list[dict]) -> dict[str, str]:
    """tool_use_id → texto del tool_result. Los results de las delegaciones
    llegan en una línea `user` POSTERIOR a la del tool_use, por eso pre-indexamos
    el archivo entero antes de extraer las invocaciones."""
    out: dict[str, str] = {}
    for obj in objs:
        message = obj.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tuid = block.get("tool_use_id")
            if isinstance(tuid, str) and tuid:
                out[tuid] = _result_text(block.get("content"))
    return out


def _extract_agent_invocations(content: Any, results_by_id: dict[str, str]) -> list[dict]:
    """Delegaciones reales: bloques `tool_use` con name ∈ _DELEGATION_TOOLS.
    Cada una nombra el `subagent_type` que efectivamente se ejecutó por orden
    del agente padre. Es el análogo exacto del `runSubagent` de Copilot
    (ver copilot_storage_adapter._extract_subagent_invocations).

    El tool_use.id (`toolu_…`) es único y estable → idempotencia por él. No hay
    placeholders duplicados como en Copilot, así que no hace falta dedup."""
    if not isinstance(content, list):
        return []
    out: list[dict] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        if block.get("name") not in _DELEGATION_TOOLS:
            continue
        inp = block.get("input") or {}
        agent_name = inp.get("subagent_type")
        if not isinstance(agent_name, str) or not agent_name.strip():
            continue
        tuid = block.get("id")
        if not isinstance(tuid, str) or not tuid:
            continue
        out.append(
            {
                "tool_use_id": tuid,
                "agent_name": agent_name.strip(),
                "tool": block.get("name") or "Agent",
                "description": inp.get("description"),
                "prompt": inp.get("prompt"),
                "result": results_by_id.get(tuid),
                "order": len(out),
            }
        )
    return out


def _is_user_prompt(obj: dict) -> bool:
    """¿Es un prompt REAL del usuario (inicio de turno), no un tool_result?

    En Claude Code los resultados de tools llegan como `type=user` con content
    = lista de bloques `tool_result`. Un prompt real es un `type=user` cuyo
    content es texto (string) o una lista SIN bloques tool_result."""
    if obj.get("type") != "user":
        return False
    msg = obj.get("message") or {}
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        )
    return False


def _assign_turns(objs: list[dict]) -> dict[str, str]:
    """uuid del evento → turn_id (uuid del prompt de usuario que abrió el turno).

    Un turno = desde un prompt real del usuario hasta el siguiente. Resuelve la
    sobre-fragmentación: en Claude cada tool_use es su propio mensaje assistant
    con requestId propio, así que agrupar por requestId partiría un turno en
    decenas de 'ejecuciones'. Agrupamos por turno como hace Copilot por request."""
    turn_by_uuid: dict[str, str] = {}
    current: str | None = None
    for o in objs:
        uid = o.get("uuid")
        if not isinstance(uid, str):
            continue
        if _is_user_prompt(o):
            current = uid
        if current is not None:
            turn_by_uuid[uid] = current
    return turn_by_uuid


def _summarize_claude_tools(content: Any) -> tuple[list[str], list[dict], list[str]]:
    """Resumen de los tool_use de un turno assistant de Claude, con la MISMA
    forma que produce el adapter de Copilot (`_summarize_tool_calls`) para que
    el visor de Ejecuciones funcione idéntico en ambos providers.

    Devuelve (tool_calls [nombres], tool_calls_detail [dicts], files_touched).
    """
    tool_calls: list[str] = []
    detail: list[dict] = []
    files: list[str] = []
    if not isinstance(content, list):
        return tool_calls, detail, files

    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = block.get("name")
        if not isinstance(name, str) or not name:
            continue
        tool_calls.append(name)
        if len(detail) >= _MAX_TOOL_DETAIL:
            continue
        inp = block.get("input") if isinstance(block.get("input"), dict) else {}
        entry: dict[str, Any] = {"tool": name, "complete": True}

        if name == "Bash":
            cmd = inp.get("command")
            if isinstance(cmd, str) and cmd.strip():
                entry["command"] = sanitize(cmd.strip())[:500]
            entry["label"] = inp.get("description")
        elif name in _CLAUDE_EDIT_TOOLS:
            fp = inp.get("file_path") or inp.get("notebook_path")
            if isinstance(fp, str) and fp:
                entry["files"] = [fp]
                files.append(fp)
        elif name in _DELEGATION_TOOLS:
            st = inp.get("subagent_type")
            if isinstance(st, str) and st:
                entry["agent"] = st
        elif name in ("Read", "Glob", "Grep"):
            fp = inp.get("file_path") or inp.get("path") or inp.get("pattern")
            if isinstance(fp, str) and fp:
                entry["label"] = fp[:200]
        elif name == "TodoWrite":
            todos = inp.get("todos")
            if isinstance(todos, list):
                entry["todos"] = [
                    {"title": t.get("content") or t.get("title"), "status": t.get("status")}
                    for t in todos
                    if isinstance(t, dict)
                ][:30]
        detail.append(entry)

    # dedup files preservando orden
    seen: set[str] = set()
    files = [f for f in files if not (f in seen or seen.add(f))]
    return tool_calls, detail, files


def _build_agent_patterns(session: Session) -> dict[UUID, list[_AgentPattern]]:
    """Compile a regex per agent name, grouped by project."""
    by_project: dict[UUID, list[_AgentPattern]] = {}
    for agent in session.exec(select(Agent)).all():
        base = agent.name.replace(".agent", "")
        if len(base) < 3:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(base)}(?![A-Za-z0-9_])")
        by_project.setdefault(agent.project_id, []).append(
            _AgentPattern(
                agent_id=agent.id,
                project_id=agent.project_id,
                name=agent.name,
                pattern=pattern,
            )
        )
    return by_project


def _persist_invocations(
    *,
    session: Session,
    project_id: UUID,
    agents: dict[str, Any],
    invocations: list[dict],
    session_id: str | None,
    request_id: str | None,
    runtime_event_id: UUID | None,
    timestamp: datetime,
    stats: IngestStats,
) -> None:
    """Persiste delegaciones reales del Task/Agent tool. Idempotente por
    (provider, external_id) con external_id = claude:subagent:<tool_use_id>
    (tool_use.id es único y estable). prompt/result solo si privacy lo permite."""
    keep_payload = settings.privacy_mode in ("sanitized_payload", "raw_local_only")
    by_key: dict[str, UUID] = agents.get("by_key", {})
    by_id: dict[UUID, str] = agents.get("by_id", {})
    for iv in invocations:
        tuid = iv["tool_use_id"]
        external_id = f"claude:subagent:{tuid}"
        prompt = iv.get("prompt") if isinstance(iv.get("prompt"), str) else None
        result = iv.get("result") if isinstance(iv.get("result"), str) else None
        desc = iv.get("description")
        # 1) intentar por subagent_type (Copilot trae el nombre declarado; Claude
        #    suele traer un built-in 'general-purpose' que NO mapea).
        # 2) si no mapeó, resolver el ROL desde la description estructurada de la
        #    delegación (Claude pone "Architect:", "Backend:", ... ahí). Si matchea
        #    un agente declarado, usamos ese nombre+id (declared:true) para que el
        #    grafo/flujo/chips muestren el rol y no 'general-purpose'.
        agent_id = _resolve_agent_id(by_key, iv["agent_name"])
        agent_name = iv["agent_name"]
        if agent_id is None:
            rid, rname = _resolve_from_description(by_key, by_id, desc)
            if rid is not None and rname:
                agent_id, agent_name = rid, rname
        stmt = (
            pg_insert(AgentInvocation.__table__)
            .values(
                project_id=project_id,
                agent_id=agent_id,
                agent_name=agent_name[:200],
                provider=PROVIDER,
                tool=(iv.get("tool") or "Agent")[:50],
                session_id=session_id[:200] if session_id else None,
                request_id=request_id[:200] if request_id else None,
                runtime_event_id=runtime_event_id,
                external_id=external_id[:300],
                description=(desc[:1000] if isinstance(desc, str) else None),
                model=None,
                prompt_chars=estimate_chars(prompt),
                result_chars=estimate_chars(result),
                sanitized_prompt=sanitize(prompt) if keep_payload else None,
                sanitized_result=sanitize(result) if keep_payload else None,
                order_index=iv.get("order", 0),
                timestamp=timestamp,
            )
            .on_conflict_do_nothing(index_elements=["provider", "external_id"])
            .returning(AgentInvocation.__table__.c.id)
        )
        if session.exec(stmt).first() is not None:
            stats.invocations_inserted += 1


def _runtime_mention_source(event_type: str) -> str:
    return f"runtime_claude_{event_type}" if event_type in ("user", "assistant") else "runtime_claude"


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, str):
        try:
            # Python's fromisoformat accepts both `+00:00` and `Z` from 3.11+.
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            pass
    return datetime.utcnow()


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)[:8000]
    except (TypeError, ValueError):
        return None


def _project_for_cwd(session: Session, cwd: str | None) -> Project | None:
    if not cwd:
        return None
    # The session cwd is the host path of the scanned repo. We try to find
    # the project either by exact match or by a path-substring match against
    # whatever was registered via scan-project.
    direct = session.exec(select(Project).where(Project.path == cwd)).first()
    if direct is not None:
        return direct
    for project in session.exec(select(Project)).all():
        if cwd.startswith(project.path) or project.path.endswith(cwd):
            return project
    return None


def _iter_session_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.jsonl"))


def ingest_path(root_path: str | Path, session: Session) -> IngestStats:
    root = Path(root_path).resolve()
    stats = IngestStats()
    if not root.exists():
        return stats

    # Cache: lookup project per session cwd
    project_cache: dict[str, Project | None] = {}
    # Pre-compiled regex per agent name, scoped by project.
    agent_patterns_by_project = _build_agent_patterns(session)
    # Mapa nombre→agent_id por proyecto, para resolver el subagent_type delegado.
    agent_name_map = _agent_name_map(session)

    # Wipe previous runtime_claude mentions before re-extracting. Doc/task/spec
    # mentions persisted by scan() are untouched.
    session.exec(
        sql_delete(AgentMention).where(AgentMention.source_type.like("runtime_claude%"))
    )
    session.flush()

    for file in _iter_session_files(root):
        stats.files_seen += 1
        # Pre-parseo: los tool_result de las delegaciones llegan en líneas
        # POSTERIORES al tool_use, así que parseamos el archivo entero primero
        # y luego indexamos los results por tool_use_id.
        objs: list[dict[str, Any]] = []
        for raw in file.read_text(encoding="utf-8", errors="replace").splitlines():
            stats.lines_seen += 1
            line = raw.strip()
            if not line:
                continue
            try:
                objs.append(json.loads(line))
            except json.JSONDecodeError:
                stats.skipped += 1
                continue
        results_by_id = _index_tool_results(objs)
        turn_by_uuid = _assign_turns(objs)

        for obj in objs:
            uuid = obj.get("uuid") or obj.get("messageId") or obj.get("id")
            if not uuid:
                stats.skipped += 1
                continue
            external_id = str(uuid)

            event_type = str(obj.get("type") or "other")
            ts = _parse_timestamp(obj.get("timestamp"))

            message = obj.get("message") or {}
            usage = message.get("usage") or {}
            model = message.get("model")
            input_tokens = usage.get("input_tokens") or usage.get("cache_read_input_tokens")
            output_tokens = usage.get("output_tokens")

            cwd = obj.get("cwd")
            project = project_cache.get(cwd) if cwd in project_cache else _project_for_cwd(session, cwd)
            project_cache[cwd] = project

            # Sin proyecto = sesión que no es de un repo scaneado. La ignoramos
            # para no contaminar el dashboard con eventos de cualquier otro
            # `cwd` en el que el usuario haya levantado Claude Code.
            if project is None:
                stats.skipped += 1
                continue

            project_id = project.id

            # Metadata base + (para assistant) resumen de tool calls con la misma
            # forma que Copilot, para que el visor de Ejecuciones funcione igual.
            turn_id = turn_by_uuid.get(external_id)
            base_meta = {
                "session_id": obj.get("sessionId"),
                "request_id": obj.get("requestId"),
                "turn_id": turn_id,
                "parent_uuid": obj.get("parentUuid"),
                "cwd": cwd,
                "file": str(file.name),
                "model": model,
                "usage": usage or None,
            }
            if event_type == "assistant":
                tool_calls, tool_detail, files_touched = _summarize_claude_tools(
                    message.get("content")
                )
                delegated = [
                    e["agent"] for e in tool_detail if isinstance(e, dict) and e.get("agent")
                ]
                base_meta.update(
                    {
                        "tool_calls": tool_calls,
                        "tool_calls_detail": tool_detail,
                        "delegated_agents": delegated,
                        "files_touched": files_touched,
                    }
                )
            event_meta = enrich_metadata(
                base_meta,
                _extract_text(message) if event_type in ("user", "assistant") else None,
            )

            # Idempotent insert: ON CONFLICT DO NOTHING on (provider, external_id).
            stmt = (
                pg_insert(RuntimeEvent.__table__)
                .values(
                    project_id=project_id,
                    provider=PROVIDER,
                    source_kind="local_logs",
                    event_type=event_type,
                    timestamp=ts,
                    endpoint=obj.get("requestId") or file.name,
                    error_message=_stringify(obj.get("error"))[:1000] if obj.get("error") else None,
                    external_id=external_id,
                    event_metadata=event_meta,
                )
                .on_conflict_do_nothing(
                    index_elements=["provider", "external_id"],
                    index_where=text("external_id IS NOT NULL"),
                )
                .returning(RuntimeEvent.__table__.c.id)
            )
            inserted_id = session.exec(stmt).first()
            if inserted_id is None and event_type in ("user", "assistant"):
                # Evento ya ingestado en una corrida previa. Backfill del metadata
                # enriquecido (turn_id + tool_calls_detail/...) SOLO si todavía no
                # tiene turn_id → corre una vez por evento y luego es no-op.
                session.exec(
                    update(RuntimeEvent.__table__)
                    .where(
                        RuntimeEvent.__table__.c.provider == PROVIDER,
                        RuntimeEvent.__table__.c.external_id == external_id,
                        ~RuntimeEvent.__table__.c.event_metadata.op("?")("turn_id"),
                    )
                    .values(event_metadata=event_meta)
                )
            if inserted_id is not None:
                stats.events_inserted += 1

                # Persist an llm_interactions row only for assistant turns where we
                # have token / model information. Prompts/responses themselves are
                # never persisted by this ingest path — privacy stays metadata-only.
                if event_type == "assistant" and (model or input_tokens or output_tokens):
                    session.add(
                        LlmInteraction(
                            runtime_event_id=inserted_id[0],
                            provider=PROVIDER,
                            model=model,
                            prompt_chars=int(input_tokens) * 4 if input_tokens else None,
                            response_chars=int(output_tokens) * 4 if output_tokens else None,
                        )
                    )
                    stats.interactions_inserted += 1

            # Mention extraction always runs: the dedupe at the start wipes
            # previous runtime mentions, so re-ingesting an already-known event
            # still rebuilds its mention set.
            if (
                project is not None
                and event_type in ("user", "assistant")
                and project.id in agent_patterns_by_project
            ):
                text_blob = _extract_text(message)
                if text_blob:
                    session_id = obj.get("sessionId") or "unknown"
                    mention_target = f"claude://session/{session_id}#{external_id}"
                    source_type = _runtime_mention_source(event_type)
                    seen_agents: set[UUID] = set()
                    for ap in agent_patterns_by_project[project.id]:
                        m = ap.pattern.search(text_blob)
                        if m is None or ap.agent_id in seen_agents:
                            continue
                        seen_agents.add(ap.agent_id)
                        snippet_start = max(0, m.start() - 80)
                        snippet_end = min(len(text_blob), m.end() + 80)
                        snippet = text_blob[snippet_start:snippet_end].replace("\n", " ").strip()[:500]
                        session.add(
                            AgentMention(
                                project_id=project.id,
                                agent_id=ap.agent_id,
                                file_path=mention_target,
                                source_type=source_type,
                                line_number=None,
                                snippet=snippet,
                            )
                        )
                        stats.mentions_inserted += 1

            # Delegaciones reales (Task/Agent tool) → agent_invocations. Corre
            # SIEMPRE (no gateado por inserted_id) para backfillear sesiones ya
            # ingestadas; la idempotencia la da (provider, external_id).
            if event_type == "assistant":
                invocations = _extract_agent_invocations(
                    message.get("content"), results_by_id
                )
                if invocations:
                    rt_event_id = inserted_id[0] if inserted_id is not None else None
                    if rt_event_id is None:
                        existing = session.exec(
                            select(RuntimeEvent).where(
                                RuntimeEvent.provider == PROVIDER,
                                RuntimeEvent.external_id == external_id,
                            )
                        ).first()
                        rt_event_id = existing.id if existing is not None else None
                    _persist_invocations(
                        session=session,
                        project_id=project_id,
                        agents=agent_name_map.get(project_id, {"by_key": {}, "by_id": {}}),
                        invocations=invocations,
                        session_id=obj.get("sessionId"),
                        # turn_id (no el requestId del mensaje) para que las
                        # invocaciones agrupen junto a su turno en Ejecuciones.
                        request_id=turn_id or obj.get("requestId"),
                        runtime_event_id=rt_event_id,
                        timestamp=ts,
                        stats=stats,
                    )

    session.commit()
    return stats
