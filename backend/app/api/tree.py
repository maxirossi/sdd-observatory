"""File / Project Explorer + Heatmap.

Construye un árbol del repo etiquetado con cross-info:
- has_agent / has_doc / has_task por path
- mentions_count agregadas por archivo
- runtime_events por archivo (de event_metadata.cwd o file path en mentions)
"""
from collections import defaultdict
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from app.config import settings
from app.db import get_session
from app.models import Agent, AgentMention, Project, SddDocument, SddTask

router = APIRouter(prefix="/api/projects", tags=["explorer"])

# Limita el tamaño del árbol cargado. Para repos enormes paginamos.
MAX_FILES_SCANNED = 50_000

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
    ".pytest_cache",
    "__pycache__",
    ".tox",
    ".venv",
    "venv",
    ".cache",
    ".turbo",
    "coverage",
    ".angular",
    ".tsbuildinfo",
}


# ───────────────────── Schemas ─────────────────────


class TreeNode(BaseModel):
    name: str
    path: str
    type: str  # "dir" | "file"
    children: list["TreeNode"] | None = None
    # Heatmap signal
    mentions: int = 0
    has_agent: bool = False
    has_doc: bool = False
    has_task: bool = False
    file_count: int = 0  # solo dir
    size_bytes: int | None = None  # solo file


class FileInfo(BaseModel):
    path: str
    size_bytes: int
    agents: list[dict]   # [{id, name}]
    documents: list[dict]
    tasks: list[dict]
    mentions: int


# ───────────────────── Helpers ─────────────────────


def _resolve_root(project: Project) -> Path:
    raw = Path(project.path)
    if not raw.exists() and settings.scan_target_host_path == str(raw):
        return Path(settings.scan_target_mount_path)
    return raw


def _annotate_dir(node: dict) -> None:
    """Acumular en cada dir: mentions, file_count y flags has_*"""
    if node["type"] != "dir" or not node.get("children"):
        return
    mentions = 0
    files = 0
    has_agent = False
    has_doc = False
    has_task = False
    for c in node["children"]:
        _annotate_dir(c)
        mentions += c.get("mentions", 0)
        files += c.get("file_count", 0) if c["type"] == "dir" else 1
        has_agent = has_agent or c.get("has_agent", False)
        has_doc = has_doc or c.get("has_doc", False)
        has_task = has_task or c.get("has_task", False)
    node["mentions"] = mentions
    node["file_count"] = files
    node["has_agent"] = has_agent
    node["has_doc"] = has_doc
    node["has_task"] = has_task


# ───────────────────── /tree ─────────────────────


