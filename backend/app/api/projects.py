from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from sqlalchemy import func

from app.config import settings
from app.db import get_session
from app.models import Agent, AgentMention, Project, SddDocument, SddTask
from app.services.scanner import persist, scan

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ScanRequest(BaseModel):
    path: str


class ProjectRead(BaseModel):
    id: UUID
    name: str
    path: str
    last_scanned_at: str | None
    agents_count: int
    documents_count: int
    tasks_count: int


class AgentRead(BaseModel):
    id: UUID
    name: str
    file_path: str
    type: str
    description: str | None
    tags: list[str]
    mentions_count: int
    runtime_mentions: int = 0
    doc_mentions: int = 0
    sessions: int = 0
    providers: list[str] = []
    status: str = "inactive"  # active | declared_only | runtime_only | inactive


class AgentMentionRead(BaseModel):
    id: UUID
    file_path: str
    source_type: str
    line_number: int | None
    snippet: str | None


class SddDocumentRead(BaseModel):
    id: UUID
    type: str
    file_path: str
    title: str | None


class SddTaskRead(BaseModel):
    id: UUID
    cycle: str | None
    task_code: str | None
    title: str
    file_path: str | None
    status: str | None = None
    domain: str | None = None


class FileContentRead(BaseModel):
    file_path: str
    size_bytes: int
    truncated: bool
    content: str


MAX_FILE_BYTES = 256 * 1024  # 256 KiB — enough for any agent/doc/task; hard cap to keep payload sane.


class AgentRelatedRead(BaseModel):
    agent: AgentRead
    documents: list[SddDocumentRead]
    tasks: list["SddTaskRead"]
    cycles: list[str]
    runtime_sessions: list[str]


class DocumentRelatedRead(BaseModel):
    document: SddDocumentRead
    cycle: str | None
    agents: list[AgentRead]
    tasks: list["SddTaskRead"]


class TaskRelatedRead(BaseModel):
    task: "SddTaskRead"
    agents: list[AgentRead]
    documents: list[SddDocumentRead]


def _to_project_read(project: Project, session: Session) -> ProjectRead:
    agents = session.exec(select(Agent).where(Agent.project_id == project.id)).all()
    docs = session.exec(select(SddDocument).where(SddDocument.project_id == project.id)).all()
    tasks = session.exec(select(SddTask).where(SddTask.project_id == project.id)).all()
    return ProjectRead(
        id=project.id,
        name=project.name,
        path=project.path,
        last_scanned_at=project.last_scanned_at.isoformat() if project.last_scanned_at else None,
        agents_count=len(agents),
        documents_count=len(docs),
        tasks_count=len(tasks),
    )


@router.get("", response_model=list[ProjectRead])
def list_projects(session: Session = Depends(get_session)) -> list[ProjectRead]:
    projects = session.exec(select(Project)).all()
    return [_to_project_read(p, session) for p in projects]


@router.post("/scan", response_model=ProjectRead)
def trigger_scan(req: ScanRequest, session: Session = Depends(get_session)) -> ProjectRead:
    try:
        result = scan(req.path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    project = persist(result, session)
    return _to_project_read(project, session)


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: UUID, session: Session = Depends(get_session)) -> ProjectRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return _to_project_read(project, session)


@router.get("/{project_id}/agents", response_model=list[AgentRead])
def list_agents(project_id: UUID, session: Session = Depends(get_session)) -> list[AgentRead]:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    agents = session.exec(select(Agent).where(Agent.project_id == project_id)).all()

    # Mentions con source_type + file_path: separamos runtime vs doc, y de las
    # runtime derivamos sessions distintas + providers (del prefijo del path).
    rows = session.exec(
        select(AgentMention.agent_id, AgentMention.source_type, AgentMention.file_path)
        .where(AgentMention.project_id == project_id)
    ).all()

    runtime_c: dict[UUID, int] = {}
    doc_c: dict[UUID, int] = {}
    sessions_by_agent: dict[UUID, set[str]] = {}
    providers_by_agent: dict[UUID, set[str]] = {}

    for aid, source_type, fp in rows:
        is_runtime = bool(source_type and source_type.startswith("runtime_"))
        if is_runtime:
            runtime_c[aid] = runtime_c.get(aid, 0) + 1
            if fp and "://session/" in fp:
                provider = fp.split("://", 1)[0]
                sid = fp.split("://session/", 1)[1].split("#", 1)[0]
                sessions_by_agent.setdefault(aid, set()).add(sid)
                providers_by_agent.setdefault(aid, set()).add(provider)
        else:
            doc_c[aid] = doc_c.get(aid, 0) + 1

    def _status(rt: int, doc: int) -> str:
        if rt > 0 and doc > 0:
            return "active"
        if rt > 0:
            return "runtime_only"
        if doc > 0:
            return "declared_only"
        return "inactive"

    out = [
        AgentRead(
            id=a.id,
            name=a.name,
            file_path=a.file_path,
            type=a.type,
            description=a.description,
            tags=[t for t in (a.tags or "").split(",") if t],
            mentions_count=runtime_c.get(a.id, 0) + doc_c.get(a.id, 0),
            runtime_mentions=runtime_c.get(a.id, 0),
            doc_mentions=doc_c.get(a.id, 0),
            sessions=len(sessions_by_agent.get(a.id, set())),
            providers=sorted(providers_by_agent.get(a.id, set())),
            status=_status(runtime_c.get(a.id, 0), doc_c.get(a.id, 0)),
        )
        for a in agents
    ]
    # Más usados primero: runtime real, después doc.
    out.sort(key=lambda r: (-r.runtime_mentions, -r.doc_mentions, r.name))
    return out


