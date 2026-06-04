"""Estado "en vivo" de una ejecución de Copilot — lee el tail del chatSession
más reciente del proyecto (NO la DB; el watch loop de 60s es demasiado lento
para tiempo real) y deriva la fase actual: iniciando / derivando / agente
trabajando / verificando / finalizada.

No persiste nada. Pensado para polling cada ~2s desde el front.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from uuid import UUID

from sqlmodel import Session, select

from app.config import settings
from app.models import AgentRun, Project
from app.services.claude_logs import (
    _DELEGATION_TOOLS,
    _extract_text,
    _is_user_prompt,
)
from app.services.runtime.copilot_storage_adapter import (
    _project_for_path,
    _rebuild_session,
    _workspace_folder,
)

# Ventana de actividad por mtime. Copilot escribe a ráfagas: entre tool calls el
# modelo "piensa" (con contexto grande puede tardar ~1min) y cuando corre un
# sub-agente NO escribe el archivo padre. Por eso 45s daba falsos "Finalizado".
_ACTIVE_WINDOW_S = 90
# Más viejo que esto → claramente inactivo; ni reconstruimos (ahorro).
_STALE_SKIP_S = 900
_TASK_RE = re.compile(r"\b(T\d{2,}[a-z]?|HU-\d+-[A-Z]+)\b")


def _git_branch(project: Project | None) -> str | None:
    """Branch actual del repo target, leído de .git/HEAD. Usa el mount del
    container si existe; si no, el path del proyecto."""
    candidates: list[Path] = []
    mount = settings.scan_target_mount_path
    if mount:
        candidates.append(Path(mount))
    if project and project.path:
        candidates.append(Path(project.path))
    for base in candidates:
        head = base / ".git" / "HEAD"
        try:
            txt = head.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if txt.startswith("ref:"):
            return txt.split("/", 2)[-1]  # refs/heads/<branch> → <branch>
        return txt[:12]  # detached HEAD → sha corto
    return None


def _infer_task(text: str | None) -> str | None:
    if not text:
        return None
    m = _TASK_RE.search(text)
    return m.group(1).upper() if m else None


def _newest_session_for_project(project_id: UUID, session: Session) -> Path | None:
    root_str = settings.copilot_storage_path or settings.copilot_logs_path
    if not root_str:
        return None
    root = Path(root_str)
    if not root.exists():
        return None
    projects = session.exec(select(Project)).all()
    best: Path | None = None
    best_mtime = 0.0
    ws_cache: dict[Path, bool] = {}
    for jsonl in root.glob("*/chatSessions/*.jsonl"):
        ws = jsonl.parent.parent
        ok = ws_cache.get(ws)
        if ok is None:
            pr = _project_for_path(_workspace_folder(ws), projects)
            ok = pr is not None and pr.id == project_id
            ws_cache[ws] = ok
        if not ok:
            continue
        try:
            mt = jsonl.stat().st_mtime
        except OSError:
            continue
        if mt > best_mtime:
            best_mtime = mt
            best = jsonl
    return best


def _last_request(state: dict) -> dict | None:
    reqs = state.get("requests") if isinstance(state, dict) else None
    if not isinstance(reqs, list) or not reqs:
        return None
    return reqs[-1] if isinstance(reqs[-1], dict) else None


def _derive(req: dict) -> dict:
    """Deriva fase + campos del último turno."""
    prompt = (req.get("message") or {}).get("text", "") if isinstance(req.get("message"), dict) else ""
    task_ref = _infer_task(prompt)

    current_step: str | None = None  # todo in-progress
    todos_done = 0
    todos_total = 0
    # delegaciones dedup por toolCallId (placeholder + final)
    subs: dict[str, dict] = {}
    sub_order: list[str] = []
    last_tool: str | None = None
    saw_todo = False

    for it in req.get("response") or []:
        if not (isinstance(it, dict) and it.get("kind") == "toolInvocationSerialized"):
            continue
        tid = it.get("toolId")
        last_tool = tid
        tsd = it.get("toolSpecificData") or {}
        if tsd.get("kind") == "todoList":
            saw_todo = True
            todos = tsd.get("todoList")
            if isinstance(todos, list):
                todos_total = len(todos)
                todos_done = sum(1 for t in todos if isinstance(t, dict) and t.get("status") == "completed")
                for t in todos:
                    if isinstance(t, dict) and t.get("status") == "in-progress":
                        current_step = t.get("title")
        elif tsd.get("kind") == "subagent" and tsd.get("agentName"):
            cid = it.get("toolCallId") or f"_{len(sub_order)}"
            res = tsd.get("result") or ""
            if cid not in subs:
                sub_order.append(cid)
            prev = subs.get(cid)
            if prev is None or len(res) > prev["result_len"]:
                subs[cid] = {"agent": tsd["agentName"], "result_len": len(res)}

    dels = [subs[c] for c in sub_order]
    agents_done = [d["agent"] for d in dels if d["result_len"] > 0]
    # Agente "trabajando" = la última delegación cuyo result sigue vacío.
    active_agent: str | None = None
    for d in reversed(dels):
        if d["result_len"] == 0:
            active_agent = d["agent"]
            break

    # Fase.
    if dels:
        if active_agent:
            phase = "agent_working"
        elif last_tool in ("runSubagent",):
            phase = "agent_working"
        else:
            phase = "verifying"
    elif saw_todo:
        phase = "delegating"
    else:
        phase = "starting"

    return {
        "task_ref": task_ref,
        "phase": phase,
        "current_step": current_step,
        "active_agent": active_agent,
        "agents_done": agents_done,
        "delegations_total": len(dels),
        "todos_done": todos_done,
        "todos_total": todos_total,
    }


# ────────────────────────── Claude ──────────────────────────


def _safe_mtime(path: Path | None) -> float:
    if path is None:
        return 0.0
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _newest_claude_session_for_project(project: Project | None) -> Path | None:
    """jsonl de Claude más reciente del proyecto. Claude codifica el cwd como
    nombre de carpeta (`/` → `-`), así que matcheamos por ahí sin abrir archivos."""
    root_str = settings.ingest_watch_path
    if project is None or not root_str:
        return None
    root = Path(root_str)
    if not root.exists():
        return None
    enc = project.path.rstrip("/").replace("/", "-")
    best: Path | None = None
    best_mtime = 0.0
    for jsonl in root.glob("*/*.jsonl"):
        dirname = jsonl.parent.name
        if not (dirname == enc or dirname.startswith(enc)):
            continue
        mt = _safe_mtime(jsonl)
        if mt > best_mtime:
            best_mtime = mt
            best = jsonl
    return best


def _read_claude_tail(path: Path, max_bytes: int = 600_000) -> list[dict]:
    """Objs JSON del final del archivo (los .jsonl de Claude pueden ser grandes;
    para 'en vivo' alcanza con el tramo final, que es el turno en curso)."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()  # descartamos la línea parcial inicial
            data = fh.read()
    except OSError:
        return []
    objs: list[dict] = []
    for raw in data.decode("utf-8", "replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            objs.append(obj)
    return objs


def _derive_claude(objs: list[dict]) -> dict | None:
    """Deriva fase + campos del último turno de una sesión Claude. Misma forma
    de salida que `_derive` (Copilot) para que la barra del front sea idéntica."""
    if not objs:
        return None
    # Inicio del turno = último prompt REAL del usuario (no tool_result).
    last_user_idx: int | None = None
    for i, o in enumerate(objs):
        if _is_user_prompt(o):
            last_user_idx = i
    turn = objs[last_user_idx:] if last_user_idx is not None else objs

    prompt = ""
    if last_user_idx is not None:
        prompt = _extract_text((objs[last_user_idx].get("message") or {}))
    task_ref = _infer_task(prompt)

    # tool_results ya recibidos → para saber qué delegación sigue corriendo.
    results_seen: set[str] = set()
    for o in turn:
        content = (o.get("message") or {}).get("content")
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    tid = b.get("tool_use_id")
                    if isinstance(tid, str):
                        results_seen.add(tid)

    current_step: str | None = None
    todos_done = todos_total = 0
    pending_agents: list[str] = []
    done_agents: list[str] = []
    for o in turn:
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name")
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            if name == "TodoWrite":
                todos = inp.get("todos")
                if isinstance(todos, list):
                    todos_total = len(todos)
                    todos_done = sum(
                        1 for t in todos if isinstance(t, dict) and t.get("status") == "completed"
                    )
                    for t in todos:
                        if isinstance(t, dict) and t.get("status") == "in_progress":
                            current_step = t.get("content") or t.get("activeForm")
            elif name in _DELEGATION_TOOLS:
                st = inp.get("subagent_type")
                tid = b.get("id")
                if isinstance(st, str) and st:
                    if isinstance(tid, str) and tid not in results_seen:
                        pending_agents.append(st)
                    else:
                        done_agents.append(st)

    active_agent = pending_agents[-1] if pending_agents else None
    if active_agent:
        phase = "agent_working"
    elif todos_total and todos_done >= todos_total:
        phase = "verifying"
    elif done_agents:
        phase = "delegating"
    else:
        # Claude corriendo sus propias tools (sin subagente): "En progreso"
        # vía current_step. No usamos agent_working (implicaría delegación).
        phase = "starting"
    return {
        "task_ref": task_ref,
        "phase": phase,
        "current_step": current_step,
        "active_agent": active_agent,
        "agents_done": done_agents,
        "delegations_total": len(done_agents) + len(pending_agents),
        "todos_done": todos_done,
        "todos_total": todos_total,
    }


def _running_auto_run(project_id: UUID, session: Session) -> AgentRun | None:
    """Auto-run en curso (tomado por el runner host). El más reciente."""
    return session.exec(
        select(AgentRun)
        .where(AgentRun.project_id == project_id, AgentRun.status == "running")
        .order_by(AgentRun.started_at.desc())  # type: ignore[union-attr]
    ).first()


def get_live_status(project_id: UUID, session: Session) -> dict:
    project = session.exec(select(Project).where(Project.id == project_id)).first()
    auto_run = _running_auto_run(project_id, session)

    base = _log_live_status(project_id, project, session)

    if auto_run is not None:
        # Hay un auto-run en curso: el top bar debe mostrarlo sí o sí (aunque el
        # log de claude todavía no exista — runner recién lo lanzó). Enriquecemos
        # con la fase derivada del log si ya está activo.
        base["active"] = True
        base["auto_run"] = True
        if not base.get("task_ref") and auto_run.task_ref:
            base["task_ref"] = auto_run.task_ref
        base.setdefault("provider", "claude")
        base.setdefault("phase", "starting")
        if base.get("branch") is None:
            base["branch"] = _git_branch(project)
    return base


def _log_live_status(project_id: UUID, project: Project | None, session: Session) -> dict:
    # Sesión más reciente del proyecto en CADA provider; gana la de mtime mayor.
    copilot_f = _newest_session_for_project(project_id, session)
    claude_f = _newest_claude_session_for_project(project)
    candidates: list[tuple[str, Path]] = []
    if copilot_f is not None:
        candidates.append(("copilot", copilot_f))
    if claude_f is not None:
        candidates.append(("claude", claude_f))
    if not candidates:
        return {"active": False}
    provider, f = max(candidates, key=lambda c: _safe_mtime(c[1]))

    age = time.time() - _safe_mtime(f)
    base_inactive = {"active": False, "provider": provider, "session_id": f.stem, "age_seconds": int(age)}
    # Muy viejo → inactivo sin reconstruir.
    if age > _STALE_SKIP_S:
        return base_inactive

    if provider == "claude":
        derived = _derive_claude(_read_claude_tail(f))
    else:
        state = _rebuild_session(f)
        req = _last_request(state) if isinstance(state, dict) else None
        derived = _derive(req) if req is not None else None
    if derived is None:
        return base_inactive

    # Activo si hubo escritura reciente O hay un sub-agente corriendo (su result
    # sigue vacío): en Copilot el sub-agente no toca el archivo padre.
    pending_subagent = derived.get("active_agent") is not None
    active = age < _ACTIVE_WINDOW_S or pending_subagent
    if not active:
        return base_inactive
    out = {
        "active": True,
        "provider": provider,
        "session_id": f.stem,
        "age_seconds": int(age),
        "branch": _git_branch(project),
        "pending_subagent": pending_subagent,
    }
    out.update(derived)
    return out
