"""sdd_tasks.domain

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-27 20:00:00

Dominio inferido por scanner: backend, frontend, wrapper, devops, e2e,
security, api, docs, other, unknown.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sdd_tasks", sa.Column("domain", sa.String(32), nullable=True))
    op.create_index("ix_sdd_tasks_domain", "sdd_tasks", ["domain"])


def downgrade() -> None:
    op.drop_index("ix_sdd_tasks_domain", table_name="sdd_tasks")
    op.drop_column("sdd_tasks", "domain")
