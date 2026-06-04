"""agent mentions in docs/tasks (Phase 2 minimum)

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-27 12:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_mentions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("file_path", sa.String(1024), nullable=False),
        sa.Column("source_type", sa.String(50), nullable=False),  # docs | tasks | spec | requirements | other
        sa.Column("line_number", sa.Integer, nullable=True),
        sa.Column("snippet", sa.String(500), nullable=True),
    )
    op.create_index("ix_agent_mentions_project_id", "agent_mentions", ["project_id"])
    op.create_index("ix_agent_mentions_agent_id", "agent_mentions", ["agent_id"])


def downgrade() -> None:
    op.drop_table("agent_mentions")
