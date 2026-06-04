"""Snapshots de progreso por ciclo — se graban en cada re-scan para poder
calcular el avance en una ventana de tiempo."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, select

from app.models import CycleSnapshot, Project, SddTask


def _cycle_counts(project_id: UUID, session: Session) -> dict[str, dict[str, int]]:
    rows = session.exec(
        select(SddTask.cycle, SddTask.status, func.count(SddTask.id))
        .where(SddTask.project_id == project_id, SddTask.cycle.is_not(None))  # type: ignore[union-attr]
        .group_by(SddTask.cycle, SddTask.status)
    ).all()
    out: dict[str, dict[str, int]] = {}
    for cyc, status, count in rows:
        b = out.setdefault(cyc, {"done": 0, "in_progress": 0, "pending": 0, "unknown": 0, "total": 0})
        n = int(count)
        key = status if status in ("done", "in_progress", "pending") else "unknown"
        b[key] += n
        b["total"] += n
    return out


def record_cycle_snapshots(project_id: UUID, session: Session, now: datetime | None = None) -> int:
    """Graba una fila por ciclo con el progreso actual. Devuelve cuántas grabó."""
    counts = _cycle_counts(project_id, session)
    ts = now or datetime.utcnow()
    n = 0
    for cyc, c in counts.items():
        session.add(
            CycleSnapshot(
                project_id=project_id,
                cycle=cyc,
                done=c["done"],
                in_progress=c["in_progress"],
                pending=c["pending"],
                unknown=c["unknown"],
                total=c["total"],
                captured_at=ts,
            )
        )
        n += 1
    session.commit()
    return n


def record_all_projects(session: Session) -> int:
    total = 0
    for p in session.exec(select(Project)).all():
        total += record_cycle_snapshots(p.id, session)
    return total
