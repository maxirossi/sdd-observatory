from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.models import Agent, AgentMention, Project, RuntimeEvent, SddDocument, SddTask

router = APIRouter(prefix="/api/projects", tags=["findings"])


class FindingItem(BaseModel):
    label: str
    detail: str | None = None
    ref_id: str | None = None


class Finding(BaseModel):
    id: str
    title: str
    severity: str  # info | warning | danger
    description: str
    count: int
    items: list[FindingItem]


def _unused_agents(session: Session, project_id: UUID) -> Finding:
    rows = session.exec(
        select(Agent.id, Agent.name, Agent.file_path)
        .outerjoin(AgentMention, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id)
        .group_by(Agent.id, Agent.name, Agent.file_path)
        .having(func.count(AgentMention.id) == 0)
    ).all()
    items = [
        FindingItem(label=name, detail=path, ref_id=str(agent_id))
        for agent_id, name, path in rows
    ]
    return Finding(
        id="unused_agents",
        title="Agentes sin menciones",
        severity="warning" if items else "info",
        description="Agentes declarados que no aparecen referenciados desde ningún documento ni task del proyecto. Candidatos a archivar o consolidar.",
        count=len(items),
        items=items,
    )


def _top_mentioned_agents(session: Session, project_id: UUID, limit: int = 5) -> Finding:
    rows = session.exec(
        select(Agent.id, Agent.name, func.count(AgentMention.id).label("c"))
        .join(AgentMention, AgentMention.agent_id == Agent.id)
        .where(Agent.project_id == project_id)
        .group_by(Agent.id, Agent.name)
        .order_by(func.count(AgentMention.id).desc())
        .limit(limit)
    ).all()
    items = [
        FindingItem(label=name, detail=f"{count} menciones", ref_id=str(agent_id))
        for agent_id, name, count in rows
    ]
    return Finding(
        id="top_mentioned",
        title="Agentes más mencionados",
        severity="info",
        description="Top agentes por cantidad de menciones en docs y tasks. Útil para identificar el núcleo del proceso SDD.",
        count=len(items),
        items=items,
    )


def _untyped_tasks(session: Session, project_id: UUID) -> Finding:
    rows = session.exec(
        select(SddTask.id, SddTask.title, SddTask.file_path)
        .where(SddTask.project_id == project_id)
        .where(SddTask.task_code.is_(None))  # type: ignore[union-attr]
    ).all()
    items = [
        FindingItem(label=title[:120], detail=file_path or "", ref_id=str(task_id))
        for task_id, title, file_path in rows
    ]
    return Finding(
        id="untyped_tasks",
        title="Tasks sin código",
        severity="info" if not items else "warning",
        description="Líneas detectadas como tasks pero sin un code (T123 / HU-XX-FE) que las identifique. Posibles tareas sin trazabilidad.",
        count=len(items),
        items=items,
    )


def _orphan_docs(session: Session, project_id: UUID, max_items: int = 20) -> Finding:
    mentioned_paths = set(
        session.exec(
            select(AgentMention.file_path).where(AgentMention.project_id == project_id).distinct()
        ).all()
    )
    docs = session.exec(
        select(SddDocument.id, SddDocument.title, SddDocument.file_path)
        .where(SddDocument.project_id == project_id)
    ).all()
    orphan = [
        FindingItem(
            label=(title or file_path)[:140],
            detail=file_path,
            ref_id=str(doc_id),
        )
        for doc_id, title, file_path in docs
        if file_path not in mentioned_paths
    ]
    return Finding(
        id="orphan_docs",
        title="Documentos sin agentes referenciados",
        severity="info",
        description="Documentos SDD que no mencionan a ningún agente declarado. Puede indicar contenido legacy o fuera de scope del proceso agéntico.",
        count=len(orphan),
        items=orphan[:max_items],
    )


def _runtime_last_24h(session: Session, project_id: UUID) -> Finding:
    threshold = datetime.utcnow() - timedelta(hours=24)
    total = session.exec(
        select(func.count(RuntimeEvent.id))
        .where(RuntimeEvent.project_id == project_id)
        .where(RuntimeEvent.timestamp >= threshold)
    ).first()
    count = int(total or 0)
    label = f"{count} eventos en las últimas 24h"
    return Finding(
        id="runtime_last_24h",
        title="Actividad runtime reciente",
        severity="info",
        description="Cantidad de runtime_events asociados al proyecto en las últimas 24h. Usar para detectar picos o silencios.",
        count=count,
        items=[FindingItem(label=label)] if count else [],
    )


@router.get("/{project_id}/findings", response_model=list[Finding])
def get_findings(project_id: UUID, session: Session = Depends(get_session)) -> list[Finding]:
    if session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [
        _unused_agents(session, project_id),
        _top_mentioned_agents(session, project_id),
        _untyped_tasks(session, project_id),
        _orphan_docs(session, project_id),
        _runtime_last_24h(session, project_id),
    ]