@router.get("/{project_id}/agents/{agent_id}/mentions", response_model=list[AgentMentionRead])
def list_agent_mentions(
    project_id: UUID, agent_id: UUID, session: Session = Depends(get_session)
) -> list[AgentMentionRead]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if session.get(Agent, agent_id) is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    rows = session.exec(
        select(AgentMention).where(
            AgentMention.project_id == project_id, AgentMention.agent_id == agent_id
        )
    ).all()
    return [
        AgentMentionRead(
            id=r.id,
            file_path=r.file_path,
            source_type=r.source_type,
            line_number=r.line_number,
            snippet=r.snippet,
        )
        for r in rows
    ]


@router.get("/{project_id}/documents", response_model=list[SddDocumentRead])
def list_documents(project_id: UUID, session: Session = Depends(get_session)) -> list[SddDocumentRead]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    docs = session.exec(select(SddDocument).where(SddDocument.project_id == project_id)).all()
    return [
        SddDocumentRead(id=d.id, type=d.type, file_path=d.file_path, title=d.title) for d in docs
    ]


@router.get("/{project_id}/tasks", response_model=list[SddTaskRead])
def list_tasks(project_id: UUID, session: Session = Depends(get_session)) -> list[SddTaskRead]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    tasks = session.exec(select(SddTask).where(SddTask.project_id == project_id)).all()
    return [
        SddTaskRead(
            id=t.id,
            cycle=t.cycle,
            task_code=t.task_code,
            title=t.title,
            file_path=t.file_path,
            status=t.status,
            domain=t.domain,
        )
        for t in tasks
    ]


def _agent_to_read(agent: Agent, mentions_count: int) -> AgentRead:
    return AgentRead(
        id=agent.id,
        name=agent.name,
        file_path=agent.file_path,
        type=agent.type,
        description=agent.description,
        tags=[t for t in (agent.tags or "").split(",") if t],
        mentions_count=mentions_count,
    )


def _mentions_count_for(agent_id: UUID, session: Session) -> int:
    total = session.exec(
        select(func.count(AgentMention.id)).where(AgentMention.agent_id == agent_id)
    ).first()
    return int(total or 0)


@router.get("/{project_id}/agents/{agent_id}/related", response_model=AgentRelatedRead)
def get_agent_related(
    project_id: UUID, agent_id: UUID, session: Session = Depends(get_session)
) -> AgentRelatedRead:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    agent = session.get(Agent, agent_id)
    if agent is None or agent.project_id != project_id:
        raise HTTPException(status_code=404, detail="Agent not found")

    mentions = session.exec(
        select(AgentMention).where(AgentMention.agent_id == agent_id)
    ).all()

    file_mention_paths = {m.file_path for m in mentions if not m.file_path.startswith("claude://")}
    runtime_sessions = sorted(
        {m.file_path for m in mentions if m.file_path.startswith("claude://")}
    )

    documents = session.exec(
        select(SddDocument).where(
            SddDocument.project_id == project_id,
            SddDocument.file_path.in_(file_mention_paths),  # type: ignore[attr-defined]
        )
    ).all() if file_mention_paths else []

    tasks_via_mention_files = session.exec(
        select(SddTask).where(
            SddTask.project_id == project_id,
            SddTask.file_path.in_(file_mention_paths),  # type: ignore[attr-defined]
        )
    ).all() if file_mention_paths else []
    # Also include tasks whose title literally references the agent name.
    base = agent.name.replace(".agent", "")
    tasks_by_title = session.exec(
        select(SddTask).where(
            SddTask.project_id == project_id,
            SddTask.title.ilike(f"%{base}%"),  # type: ignore[attr-defined]
        )
    ).all()
    tasks_map = {t.id: t for t in [*tasks_via_mention_files, *tasks_by_title]}
    tasks = list(tasks_map.values())

    cycles = sorted({t.cycle for t in tasks if t.cycle})

    return AgentRelatedRead(
        agent=_agent_to_read(agent, len(mentions)),
        documents=[
            SddDocumentRead(id=d.id, type=d.type, file_path=d.file_path, title=d.title)
            for d in documents
        ],
        tasks=[
            SddTaskRead(
                id=t.id,
                cycle=t.cycle,
                task_code=t.task_code,
                title=t.title,
                file_path=t.file_path,
            status=t.status,
            )
            for t in tasks
        ],
        cycles=cycles,
        runtime_sessions=runtime_sessions,
    )


