"""initial schema — projects, agents, sdd docs/tasks, providers, runtime events, llm interactions

Revision ID: 0001
Revises:
Create Date: 2026-05-27 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("path", sa.String(1024), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("last_scanned_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_projects_name", "projects", ["name"])

    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("file_path", sa.String(1024), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("tags", sa.String(500), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_agents_project_id", "agents", ["project_id"])
    op.create_index("ix_agents_name", "agents", ["name"])
    op.create_index("ix_agents_content_hash", "agents", ["content_hash"])

    op.create_table(
        "sdd_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("file_path", sa.String(1024), nullable=False),
        sa.Column("title", sa.String(300), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_sdd_documents_project_id", "sdd_documents", ["project_id"])

    op.create_table(
        "sdd_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("cycle", sa.String(100), nullable=True),
        sa.Column("task_code", sa.String(50), nullable=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("status", sa.String(50), nullable=True),
        sa.Column("file_path", sa.String(1024), nullable=True),
    )
    op.create_index("ix_sdd_tasks_project_id", "sdd_tasks", ["project_id"])
    op.create_index("ix_sdd_tasks_cycle", "sdd_tasks", ["cycle"])
    op.create_index("ix_sdd_tasks_task_code", "sdd_tasks", ["task_code"])

    op.create_table(
        "provider_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("provider", sa.String(50), nullable=False, unique=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("capture_metadata", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("capture_payload", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("capture_response", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "runtime_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=True),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("event_type", sa.String(50), nullable=False),
        sa.Column("timestamp", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("status_code", sa.Integer, nullable=True),
        sa.Column("latency_ms", sa.Integer, nullable=True),
        sa.Column("request_size", sa.Integer, nullable=True),
        sa.Column("response_size", sa.Integer, nullable=True),
        sa.Column("endpoint", sa.String(500), nullable=True),
        sa.Column("error_message", sa.String(1000), nullable=True),
        sa.Column("event_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_index("ix_runtime_events_project_id", "runtime_events", ["project_id"])
    op.create_index("ix_runtime_events_provider", "runtime_events", ["provider"])
    op.create_index("ix_runtime_events_timestamp", "runtime_events", ["timestamp"])

    op.create_table(
        "llm_interactions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("runtime_event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("runtime_events.id"), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("prompt_chars", sa.Integer, nullable=True),
        sa.Column("response_chars", sa.Integer, nullable=True),
        sa.Column("sanitized_prompt", sa.Text, nullable=True),
        sa.Column("sanitized_response", sa.Text, nullable=True),
        sa.Column("detected_agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("agents.id"), nullable=True),
        sa.Column("detected_task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sdd_tasks.id"), nullable=True),
    )
    op.create_index("ix_llm_interactions_runtime_event_id", "llm_interactions", ["runtime_event_id"])
    op.create_index("ix_llm_interactions_provider", "llm_interactions", ["provider"])


def downgrade() -> None:
    op.drop_table("llm_interactions")
    op.drop_table("runtime_events")
    op.drop_table("provider_configs")
    op.drop_table("sdd_tasks")
    op.drop_table("sdd_documents")
    op.drop_table("agents")
    op.drop_table("projects")
