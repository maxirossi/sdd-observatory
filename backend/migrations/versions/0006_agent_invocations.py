"""agent_invocations — delegaciones reales de sub-agentes

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-28 16:30:00

Señal de intervención EFECTIVA de un agente: derivada de la herramienta de
delegación del orchestrator (runSubagent en Copilot, Task en Claude), no del
match de texto del nombre (que da falsos positivos, ver agent_mentions).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_invocations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=True),
        sa.Column("agent_name", sa.String(length=200), nullable=False),
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("tool", sa.String(length=50), nullable=False),
        sa.Column("session_id", sa.String(length=200), nullable=True),
        sa.Column("request_id", sa.String(length=200), nullable=True),
        sa.Column("runtime_event_id", sa.Uuid(), nullable=True),
        sa.Column("external_id", sa.String(length=300), nullable=False),
        sa.Column("description", sa.String(length=1000), nullable=True),
        sa.Column("model", sa.String(length=100), nullable=True),
        sa.Column("prompt_chars", sa.Integer(), nullable=True),
        sa.Column("result_chars", sa.Integer(), nullable=True),
        sa.Column("sanitized_prompt", sa.String(), nullable=True),
        sa.Column("sanitized_result", sa.String(), nullable=True),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"]),
        sa.ForeignKeyConstraint(["runtime_event_id"], ["runtime_events.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_invocations_project_id", "agent_invocations", ["project_id"])
    op.create_index("ix_agent_invocations_agent_id", "agent_invocations", ["agent_id"])
    op.create_index("ix_agent_invocations_agent_name", "agent_invocations", ["agent_name"])
    op.create_index("ix_agent_invocations_provider", "agent_invocations", ["provider"])
    op.create_index("ix_agent_invocations_session_id", "agent_invocations", ["session_id"])
    op.create_index(
        "ix_agent_invocations_runtime_event_id", "agent_invocations", ["runtime_event_id"]
    )
    op.create_index("ix_agent_invocations_timestamp", "agent_invocations", ["timestamp"])
    # Idempotencia del re-ingest: una invocación por (provider, external_id).
    op.create_unique_constraint(
        "uq_agent_invocations_provider_external_id",
        "agent_invocations",
        ["provider", "external_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_agent_invocations_provider_external_id", "agent_invocations", type_="unique"
    )
    op.drop_index("ix_agent_invocations_timestamp", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_runtime_event_id", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_session_id", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_provider", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_agent_name", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_agent_id", table_name="agent_invocations")
    op.drop_index("ix_agent_invocations_project_id", table_name="agent_invocations")
    op.drop_table("agent_invocations")
