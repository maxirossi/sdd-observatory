from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, case
from sqlmodel import Session, select

from app.db import get_session
from app.models import Agent, AgentMention, Project, RuntimeEvent

router = APIRouter(prefix="/api/projects", tags=["usage"])


class AgentUsageRow(BaseModel):
    agent_id: UUID
    name: str
    type: str
    doc_mentions: int
    runtime_mentions: int
    total_mentions: int
    declared_only: bool   # has docs but zero runtime
    runtime_only: bool    # impossible today (runtime mentions are tied to declared agents); reserved


class ProviderShare(BaseModel):
    provider: str
    events: int


class DailyBucket(BaseModel):
    day: datetime
    provider: str
    events: int


class UsageRead(BaseModel):
    project_id: UUID
    last_scanned_at: datetime | None
    agents_total: int
    agents_with_runtime_mentions: int
    agents_without_any_mentions: int
    most_used_runtime: AgentUsageRow | None
    least_used_declared: AgentUsageRow | None
    top_agents: list[AgentUsageRow]
    provider_share: list[ProviderShare]
    daily_activity: list[DailyBucket]


@router.get("/{project_id}/usage", response_model=UsageRead)
def get_usage(
    project_id: UUID,
    days: int = Query(30, ge=1, le=365),
    top_n: int = Query(15, ge=1, le=100),
    session: Session = Depends(get_session),
) -> UsageRead:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Per-agent mention counts split by origin (docs/spec/tasks/etc vs runtime_*).
    runtime_filter = AgentMention.source_type.like("runtime_claude%")  # type: ignore[attr-defined]
    rows = session.exec(
        select(
            Agent.id,
            Agent.name,
            Agent.type,
            func.sum(case((runtime_filter, 0), else_=1)).label("doc_mentions"),
            func.sum(case((runtime_filter, 1), else_=0)).label("runtime_mentions"),
        )
        .join(AgentMention, AgentMention.agent_id == Agent.id, isouter=True)
        .where(Agent.project_id == project_id)
        .group_by(Agent.id, Agent.name, Agent.type)
    ).all()

    usage_rows: list[AgentUsageRow] = []
    for agent_id, name, atype, doc_c, run_c in rows:
        doc_c = int(doc_c or 0)
        run_c = int(run_c or 0)
        usage_rows.append(
            AgentUsageRow(
                agent_id=agent_id,
                name=name,
                type=atype,
                doc_mentions=doc_c,
                runtime_mentions=run_c,
                total_mentions=doc_c + run_c,
                declared_only=doc_c > 0 and run_c == 0,
                runtime_only=doc_c == 0 and run_c > 0,
            )
        )

    # Sorting helpers.
    by_runtime = sorted(usage_rows, key=lambda r: -r.runtime_mentions)
    by_declared = sorted(usage_rows, key=lambda r: (r.runtime_mentions, -r.doc_mentions))

    most_used = by_runtime[0] if by_runtime and by_runtime[0].runtime_mentions > 0 else None
    least_used_declared = next(
        (r for r in by_declared if r.declared_only),
        None,
    )

    # Provider share — last `days` days.
    threshold = datetime.utcnow() - timedelta(days=days)
    share_rows = session.exec(
        select(RuntimeEvent.provider, func.count(RuntimeEvent.id))
        .where(RuntimeEvent.project_id == project_id, RuntimeEvent.timestamp >= threshold)
        .group_by(RuntimeEvent.provider)
        .order_by(func.count(RuntimeEvent.id).desc())
    ).all()
    provider_share = [ProviderShare(provider=p, events=int(c)) for p, c in share_rows]

    # Daily activity per provider.
    day_bucket = func.date_trunc("day", RuntimeEvent.timestamp).label("day")
    daily_rows = session.exec(
        select(day_bucket, RuntimeEvent.provider, func.count(RuntimeEvent.id))
        .where(RuntimeEvent.project_id == project_id, RuntimeEvent.timestamp >= threshold)
        .group_by(day_bucket, RuntimeEvent.provider)
        .order_by(day_bucket.asc())
    ).all()
    daily_activity = [
        DailyBucket(day=d, provider=p, events=int(c)) for d, p, c in daily_rows
    ]

    return UsageRead(
        project_id=project_id,
        last_scanned_at=project.last_scanned_at,
        agents_total=len(usage_rows),
        agents_with_runtime_mentions=sum(1 for r in usage_rows if r.runtime_mentions > 0),
        agents_without_any_mentions=sum(1 for r in usage_rows if r.total_mentions == 0),
        most_used_runtime=most_used,
        least_used_declared=least_used_declared,
        top_agents=by_runtime[:top_n],
        provider_share=provider_share,
        daily_activity=daily_activity,
    )
