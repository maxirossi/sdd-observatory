"""agent_runs — cola de auto-ejecución (runner host-side)

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-01 14:00:00

El backend encola jobs (queued); un runner en el host los toma, corre
`claude -p` en el cwd del repo, y reporta el resultado + session_id.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False, server_default="claude"),
        sa.Column("cwd", sa.String(length=500), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("task_ref", sa.String(length=50), nullable=True),
        sa.Column("permission_mode", sa.String(length=50), nullable=False, server_default="acceptEdits"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="queued"),
        sa.Column("session_id", sa.String(length=200), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_runs_project_id", "agent_runs", ["project_id"])
    op.create_index("ix_agent_runs_status", "agent_runs", ["status"])
    op.create_index("ix_agent_runs_created_at", "agent_runs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_runs_created_at", table_name="agent_runs")
    op.drop_index("ix_agent_runs_status", table_name="agent_runs")
    op.drop_index("ix_agent_runs_project_id", table_name="agent_runs")
    op.drop_table("agent_runs")
