"""Audit module — repository-level audit from git history.

Anomalies (direct pushes to base), warnings (oversized branches) and
contributor statistics. Read-only over the mounted target repo.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.models import Project
from app.services.git_audit import container_repo_path, get_audit

router = APIRouter(prefix="/api/projects", tags=["audit"])


class AuditCommit(BaseModel):
    sha: str
    author: str
    date: str
    message: str


class AuditBranch(BaseModel):
    name: str
    files_changed: int
    commits_ahead: int
    last_commit: str
    author: str


class AuditContributor(BaseModel):
    author: str
    commits: int
    insertions: int
    deletions: int
    files_touched: int


class AuditReport(BaseModel):
    available: bool
    reason: str | None = None
    base_branch: str | None = None
    total_commits: int | None = None
    commits_in_window: int | None = None
    branches: int | None = None
    contributors: int | None = None
    last_commit_at: str | None = None
    direct_to_base_total: int | None = None
    direct_to_base_recent: list[AuditCommit] = []
    large_branches: list[AuditBranch] = []
    top_contributors: list[AuditContributor] = []
    thresholds: dict | None = None


@router.get("/{project_id}/audit", response_model=AuditReport)
def project_audit(project_id: UUID, session: Session = Depends(get_session)) -> AuditReport:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    # Audit POR PROYECTO: cada uno desde su propio repo git (no el target global).
    report = get_audit(container_repo_path(project.path))
    return AuditReport(**report)
