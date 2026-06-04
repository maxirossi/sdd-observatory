"""Lectura on-demand del texto de un turn — NO persiste nada.

Cuando el usuario abre un turn en el replay, leemos el archivo fuente
(jsonl de Claude o chatSession de Copilot), extraemos prompt/response de
ESE turn puntual, sanitizamos al vuelo y devolvemos. El texto nunca toca la
DB, así se respeta privacy_mode=metadata_only.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.config import settings
from app.models import RuntimeEvent
from app.services.claude_logs import _extract_text
from app.services.runtime.copilot_storage_adapter import (
    _apply_delta,
    _extract_response_text,
)
from app.services.sanitizer import sanitize

# Cap de seguridad por si un turn trae un dump gigante.
_MAX_TEXT = 40_000


def _clip(text: str | None) -> tuple[str | None, bool]:
    if not text:
        return None, False
    if len(text) > _MAX_TEXT:
        return text[:_MAX_TEXT], True
    return text, False


# ───────────────────── Claude ─────────────────────


def _claude_jsonl_path(meta: dict) -> Path | None:
    """Ubica el .jsonl de la sesión Claude.

    event_metadata trae `cwd` y `file` (nombre del jsonl). Claude guarda los
    logs en ~/.claude/projects/<cwd con / → ->/<file>, montado en
    settings.ingest_watch_path.
    """
    root = Path(settings.ingest_watch_path)
    file_name = meta.get("file")
    if not file_name:
        return None

    # Intento 1: derivar el dir desde cwd (encoding de Claude: / → -)
    cwd = meta.get("cwd")
    if cwd:
        encoded = cwd.replace("/", "-")
        candidate = root / encoded / file_name
        if candidate.is_file():
            return candidate

    # Intento 2: rglob por nombre (más caro, fallback).
    if root.exists():
        for p in root.rglob(file_name):
            return p
    return None


def _claude_turn_text(meta: dict, external_id: str | None, event_type: str) -> dict[str, Any]:
    path = _claude_jsonl_path(meta)
    if path is None:
        return {"error": "Archivo fuente no encontrado"}

    target_uuid = external_id
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(obj.get("uuid")) != target_uuid:
                    continue
                message = obj.get("message") or {}
                text = _extract_text(message)
                role = obj.get("type")
                if role == "user":
                    return {"prompt": text, "response": None}
                return {"prompt": None, "response": text}
    except OSError:
        return {"error": "No se pudo leer el archivo"}
    return {"error": "Turn no encontrado en el archivo"}


# ───────────────────── Copilot ─────────────────────


def _copilot_chatsession_path(meta: dict) -> Path | None:
    storage_root = settings.copilot_storage_path
    if not storage_root:
        return None
    ws = meta.get("workspace_storage")
    src = meta.get("source_file")
    if not ws or not src:
        return None
    candidate = Path(storage_root) / ws / "chatSessions" / src
    return candidate if candidate.is_file() else None


def _copilot_turn_text(meta: dict, request_id: str | None) -> dict[str, Any]:
    path = _copilot_chatsession_path(meta)
    if path is None:
        return {"error": "ChatSession fuente no encontrada"}
    if not request_id:
        return {"error": "request_id ausente"}

    try:
        state: Any = {}
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    op = json.loads(line)
                except json.JSONDecodeError:
                    continue
                state = _apply_delta(state, op)
    except OSError:
        return {"error": "No se pudo leer el archivo"}

    if not isinstance(state, dict):
        return {"error": "Estado no reconstruible"}

    for req in state.get("requests", []):
        if not isinstance(req, dict):
            continue
        if req.get("requestId") != request_id:
            continue
        message = req.get("message") or {}
        prompt = message.get("text", "") if isinstance(message, dict) else ""
        response = _extract_response_text(req.get("response"))
        return {"prompt": prompt, "response": response}
    return {"error": "Request no encontrado en la sesión"}


# ───────────────────── Public ─────────────────────


def read_session_previews(
    events: list[RuntimeEvent], max_chars: int = 160
) -> dict[str, str]:
    """Lee el archivo fuente UNA vez y devuelve un preview del prompt por turn.

    Key del dict:
      - Claude:  external_id (uuid del jsonl)
      - Copilot: request_id (del event_metadata)

    Sanitizado y truncado a max_chars. Pensado para llamarse una vez por
    sesión en el replay — no por turn.
    """
    if not events:
        return {}
    provider = events[0].provider
    meta0 = events[0].event_metadata or {}

    out: dict[str, str] = {}

    if provider == "claude":
        path = _claude_jsonl_path(meta0)
        if path is None:
            return {}
        # Indexamos SOLO los prompts REALES de usuario (los que disparan el turno),
        # no los tool_result (que en Claude también llegan como type=user con
        # volcados de archivos). El prompt disparador tiene external_id == turn_id
        # (_assign_turns estampa turn_id = uuid del prompt de usuario real).
        wanted = {
            e.external_id
            for e in events
            if e.event_type == "user"
            and e.external_id
            and (e.event_metadata or {}).get("turn_id") == e.external_id
        }
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    uid = str(obj.get("uuid"))
                    if uid not in wanted or obj.get("type") != "user":
                        continue
                    text = _extract_text(obj.get("message") or {})
                    clean = sanitize(text) or ""
                    if clean.strip():
                        out[uid] = clean.strip()[:max_chars]
        except OSError:
            return out
        return out

    if provider == "copilot":
        path = _copilot_chatsession_path(meta0)
        if path is None:
            return {}
        try:
            state: Any = {}
            with path.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        op = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    state = _apply_delta(state, op)
        except OSError:
            return {}
        if not isinstance(state, dict):
            return {}
        for req in state.get("requests", []):
            if not isinstance(req, dict):
                continue
            rid = req.get("requestId")
            msg = req.get("message") or {}
            text = msg.get("text", "") if isinstance(msg, dict) else ""
            clean = sanitize(text) or ""
            if rid and clean.strip():
                out[rid] = clean.strip()[:max_chars]
        return out

    return {}


def read_turn_text(event: RuntimeEvent) -> dict[str, Any]:
    """Devuelve {prompt, response, sanitized:true} o {error}."""
    meta: dict = event.event_metadata or {}
    if event.provider == "claude":
        raw = _claude_turn_text(meta, event.external_id, event.event_type)
    elif event.provider == "copilot":
        # Copilot persiste request_id separado del external_id.
        request_id = meta.get("request_id")
        raw = _copilot_turn_text(meta, request_id)
    else:
        return {"error": f"Provider {event.provider} no soporta lectura on-demand"}

    if "error" in raw:
        return raw

    prompt, p_clip = _clip(sanitize(raw.get("prompt")))
    response, r_clip = _clip(sanitize(raw.get("response")))
    return {
        "prompt": prompt,
        "response": response,
        "sanitized": True,
        "truncated": p_clip or r_clip,
    }