@router.get("/{project_id}/tree", response_model=TreeNode)
def project_tree(
    project_id: UUID,
    max_depth: int = Query(8, ge=1, le=20),
    session: Session = Depends(get_session),
) -> TreeNode:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _resolve_root(project)
    if not root.exists():
        raise HTTPException(status_code=400, detail="Project path not reachable")

    # Cargar metadata una sola vez por path
    agents = session.exec(
        select(Agent.file_path).where(Agent.project_id == project_id)
    ).all()
    docs = session.exec(
        select(SddDocument.file_path).where(SddDocument.project_id == project_id)
    ).all()
    tasks = session.exec(
        select(SddTask.file_path)
        .where(SddTask.project_id == project_id, SddTask.file_path.is_not(None))  # type: ignore[union-attr]
    ).all()

    agent_paths = {p for p in agents}
    doc_paths = {p for p in docs}
    task_paths = {p for p in tasks if p}

    # Mentions agregadas por file_path. Excluimos referencias claude:// porque no
    # son paths del filesystem.
    mention_rows = session.exec(
        select(AgentMention.file_path, func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(
            Agent.project_id == project_id,
            ~AgentMention.file_path.like("claude://%"),  # type: ignore[operator]
        )
        .group_by(AgentMention.file_path)
    ).all()
    mentions_by_path = {p: int(c) for p, c in mention_rows}

    def build(path: Path, depth: int) -> dict | None:
        rel = "" if path == root else str(path.relative_to(root))
        # Skip solo se aplica a subdirectorios, no al root (que puede llamarse
        # "target" por el bind mount).
        if depth > 0 and path.name in SKIP_DIRS:
            return None
        if path.is_file():
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            return {
                "name": path.name,
                "path": rel,
                "type": "file",
                "mentions": mentions_by_path.get(rel, 0),
                "has_agent": rel in agent_paths,
                "has_doc": rel in doc_paths,
                "has_task": rel in task_paths,
                "size_bytes": size,
            }
        if depth >= max_depth:
            return {
                "name": path.name,
                "path": rel,
                "type": "dir",
                "children": [],
                "mentions": 0,
                "file_count": 0,
            }
        try:
            entries = sorted(
                path.iterdir(),
                key=lambda p: (p.is_file(), p.name.lower()),
            )
        except OSError:
            return None
        children: list[dict] = []
        for child in entries:
            built = build(child, depth + 1)
            if built is not None:
                children.append(built)
        return {
            "name": path.name or rel or "root",
            "path": rel,
            "type": "dir",
            "children": children,
        }

    tree = build(root, 0)
    if tree is None:
        raise HTTPException(status_code=500, detail="Could not build tree")
    _annotate_dir(tree)
    tree["name"] = project.name
    return TreeNode(**tree)


# ───────────────────── /file-info ─────────────────────


@router.get("/{project_id}/file-info", response_model=FileInfo)
def file_info(
    project_id: UUID,
    path: str = Query(..., description="Path relativo dentro del proyecto"),
    session: Session = Depends(get_session),
) -> FileInfo:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _resolve_root(project)
    candidate = (root / path).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path outside project root") from exc
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    size = candidate.stat().st_size

    agents = session.exec(
        select(Agent.id, Agent.name).where(
            Agent.project_id == project_id, Agent.file_path == path
        )
    ).all()
    docs = session.exec(
        select(SddDocument.id, SddDocument.title, SddDocument.type).where(
            SddDocument.project_id == project_id, SddDocument.file_path == path
        )
    ).all()
    tasks = session.exec(
        select(SddTask.id, SddTask.title, SddTask.status, SddTask.cycle).where(
            SddTask.project_id == project_id, SddTask.file_path == path
        )
    ).all()
    mentions = session.exec(
        select(func.count(AgentMention.id))
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id, AgentMention.file_path == path)
    ).one()
    mentions = int(mentions[0] if isinstance(mentions, tuple) else mentions)

    return FileInfo(
        path=path,
        size_bytes=size,
        agents=[{"id": str(i), "name": n} for i, n in agents],
        documents=[{"id": str(i), "title": t or "", "type": tp} for i, t, tp in docs],
        tasks=[
            {"id": str(i), "title": t, "status": s, "cycle": c}
            for i, t, s, c in tasks
        ],
        mentions=mentions,
    )


class FileMention(BaseModel):
    agent_id: str
    agent_name: str
    source_type: str  # docs | spec | tasks | runtime_claude_user | ...
    line_number: int | None
    snippet: str | None


@router.get("/{project_id}/file-mentions", response_model=list[FileMention])
def file_mentions(
    project_id: UUID,
    path: str = Query(..., description="Path relativo dentro del proyecto"),
    session: Session = Depends(get_session),
) -> list[FileMention]:
    """Menciones de agentes DENTRO de un archivo: qué agente se nombra, en qué
    línea y con qué contexto (snippet). Permite ver 'cuáles y contra quién'."""
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")

    rows = session.exec(
        select(
            Agent.id,
            Agent.name,
            AgentMention.source_type,
            AgentMention.line_number,
            AgentMention.snippet,
        )
        .join(Agent, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id, AgentMention.file_path == path)
        .order_by(AgentMention.line_number.asc().nulls_last())  # type: ignore[attr-defined]
    ).all()

    return [
        FileMention(
            agent_id=str(aid),
            agent_name=name,
            source_type=st,
            line_number=ln,
            snippet=snip,
        )
        for aid, name, st, ln, snip in rows
    ]


TreeNode.model_rebuild()
