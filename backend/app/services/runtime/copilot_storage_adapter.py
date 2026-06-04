"""Copilot Chat Storage adapter — lee los chatSessions de VS Code.

VS Code persiste cada sesión de GitHub Copilot Chat como un JSONL
delta-log dentro de:
    ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl

Formato (append-only):
    {kind: 0, v: <snapshot inicial>}
    {kind: 1, k: <path>, v: <replace value>}
    {kind: 2, k: <path>, v: <appendee>}

Reconstruido, el estado expone `requests[]` con prompt, response, agent,
modelId, contentReferences y timestamps reales. Eso es lo que ingestamos.

Atribución al proyecto: cada workspaceStorage tiene `workspace.json` con
`folder: "file://..."` apuntando al directorio del workspace. Si coincide o
está dentro de algún `project.path`, el evento se atribuye.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from uuid import UUID

from sqlalchemy import text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, select

from app.models import (
    Agent,
    AgentInvocation,
    AgentMention,
    LlmInteraction,
    Project,
    RuntimeEvent,
)
from app.services.runtime.base import (
    IngestStats,
    ProviderAdapter,
    SOURCE_KIND_LOCAL_LOGS,
)
from app.services.runtime.inference import enrich_metadata, extract_inference
from app.services.sanitizer import estimate_chars, sanitize

log = logging.getLogger(__name__)

PROVIDER = "copilot"

# ────────────────────── State reconstruction ──────────────────────


def _apply_delta(state: Any, op: dict) -> Any:
    """Aplica un delta del JSONL a `state`. Retorna el nuevo state."""
    k = op.get("kind")
    if k == 0:  # snapshot inicial
        return op.get("v")
    path = op.get("k") or []
    v = op.get("v")
    if k == 1:  # replace at path
        if not path:
            return v
        cur = state
        for p in path[:-1]:
            cur = cur[p] if isinstance(cur, dict) else cur[int(p)]
        last = path[-1]
        if isinstance(cur, dict):
            cur[last] = v
        else:
            cur[int(last)] = v
    elif k == 2:  # append/extend at path
        cur = state
        for p in path[:-1]:
            cur = cur[p] if isinstance(cur, dict) else cur[int(p)]
        target = cur[path[-1]] if path else cur
        if isinstance(v, list):
            target.extend(v)
        else:
            target.append(v)
    return state


def _rebuild_session(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            state: Any = {}
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    op = json.loads(line)
                except json.JSONDecodeError:
                    continue
                state = _apply_delta(state, op)
            if isinstance(state, dict):
                return state
            return None
    except OSError:
        return None


# ────────────────────── Workspace → project ──────────────────────


_FILE_URI_RE = re.compile(r"^file://(?P<path>/.+)$")


def _workspace_folder(workspace_dir: Path) -> str | None:
    """Lee workspace.json (single folder) o workspace.json + files. Devuelve
    el path absoluto del workspace si es un single-root."""
    ws_json = workspace_dir / "workspace.json"
    if not ws_json.is_file():
        return None
    try:
        obj = json.loads(ws_json.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return None
    folder = obj.get("folder")
    if not isinstance(folder, str):
        return None
    m = _FILE_URI_RE.match(folder)
    if m:
        return m.group("path")
    if folder.startswith("/"):
        return folder
    return None


def _project_for_path(
    workspace_path: str | None, projects: list[Project]
) -> Project | None:
    if not workspace_path:
        return None
    candidates = sorted(projects, key=lambda p: len(p.path or ""), reverse=True)
    for p in candidates:
        if not p.path:
            continue
        if workspace_path == p.path or workspace_path.startswith(p.path + os.sep):
            return p
    return None


# ────────────────────── Request decoding helpers ──────────────────────


def _extract_response_text(response: Any) -> str:
    """Concatena los items textuales de la lista response[]."""
    if not isinstance(response, list):
        return ""
    parts: list[str] = []
    for item in response:
        if not isinstance(item, dict):
            continue
        # Markdown content viene como {value, supportThemeIcons, ...}
        v = item.get("value")
        if isinstance(v, str):
            parts.append(v)
            continue
        # Reasoning / thinking
        if item.get("kind") == "thinking":
            inner = item.get("value")
            if isinstance(inner, str):
                parts.append(inner)
                continue
        # markdownContent shape
        content = item.get("content")
        if isinstance(content, dict):
            cv = content.get("value")
            if isinstance(cv, str):
                parts.append(cv)
    return "\n".join(parts)


def _extract_content_references(refs: Any, target_root: Path | None) -> list[str]:
    """Devuelve paths relativos al target_root para las contentReferences."""
    out: list[str] = []
    if not isinstance(refs, list):
        return out
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        r_val = ref.get("reference")
        if not isinstance(r_val, dict):
            continue
        # fsPath o path
        candidate = r_val.get("fsPath") or r_val.get("path") or r_val.get("external")
        if not isinstance(candidate, str):
            continue
        m = _FILE_URI_RE.match(candidate)
        if m:
            candidate = m.group("path")
        if target_root:
            try:
                rel = str(Path(candidate).relative_to(target_root))
                out.append(rel)
                continue
            except ValueError:
                pass
        out.append(candidate)
    # Dedup conservando orden
    seen: set[str] = set()
    deduped: list[str] = []
    for p in out:
        if p in seen:
            continue
        seen.add(p)
        deduped.append(p)
    return deduped[:50]


# Cuántas tool calls detalladas guardamos por turn (cap de seguridad).
# Un turno inline del orchestrator puede tener cientos de tool calls; el
# objetivo es capturar toda la actividad, así que el cap es alto.
_MAX_TOOL_DETAIL = 300
# Markdown link: [label](target) — Copilot embebe file:// uris así.
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")


def _invocation_message_str(val: Any) -> str:
    """invocationMessage puede ser str o {value, isTrusted, ...}."""
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        v = val.get("value")
        if isinstance(v, str):
            return v
    return ""


def _relativize(path: str, target_root: Path | None) -> str:
    m = _FILE_URI_RE.match(path)
    if m:
        path = m.group("path")
    if target_root:
        try:
            return str(Path(path).relative_to(target_root))
        except ValueError:
            pass
    return path


def _clean_message_label(val: Any, target_root: Path | None) -> str:
    """Convierte el invocationMessage (markdown con file:// links) a texto plano
    legible: reemplaza `[](file://abs/path)` por el path relativo."""
    text = _invocation_message_str(val)
    if not text:
        return ""

    def _repl(m: re.Match[str]) -> str:
        label, target = m.group(1), m.group(2)
        if target.startswith("file://") or target.startswith("/"):
            return _relativize(target, target_root)
        return label or target

    text = _MD_LINK_RE.sub(_repl, text)
    # backticks de markdown y escapes \- que Copilot mete en los comandos
    text = text.replace("\\-", "-").replace("`", "")
    return " ".join(text.split())[:300]


def _files_from_message(val: Any, target_root: Path | None) -> list[str]:
    """Extrae paths de archivo embebidos como file:// uris en el message."""
    text = _invocation_message_str(val)
    out: list[str] = []
    for _, target in _MD_LINK_RE.findall(text):
        if target.startswith("file://"):
            rel = _relativize(target, target_root)
            # los file links traen #L1-L2 a veces; lo dejamos como está
            out.append(rel)
    return out


def _summarize_tool_calls(
    response: Any, target_root: Path | None
) -> tuple[list[str], list[dict]]:
    """Devuelve (toolIds únicos, detalle por invocación).

    El detalle captura lo más útil de cada tool: comando de terminal + estado,
    archivo tocado, todos, sub-agente delegado. Esto es el "loggear todo lo
    posible" — antes solo guardábamos los toolIds.
    """
    ids: list[str] = []
    seen_ids: set[str] = set()
    detail: list[dict] = []
    if not isinstance(response, list):
        return ids, detail

    for item in response:
        if not (isinstance(item, dict) and item.get("kind") == "toolInvocationSerialized"):
            continue
        tid = item.get("toolId") or item.get("toolCallId")
        if isinstance(tid, str) and tid not in seen_ids:
            seen_ids.add(tid)
            ids.append(tid)
        if len(detail) >= _MAX_TOOL_DETAIL:
            continue

        tsd = item.get("toolSpecificData")
        tsd = tsd if isinstance(tsd, dict) else {}
        kind = tsd.get("kind")
        entry: dict[str, Any] = {
            "tool": tid,
            "label": _clean_message_label(item.get("invocationMessage"), target_root),
            "complete": bool(item.get("isComplete")),
        }

        if kind == "terminal":
            cmd_obj = tsd.get("commandLine") or {}
            cmd = (
                cmd_obj.get("forDisplay")
                or cmd_obj.get("toolEdited")
                or cmd_obj.get("original")
                if isinstance(cmd_obj, dict)
                else None
            )
            if cmd:
                entry["command"] = sanitize(cmd.strip())[:500] if cmd.strip() else None
            state = tsd.get("terminalCommandState")
            if state:
                entry["state"] = state
        elif kind == "todoList":
            todos = tsd.get("todoList")
            if isinstance(todos, list):
                entry["todos"] = [
                    {"title": t.get("title"), "status": t.get("status")}
                    for t in todos
                    if isinstance(t, dict)
                ][:30]
        elif kind == "subagent":
            an = tsd.get("agentName")
            if an:
                entry["agent"] = an
            if tsd.get("modelName"):
                entry["model"] = tsd.get("modelName")
        else:
            files = _files_from_message(item.get("invocationMessage"), target_root)
            if files:
                entry["files"] = files[:5]

        detail.append(entry)

    return ids, detail


def _extract_subagent_invocations(response: Any) -> list[dict]:
    """Delegaciones reales de sub-agentes: `runSubagent` con
    `toolSpecificData.kind == "subagent"`. Cada una nombra el agentName que
    efectivamente se ejecutó por orden del orchestrator.

    Una misma delegación aparece varias veces en el array (un placeholder con
    result vacío + la versión final con result lleno), todas con el MISMO
    `toolCallId`. Deduplicamos por toolCallId quedándonos con la entrada más
    completa (la de result más largo). Esa es la unidad lógica de delegación.

    NO incluye `execution_subagent` (wrapper de ejecución en background sin
    nombre de agente), las entradas sin agentName, ni menciones de texto.
    """
    if not isinstance(response, list):
        return []

    # toolCallId → (order de primera aparición, mejor entry)
    by_call: dict[str, dict] = {}
    fallback = 0
    for item in response:
        if not (isinstance(item, dict) and item.get("kind") == "toolInvocationSerialized"):
            continue
        tsd = item.get("toolSpecificData")
        if not (isinstance(tsd, dict) and tsd.get("kind") == "subagent"):
            continue
        agent_name = tsd.get("agentName")
        if not isinstance(agent_name, str) or not agent_name.strip():
            continue

        call_id = item.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            # Sin toolCallId no podemos deduplicar; usamos un key sintético.
            call_id = f"__pos{fallback}"
        result = tsd.get("result") if isinstance(tsd.get("result"), str) else ""
        candidate = {
            "agent_name": agent_name.strip(),
            "tool": item.get("toolId") or "runSubagent",
            "description": tsd.get("description"),
            "prompt": tsd.get("prompt"),
            "result": tsd.get("result"),
            "model": tsd.get("modelName"),
            "call_id": call_id,
            "_order": fallback,
            "_result_len": len(result),
        }
        prev = by_call.get(call_id)
        if prev is None:
            by_call[call_id] = candidate
        elif candidate["_result_len"] >= prev["_result_len"]:
            # Conservamos el order de la primera aparición.
            candidate["_order"] = prev["_order"]
            by_call[call_id] = candidate
        fallback += 1

    # Orden estable por primera aparición.
    ordered = sorted(by_call.values(), key=lambda d: d["_order"])
    for i, d in enumerate(ordered):
        d["order"] = i
        d.pop("_order", None)
        d.pop("_result_len", None)
    return ordered


# ────────────────────── Mention extraction ──────────────────────


@dataclass
class _AgentPattern:
    agent_id: UUID
    project_id: UUID
    name: str
    pattern: re.Pattern[str]


def _compile_agent_patterns(session: Session) -> dict[UUID, list[_AgentPattern]]:
    out: dict[UUID, list[_AgentPattern]] = {}
    for a in session.exec(select(Agent)).all():
        # Buscamos el nombre completo como token; case-insensitive.
        pattern = re.compile(rf"\b{re.escape(a.name)}\b", re.IGNORECASE)
        out.setdefault(a.project_id, []).append(
            _AgentPattern(agent_id=a.id, project_id=a.project_id, name=a.name, pattern=pattern)
        )
    return out


def _agents_by_name(session: Session) -> dict[UUID, dict[str, UUID]]:
    """Mapa project_id → {nombre normalizado: agent_id}, con variantes para
    matchear el agentName delegado (que viene sin sufijo `.agent`)."""
    out: dict[UUID, dict[str, UUID]] = {}
    for a in session.exec(select(Agent)).all():
        m = out.setdefault(a.project_id, {})
        for variant in (a.name, a.name.replace(".agent", "")):
            m[variant.lower()] = a.id
    return out


def _resolve_agent_id(
    name_map: dict[str, UUID], agent_name: str
) -> UUID | None:
    """Resuelve un agentName delegado a un agent declarado. None si el agente no
    está declarado en el repo (p.ej. 'Explore', sub-agentes built-in)."""
    if not agent_name:
        return None
    key = agent_name.lower()
    return name_map.get(key) or name_map.get(key.replace(".agent", ""))


# ────────────────────── Adapter ──────────────────────


class CopilotChatStorageAdapter(ProviderAdapter):
    """Lee los chatSessions de VS Code workspaceStorage."""

    name = "copilot"
    source_kind = SOURCE_KIND_LOCAL_LOGS

    def discover(self, root: Path) -> Iterable[Path]:
        if not root.exists():
            return []
        return list(root.glob("*/chatSessions/*.jsonl"))

    def ingest_path(self, root: Path, session: Session) -> IngestStats:
        stats = IngestStats()
        if not root.exists():
            return stats

        projects = session.exec(select(Project)).all()
        agent_patterns_by_project = _compile_agent_patterns(session)
        agents_by_name = _agents_by_name(session)

        # Cache workspace.json → Project resolution
        ws_to_project: dict[Path, Project | None] = {}

        # Las mentions runtime_copilot* son idempotentes implícitamente: cada
        # turn tiene un req_id único en el file_path, así que mismo evento =
        # misma mention. NO borramos en cada tick — solo crearíamos las que
        # falten, pero como persistimos mentions solo cuando el insert del
        # event devuelve id (= nuevo), las viejas quedan estables.

        for jsonl in self.discover(root):
            stats.files_seen += 1
            workspace_dir = jsonl.parent.parent  # <hash>/chatSessions/file.jsonl
            if workspace_dir not in ws_to_project:
                ws_path = _workspace_folder(workspace_dir)
                ws_to_project[workspace_dir] = _project_for_path(ws_path, projects)
            project = ws_to_project[workspace_dir]
            if project is None:
                stats.skipped += 1
                continue

            target_root = Path(project.path) if project.path else None
            state = _rebuild_session(jsonl)
            if not isinstance(state, dict):
                stats.skipped += 1
                continue

            session_id = state.get("sessionId") or jsonl.stem
            requests = state.get("requests") or []
            if not isinstance(requests, list):
                continue

            patterns = agent_patterns_by_project.get(project.id, [])
            name_map = agents_by_name.get(project.id, {})

            for req in requests:
                if not isinstance(req, dict):
                    continue
                req_id = req.get("requestId")
                if not req_id:
                    continue
                ts_ms = req.get("timestamp")
                if not isinstance(ts_ms, (int, float)):
                    continue
                ts = datetime.utcfromtimestamp(ts_ms / 1000.0)

                # Agent nativo (setup.agent, github.copilot.editsAgent, etc.)
                agent_obj = req.get("agent") or {}
                native_agent_id = agent_obj.get("id") if isinstance(agent_obj, dict) else None
                native_agent_name = (
                    agent_obj.get("name") if isinstance(agent_obj, dict) else None
                )

                model_id = req.get("modelId")
                elapsed_ms = req.get("elapsedMs") or req.get("timeSpentWaiting")

                # Prompt + response text
                message = req.get("message") or {}
                prompt_text = (
                    message.get("text", "") if isinstance(message, dict) else ""
                )
                response_text = _extract_response_text(req.get("response"))
                tool_ids, tool_detail = _summarize_tool_calls(
                    req.get("response"), target_root
                )
                subagent_invocations = _extract_subagent_invocations(req.get("response"))
                files_touched = _extract_content_references(
                    req.get("contentReferences"), target_root
                )

                base_metadata = {
                    "session_id": session_id,
                    "request_id": req_id,
                    "response_id": req.get("responseId"),
                    "native_agent_id": native_agent_id,
                    "native_agent_name": native_agent_name,
                    "model": model_id,
                    "elapsed_ms": elapsed_ms,
                    "tool_calls": tool_ids,
                    "tool_calls_detail": tool_detail,
                    "delegated_agents": [iv["agent_name"] for iv in subagent_invocations],
                    "files_touched": files_touched,
                    "source_file": jsonl.name,
                    "workspace_storage": workspace_dir.name,
                }

                # ── Insert USER event (el prompt) ──
                user_external_id = f"copilot:chat:user:{req_id}"
                user_metadata = enrich_metadata(
                    {**base_metadata, "event_class": "user"}, prompt_text
                )
                stmt = (
                    pg_insert(RuntimeEvent.__table__)
                    .values(
                        project_id=project.id,
                        provider=PROVIDER,
                        source_kind=SOURCE_KIND_LOCAL_LOGS,
                        event_type="user",
                        timestamp=ts,
                        endpoint=req_id,
                        external_id=user_external_id,
                        request_size=len(prompt_text.encode("utf-8")) if prompt_text else 0,
                        event_metadata=user_metadata,
                    )
                    .on_conflict_do_nothing(
                        index_elements=["provider", "external_id"],
                        index_where=text("external_id IS NOT NULL"),
                    )
                    .returning(RuntimeEvent.__table__.c.id)
                )
                row = session.exec(stmt).first()
                inserted_user_id = row[0] if row else None
                if inserted_user_id is not None:
                    stats.events_inserted += 1
                    if prompt_text:
                        _persist_mentions(
                            session=session,
                            project_id=project.id,
                            agent_patterns=patterns,
                            text_blob=prompt_text,
                            mention_target=f"copilot://session/{session_id}#{req_id}:user",
                            source_type="runtime_copilot_user",
                            stats=stats,
                        )
                    # También registramos el native agent como mención si existe
                    # un agent declarado con ese mismo nombre/id en el repo.
                    _maybe_record_native_agent_mention(
                        session,
                        project.id,
                        native_agent_id,
                        native_agent_name,
                        f"copilot://session/{session_id}#{req_id}:native",
                        stats,
                    )

                # ── Insert ASSISTANT event (la respuesta) ──
                if response_text or tool_ids or req.get("response"):
                    # elapsedMs puede venir absurdo (Copilot acumula tiempo
                    # cuando VS Code está cerrado entre prompts). Cap a 1h
                    # para que el INTEGER de la columna no overflowee y la
                    # latency siga teniendo sentido visual.
                    capped_ms: int | None = None
                    if isinstance(elapsed_ms, (int, float)) and 0 < elapsed_ms < 3_600_000:
                        capped_ms = int(elapsed_ms)
                    response_ts = ts
                    if capped_ms:
                        response_ts = datetime.utcfromtimestamp(
                            ts_ms / 1000.0 + capped_ms / 1000.0
                        )

                    assistant_external_id = f"copilot:chat:assistant:{req_id}"
                    assistant_metadata = enrich_metadata(
                        {**base_metadata, "event_class": "assistant"},
                        response_text,
                    )
                    stmt = (
                        pg_insert(RuntimeEvent.__table__)
                        .values(
                            project_id=project.id,
                            provider=PROVIDER,
                            source_kind=SOURCE_KIND_LOCAL_LOGS,
                            event_type="assistant",
                            timestamp=response_ts,
                            latency_ms=capped_ms,
                            endpoint=req_id,
                            external_id=assistant_external_id,
                            response_size=(
                                len(response_text.encode("utf-8")) if response_text else 0
                            ),
                            event_metadata=assistant_metadata,
                        )
                        .on_conflict_do_nothing(
                            index_elements=["provider", "external_id"],
                            index_where=text("external_id IS NOT NULL"),
                        )
                        .returning(RuntimeEvent.__table__.c.id)
                    )
                    row = session.exec(stmt).first()
                    inserted_id = row[0] if row else None
                    if inserted_id is None:
                        # Evento ya ingestado en una corrida previa. Backfill del
                        # metadata enriquecido (tool_calls_detail/delegated_agents)
                        # SOLO si todavía no lo tiene → corre una vez y luego no-op.
                        session.exec(
                            update(RuntimeEvent.__table__)
                            .where(
                                RuntimeEvent.__table__.c.provider == PROVIDER,
                                RuntimeEvent.__table__.c.external_id
                                == assistant_external_id,
                                ~RuntimeEvent.__table__.c.event_metadata.op("?")(
                                    "tool_calls_detail"
                                ),
                            )
                            .values(event_metadata=assistant_metadata)
                        )
                    if inserted_id is not None:
                        stats.events_inserted += 1
                        # llm_interaction: counts + sanitized_payload si privacy lo permite
                        from app.config import settings

                        privacy = settings.privacy_mode
                        sanitized_prompt = (
                            sanitize(prompt_text)
                            if privacy in ("sanitized_payload", "raw_local_only")
                            else None
                        )
                        sanitized_response = (
                            sanitize(response_text)
                            if privacy in ("sanitized_payload", "raw_local_only")
                            else None
                        )
                        session.add(
                            LlmInteraction(
                                runtime_event_id=inserted_id,
                                provider=PROVIDER,
                                model=model_id,
                                prompt_chars=estimate_chars(prompt_text),
                                response_chars=estimate_chars(response_text),
                                sanitized_prompt=sanitized_prompt,
                                sanitized_response=sanitized_response,
                            )
                        )
                        stats.interactions_inserted += 1
                        if response_text:
                            _persist_mentions(
                                session=session,
                                project_id=project.id,
                                agent_patterns=patterns,
                                text_blob=response_text,
                                mention_target=f"copilot://session/{session_id}#{req_id}:assistant",
                                source_type="runtime_copilot_assistant",
                                stats=stats,
                            )

                    # ── Delegaciones reales (runSubagent) ──
                    # Fuera del gate `inserted_id is not None` a propósito: así
                    # se backfillean invocaciones para eventos ya ingestados en
                    # corridas previas. Idempotente por (provider, external_id).
                    if subagent_invocations:
                        parent_event_id = inserted_id
                        if parent_event_id is None:
                            existing = session.exec(
                                select(RuntimeEvent.id).where(
                                    RuntimeEvent.provider == PROVIDER,
                                    RuntimeEvent.external_id == assistant_external_id,
                                )
                            ).first()
                            parent_event_id = (
                                existing[0] if isinstance(existing, tuple) else existing
                            )
                        _persist_invocations(
                            session=session,
                            project_id=project.id,
                            name_map=name_map,
                            invocations=subagent_invocations,
                            session_id=session_id,
                            request_id=req_id,
                            runtime_event_id=parent_event_id,
                            timestamp=response_ts,
                            stats=stats,
                        )

            stats.lines_seen += len(requests)
            session.commit()

        return stats


def _persist_invocations(
    *,
    session: Session,
    project_id: UUID,
    name_map: dict[str, UUID],
    invocations: list[dict],
    session_id: str,
    request_id: str,
    runtime_event_id: UUID | None,
    timestamp: datetime,
    stats: IngestStats,
) -> None:
    """Persiste delegaciones reales de sub-agentes. Idempotente por
    (provider, external_id). El prompt/result solo se guarda si privacy_mode lo
    permite; agent_name/description/model/chars se guardan siempre."""
    from app.config import settings

    privacy = settings.privacy_mode
    keep_payload = privacy in ("sanitized_payload", "raw_local_only")

    for iv in invocations:
        order = iv.get("order", 0)
        # toolCallId es estable entre re-ingests → idempotencia robusta.
        call_id = iv.get("call_id") or f"pos{order}"
        external_id = f"copilot:subagent:{request_id}:{call_id}"
        prompt = iv.get("prompt") if isinstance(iv.get("prompt"), str) else None
        result = iv.get("result") if isinstance(iv.get("result"), str) else None
        desc = iv.get("description")
        stmt = (
            pg_insert(AgentInvocation.__table__)
            .values(
                project_id=project_id,
                agent_id=_resolve_agent_id(name_map, iv["agent_name"]),
                agent_name=iv["agent_name"][:200],
                provider=PROVIDER,
                tool=(iv.get("tool") or "runSubagent")[:50],
                session_id=session_id[:200] if session_id else None,
                request_id=request_id[:200] if request_id else None,
                runtime_event_id=runtime_event_id,
                external_id=external_id[:300],
                description=(desc[:1000] if isinstance(desc, str) else None),
                model=(iv.get("model") or None),
                prompt_chars=estimate_chars(prompt),
                result_chars=estimate_chars(result),
                sanitized_prompt=sanitize(prompt) if keep_payload else None,
                sanitized_result=sanitize(result) if keep_payload else None,
                order_index=order,
                timestamp=timestamp,
            )
            .on_conflict_do_nothing(
                index_elements=["provider", "external_id"],
            )
            .returning(AgentInvocation.__table__.c.id)
        )
        row = session.exec(stmt).first()
        if row is not None:
            stats.invocations_inserted += 1


def _persist_mentions(
    *,
    session: Session,
    project_id: UUID,
    agent_patterns: list[_AgentPattern],
    text_blob: str,
    mention_target: str,
    source_type: str,
    stats: IngestStats,
) -> None:
    seen: set[UUID] = set()
    for ap in agent_patterns:
        if ap.agent_id in seen:
            continue
        m = ap.pattern.search(text_blob)
        if m is None:
            continue
        seen.add(ap.agent_id)
        snippet_start = max(0, m.start() - 80)
        snippet_end = min(len(text_blob), m.end() + 80)
        snippet = text_blob[snippet_start:snippet_end].replace("\n", " ").strip()[:500]
        session.add(
            AgentMention(
                project_id=project_id,
                agent_id=ap.agent_id,
                file_path=mention_target,
                source_type=source_type,
                line_number=None,
                snippet=snippet,
            )
        )
        stats.mentions_inserted += 1


def _maybe_record_native_agent_mention(
    session: Session,
    project_id: UUID,
    native_agent_id: str | None,
    native_agent_name: str | None,
    mention_target: str,
    stats: IngestStats,
) -> None:
    """Si el native agent de Copilot (setup.agent, github.copilot.editsAgent…)
    matchea un agent declarado en el repo por nombre, registramos la mención.
    No fuerza: solo si ya existe."""
    if not native_agent_id and not native_agent_name:
        return
    candidates = [v for v in (native_agent_id, native_agent_name) if v]
    for name in candidates:
        agent = session.exec(
            select(Agent).where(Agent.project_id == project_id, Agent.name == name)
        ).first()
        if agent:
            session.add(
                AgentMention(
                    project_id=project_id,
                    agent_id=agent.id,
                    file_path=mention_target,
                    source_type="runtime_copilot_native",
                    line_number=None,
                    snippet=f"native: {native_agent_name or native_agent_id}",
                )
            )
            stats.mentions_inserted += 1
            return
