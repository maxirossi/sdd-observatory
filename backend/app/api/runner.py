"""Auto-ejecución (runner host-side).

El backend corre en container con el target montado :ro y SIN claude/keys → NO
ejecuta agentes. Solo expone una COLA: la UI encola un job (`claude -p <prompt>`)
y un runner en el host (scripts/observatory-runner.py) lo toma, lo corre en el
cwd del repo y reporta el resultado + session_id (que linkea con el log ingestado).

Gate de seguridad: por defecto solo se permite encolar sobre el fixture lab
(settings.sdd_lab_host_path), nunca sobre el target real.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from app.config import settings
from app.db import get_session
from app.models import AgentRun, Project

router = APIRouter(prefix="/api/runner", tags=["runner"])


# ───────────────────── Schemas ─────────────────────


class RunCreate(BaseModel):
    project_id: UUID
    prompt: str
    task_ref: str | None = None
    permission_mode: str = "acceptEdits"


class RunComplete(BaseModel):
    status: str  # done | error
    session_id: str | None = None
    exit_code: int | None = None
    error: str | None = None


class RunRow(BaseModel):
    id: UUID
    project_id: UUID
    provider: str
    cwd: str
    prompt: str
    task_ref: str | None
    permission_mode: str
    status: str
    session_id: str | None
    exit_code: int | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


def _row(r: AgentRun) -> RunRow:
    return RunRow(**{k: getattr(r, k) for k in RunRow.model_fields})


def _is_lab(project: Project) -> bool:
    lab = settings.sdd_lab_host_path
    if lab and project.path == lab:
        return True
    # fallback por nombre del fixture
    return project.name.strip().lower() in ("sdd-template-lab", "sdd-lab")


# ───────────────────── Estado del runner ─────────────────────


class RunnerStatus(BaseModel):
    enabled: bool
    lab_only: bool
    lab_path: str | None
    queued: int
    running: int


@router.get("/status", response_model=RunnerStatus)
def runner_status(session: Session = Depends(get_session)) -> RunnerStatus:
    from sqlalchemy import func

    counts = dict(
        session.exec(
            select(AgentRun.status, func.count(AgentRun.id)).group_by(AgentRun.status)
        ).all()
    )
    return RunnerStatus(
        enabled=settings.runner_enabled,
        lab_only=settings.runner_lab_only,
        lab_path=settings.sdd_lab_host_path,
        queued=int(counts.get("queued", 0)),
        running=int(counts.get("running", 0)),
    )


# ───────────────────── Encolar (UI) ─────────────────────


@router.post("/jobs", response_model=RunRow)
def enqueue(body: RunCreate, session: Session = Depends(get_session)) -> RunRow:
    if not settings.runner_enabled:
        raise HTTPException(status_code=403, detail="Runner deshabilitado (runner_enabled=false).")
    project = session.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if settings.runner_lab_only and not _is_lab(project):
        raise HTTPException(
            status_code=403,
            detail="Auto-ejecución restringida al fixture lab (runner_lab_only=true).",
        )
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="prompt vacío")
    # Solo claude por ahora (único provider disparable headless).
    run = AgentRun(
        project_id=project.id,
        provider="claude",
        cwd=project.path,
        prompt=prompt,
        task_ref=body.task_ref,
        permission_mode=body.permission_mode or "acceptEdits",
        status="queued",
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return _row(run)


@router.get("/jobs", response_model=list[RunRow])
def list_jobs(
    project_id: UUID | None = None,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[RunRow]:
    stmt = select(AgentRun)
    if project_id:
        stmt = stmt.where(AgentRun.project_id == project_id)
    if status:
        stmt = stmt.where(AgentRun.status == status)
    stmt = stmt.order_by(AgentRun.created_at.desc()).limit(limit)  # type: ignore[attr-defined]
    return [_row(r) for r in session.exec(stmt).all()]


@router.post("/jobs/{run_id}/cancel", response_model=RunRow)
def cancel(run_id: UUID, session: Session = Depends(get_session)) -> RunRow:
    run = session.get(AgentRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status == "queued":
        run.status = "canceled"
        run.ended_at = datetime.utcnow()
        session.add(run)
        session.commit()
        session.refresh(run)
    return _row(run)


# ───────────────────── Runner host-side (poll → claim → complete) ─────────────


@router.post("/jobs/{run_id}/claim", response_model=RunRow)
def claim(run_id: UUID, session: Session = Depends(get_session)) -> RunRow:
    """El runner toma un job queued → running (idempotente: si ya no está queued,
    devuelve 409 para que el runner lo saltee)."""
    run = session.get(AgentRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "queued":
        raise HTTPException(status_code=409, detail=f"Run no está queued (status={run.status})")
    run.status = "running"
    run.started_at = datetime.utcnow()
    session.add(run)
    session.commit()
    session.refresh(run)
    return _row(run)


@router.post("/jobs/{run_id}/complete", response_model=RunRow)
def complete(run_id: UUID, body: RunComplete, session: Session = Depends(get_session)) -> RunRow:
    run = session.get(AgentRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    run.status = body.status if body.status in ("done", "error") else "error"
    run.session_id = body.session_id
    run.exit_code = body.exit_code
    run.error = body.error
    run.ended_at = datetime.utcnow()
    session.add(run)
    session.commit()
    session.refresh(run)
    return _row(run)
