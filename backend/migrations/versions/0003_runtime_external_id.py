"""runtime_events: external_id for idempotent ingest

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-27 13:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("runtime_events", sa.Column("external_id", sa.String(200), nullable=True))
    op.create_index(
        "ix_runtime_events_external_id_unique",
        "runtime_events",
        ["provider", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_runtime_events_external_id_unique", table_name="runtime_events")
    op.drop_column("runtime_events", "external_id")
