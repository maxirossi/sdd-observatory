"""runtime_events.source_kind taxonomy

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-27 18:50:00

Distingue origen de cada RuntimeEvent. Valores admitidos:
- project_scan   (eventos derivados del scanner de repo)
- local_logs     (Claude / Copilot leídos del filesystem)
- network_proxy  (proxy HTTP local — todavía no implementado)
- manual_import  (JSON/CSV/dumps cargados a mano)

Backfill: todo lo persistido hasta hoy proviene de logs locales.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "runtime_events",
        sa.Column("source_kind", sa.String(32), nullable=False, server_default="local_logs"),
    )
    op.create_index("ix_runtime_events_source_kind", "runtime_events", ["source_kind"])


def downgrade() -> None:
    op.drop_index("ix_runtime_events_source_kind", table_name="runtime_events")
    op.drop_column("runtime_events", "source_kind")
