"""Ingest VS Code Copilot logs.

VS Code writes Copilot extension logs at
`~/.config/Code/logs/<session>/window*/exthost/GitHub.copilot*/...log`.

Files we care about:

  - `GitHub Copilot Chat.log`      — chat / panel / inline agent requests
  - `GitHub Copilot.log`           — autocomplete (inline completions)
  - `output_logging_*/*.log`       — code references / lab logs

Each request leaves a line like:

  2026-05-22 17:17:19.667 [info] ccreq:82db6c75.copilotmd | success | \
    claude-opus-4.5 -> claude-opus-4-5-20251101 | 7685ms | [panel/editAgent]

We parse those into RuntimeEvent rows with provider='copilot'. The `ccreq:<id>`
acts as our external_id for idempotency.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, select

from app.models import LlmInteraction, Project, RuntimeEvent

PROVIDER = "copilot"

# Paths inside Code's own install directories are noise, not workspace hints.
_USER_PATH_RE = re.compile(r"file://(?P<path>/home/[^\s\"'?#]+)")
_NOISE_PREFIXES = ("/usr/", "/snap/", "/opt/", "/proc/")

# Captures every line where Copilot finalises a request.
_CCREQ_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+"
    r"\[(?P<level>info|warn|warning|error|debug)\]\s+"
    r"ccreq:(?P<id>[a-f0-9]+)(?:\.\w+)?\s*\|\s*"
    r"(?P<status>\w+)\s*\|\s*"
    r"(?P<model>[^|]+?)\s*\|\s*"
    r"(?P<latency>\d+)ms\s*\|\s*"
    r"\[(?P<endpoint>[^\]]+)\]",
    re.MULTILINE,
)


@dataclass
class IngestStats:
    files_seen: int = 0
    lines_seen: int = 0
    events_inserted: int = 0
    interactions_inserted: int = 0
    skipped: int = 0


def _parse_ts(value: str) -> datetime:
    """VS Code logs traen timestamps sin TZ en hora local del host.

    El resto del sistema persiste timestamps naive como si fueran UTC. Para que
    `now() AT TIME ZONE 'UTC' - timestamp` no de offsets falsos, interpretamos
    el string como hora local (de la TZ configurada en settings.log_timezone) y
    lo convertimos a UTC naive antes de persistir.
    """
    try:
        local_naive = datetime.strptime(value, "%Y-%m-%d %H:%M:%S.%f")
    except ValueError:
        return datetime.utcnow()
    try:
        from zoneinfo import ZoneInfo
        from app.config import settings

        local = local_naive.replace(tzinfo=ZoneInfo(settings.log_timezone))
        return local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    except Exception:
        # Si zoneinfo no resuelve la TZ, mejor degradar a wall-clock UTC actual
        # que persistir 3h de offset escondido.
        return datetime.utcnow()


def _detect_window_workspace(window_dir: Path) -> str | None:
    """Best-effort inference of the workspace directory for a given VS Code window.

    Strategy: collect every `file:///home/...` referenced in `renderer.log` and
    the chat log (skipping noise prefixes), then take the longest common path
    prefix. This is robust to many extensions each writing their own paths.
    """
    candidate_files = [window_dir / "renderer.log"]
    for p in window_dir.glob("exthost/GitHub.copilot*/*.log"):
        candidate_files.append(p)
    seen_paths: list[list[str]] = []
    for f in candidate_files:
        if not f.is_file():
            continue
        try:
            text_blob = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in _USER_PATH_RE.finditer(text_blob):
            path = m.group("path")
            if any(path.startswith(noise) for noise in _NOISE_PREFIXES):
                continue
            parts = path.split("/")
            # Drop the trailing filename (or last directory if no extension) —
            # we want to keep up to the deepest stable directory.
            if "." in parts[-1]:
                parts = parts[:-1]
            seen_paths.append(parts)
            if len(seen_paths) > 200:
                break
        if len(seen_paths) > 200:
            break

    if not seen_paths:
        return None

    # Longest common prefix of split path parts.
    common = seen_paths[0]
    for other in seen_paths[1:]:
        n = 0
        while n < len(common) and n < len(other) and common[n] == other[n]:
            n += 1
        common = common[:n]
        if len(common) <= 2:
            break
    if len(common) < 3:  # at least /home/<user>/<something>
        return None
    return "/".join(common)


def _project_for_workspace(
    workspace: str | None, projects: list[Project]
) -> Project | None:
    """El workspace solo cuenta si está IGUAL o ADENTRO del project.path.

    No al revés: si el workspace detectado es más general (ej. el LCP cayó en
    `/home/<user>` porque la ventana tocó archivos de varios
    proyectos), NO atribuimos al target — es ruido cruzado.
    """
    if not workspace:
        return None
    candidates = sorted(projects, key=lambda p: len(p.path or ""), reverse=True)
    for p in candidates:
        if not p.path:
            continue
        if workspace == p.path or workspace.startswith(p.path + os.sep):
            return p
    return None


def _iter_log_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    candidates: list[Path] = []
    for pattern in (
        "**/GitHub Copilot Chat.log",
        "**/GitHub Copilot.log",
        "**/GitHub.copilot/*.log",
        "**/GitHub.copilot-chat/*.log",
        "**/output_logging_*/*Copilot*.log",
    ):
        candidates.extend(root.glob(pattern))
    seen: set[Path] = set()
    for c in candidates:
        if c.is_file() and c not in seen:
            seen.add(c)
            yield c


def ingest_path(root_path: str | Path, session: Session) -> IngestStats:
    root = Path(root_path).resolve()
    stats = IngestStats()
    if not root.exists():
        return stats

    projects = session.exec(select(Project)).all()
    # Cache window_dir -> Project lookup so we only sniff each window once.
    window_project_cache: dict[Path, UUID | None] = {}

    def _resolve_project_id(file_path: Path) -> UUID | None:
        # Walk up to find the window<N> directory containing this log file.
        window_dir: Path | None = None
        for parent in file_path.parents:
            if parent.name.startswith("window"):
                window_dir = parent
                break
        if window_dir is None:
            return None
        if window_dir in window_project_cache:
            return window_project_cache[window_dir]
        workspace = _detect_window_workspace(window_dir)
        project = _project_for_workspace(workspace, projects)
        pid = project.id if project else None
        window_project_cache[window_dir] = pid
        return pid

    for file in _iter_log_files(root):
        stats.files_seen += 1
        try:
            text_blob = file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        project_id = _resolve_project_id(file)
        # Sin proyecto = ventana de VS Code que no estuvo en un repo scaneado.
        # Lo descartamos completo para no contaminar el dashboard con eventos
        # de cualquier otra carpeta donde el usuario haya estado.
        if project_id is None:
            stats.skipped += 1
            continue
        # The parser only inspects the lines we care about; we still bump
        # lines_seen with the full file count for transparency.
        stats.lines_seen += text_blob.count("\n")

        for m in _CCREQ_RE.finditer(text_blob):
            external_id = f"copilot:{m.group('id')}"
            ts = _parse_ts(m.group("ts"))
            status_text = m.group("status").lower()
            endpoint = m.group("endpoint").strip()
            latency = int(m.group("latency"))
            # Model field may include both alias and resolved: "alias -> resolved".
            model_field = m.group("model").strip()
            if "->" in model_field:
                alias, resolved = (p.strip() for p in model_field.split("->", 1))
            else:
                alias, resolved = model_field, model_field

            event_type = "request" if status_text == "success" else "error"
            error_msg = None if status_text == "success" else f"status={status_text}"

            stmt = (
                pg_insert(RuntimeEvent.__table__)
                .values(
                    project_id=project_id,
                    provider=PROVIDER,
                    source_kind="local_logs",
                    event_type=event_type,
                    timestamp=ts,
                    status_code=200 if status_text == "success" else 500,
                    latency_ms=latency,
                    endpoint=endpoint,
                    error_message=error_msg,
                    external_id=external_id,
                    event_metadata={
                        "model_alias": alias,
                        "model_resolved": resolved,
                        "source_file": file.name,
                    },
                )
                .on_conflict_do_nothing(
                    index_elements=["provider", "external_id"],
                    index_where=text("external_id IS NOT NULL"),
                )
                .returning(RuntimeEvent.__table__.c.id)
            )
            inserted_id = session.exec(stmt).first()
            if inserted_id is None:
                continue
            stats.events_inserted += 1

            session.add(
                LlmInteraction(
                    runtime_event_id=inserted_id[0],
                    provider=PROVIDER,
                    model=resolved,
                )
            )
            stats.interactions_inserted += 1

    session.commit()
    return stats
