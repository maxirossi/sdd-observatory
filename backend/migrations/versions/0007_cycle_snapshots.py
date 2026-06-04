"""cycle_snapshots — progreso por ciclo en el tiempo

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-29 12:00:00

Una fila por (proyecto, ciclo) en cada re-scan → permite calcular el avance del
ciclo en una ventana de tiempo (última semana, 24h, etc.).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "cycle_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("cycle", sa.String(length=100), nullable=False),
        sa.Column("done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("in_progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pending", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unknown", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cycle_snapshots_project_id", "cycle_snapshots", ["project_id"])
    op.create_index("ix_cycle_snapshots_cycle", "cycle_snapshots", ["cycle"])
    op.create_index("ix_cycle_snapshots_captured_at", "cycle_snapshots", ["captured_at"])


def downgrade() -> None:
    op.drop_index("ix_cycle_snapshots_captured_at", table_name="cycle_snapshots")
    op.drop_index("ix_cycle_snapshots_cycle", table_name="cycle_snapshots")
    op.drop_index("ix_cycle_snapshots_project_id", table_name="cycle_snapshots")
    op.drop_table("cycle_snapshots")