@router.get("/{project_id}/documents/{document_id}/related", response_model=DocumentRelatedRead)
def get_document_related(
    project_id: UUID, document_id: UUID, session: Session = Depends(get_session)
) -> DocumentRelatedRead:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    doc = session.get(SddDocument, document_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(status_code=404, detail="Document not found")

    # Cycle inferred from path if any.
    cycle: str | None = None
    if doc.file_path:
        import re as _re
        m = _re.search(r"functional/Cycles/([^/]+)/", doc.file_path, _re.IGNORECASE)
        if m:
            cycle = m.group(1)

    # Agents mentioned in this doc.
    mention_rows = session.exec(
        select(AgentMention.agent_id).where(
            AgentMention.project_id == project_id,
            AgentMention.file_path == doc.file_path,
        ).distinct()
    ).all()
    agent_ids = list(mention_rows)
    agents = (
        session.exec(select(Agent).where(Agent.id.in_(agent_ids))).all()  # type: ignore[attr-defined]
        if agent_ids
        else []
    )

    # Tasks living on this doc path (when it's a tasks.md).
    tasks = session.exec(
        select(SddTask).where(
            SddTask.project_id == project_id,
            SddTask.file_path == doc.file_path,
        )
    ).all()

    return DocumentRelatedRead(
        document=SddDocumentRead(id=doc.id, type=doc.type, file_path=doc.file_path, title=doc.title),
        cycle=cycle,
        agents=[_agent_to_read(a, _mentions_count_for(a.id, session)) for a in agents],
        tasks=[
            SddTaskRead(
                id=t.id, cycle=t.cycle, task_code=t.task_code, title=t.title, file_path=t.file_path,
            status=t.status,
            )
            for t in tasks
        ],
    )


@router.get("/{project_id}/tasks/{task_id}/related", response_model=TaskRelatedRead)
def get_task_related(
    project_id: UUID, task_id: UUID, session: Session = Depends(get_session)
) -> TaskRelatedRead:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    task = session.get(SddTask, task_id)
    if task is None or task.project_id != project_id:
        raise HTTPException(status_code=404, detail="Task not found")

    # Agents whose name appears in the task title.
    agents_in_title = session.exec(
        select(Agent).where(Agent.project_id == project_id)
    ).all()
    title_lower = task.title.lower()
    matched_agents: list[Agent] = []
    for a in agents_in_title:
        base = a.name.replace(".agent", "").lower()
        if len(base) >= 3 and base in title_lower:
            matched_agents.append(a)

    # Documents in same cycle as the task (if task has a cycle).
    docs: list[SddDocument] = []
    if task.cycle:
        all_docs = session.exec(
            select(SddDocument).where(SddDocument.project_id == project_id)
        ).all()
        cycle_marker = f"functional/Cycles/{task.cycle}/".lower()
        docs = [d for d in all_docs if cycle_marker in d.file_path.lower()]

    return TaskRelatedRead(
        task=SddTaskRead(
            id=task.id,
            cycle=task.cycle,
            task_code=task.task_code,
            title=task.title,
            file_path=task.file_path,
            status=task.status,
        ),
        agents=[_agent_to_read(a, _mentions_count_for(a.id, session)) for a in matched_agents],
        documents=[
            SddDocumentRead(id=d.id, type=d.type, file_path=d.file_path, title=d.title)
            for d in docs
        ],
    )


@router.get("/{project_id}/file", response_model=FileContentRead)
def read_project_file(
    project_id: UUID,
    path: str = Query(..., description="Path relativo dentro del proyecto"),
    session: Session = Depends(get_session),
) -> FileContentRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # `project.path` se persiste con la ruta del host (para correlacionar con
    # cwd de claude logs). Si estamos en el container, ese path no existe — usamos
    # el bind-mount equivalente.
    raw_root = Path(project.path)
    if not raw_root.exists() and settings.scan_target_host_path:
        if str(raw_root) == settings.scan_target_host_path:
            raw_root = Path(settings.scan_target_mount_path)
    root = raw_root.resolve()
    candidate = (root / path).resolve()

    # Defensa contra path traversal: el resultado tiene que estar dentro de root.
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path outside project root") from exc

    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    size = candidate.stat().st_size
    raw = candidate.read_bytes()[:MAX_FILE_BYTES]
    truncated = size > MAX_FILE_BYTES

    return FileContentRead(
        file_path=path,
        size_bytes=size,
        truncated=truncated,
        content=raw.decode("utf-8", errors="replace"),
    )
