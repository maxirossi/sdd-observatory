from datetime import datetime
from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(index=True, max_length=200)
    path: str = Field(max_length=1024, unique=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_scanned_at: datetime | None = None


class Agent(SQLModel, table=True):
    __tablename__ = "agents"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    name: str = Field(index=True, max_length=200)
    file_path: str = Field(max_length=1024)
    type: str = Field(max_length=50)  # github_agents | claude_md | cursor_rules | other
    description: str | None = Field(default=None, max_length=1000)
    tags: str | None = Field(default=None, max_length=500)  # comma-separated for MVP
    content_hash: str = Field(max_length=64, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class SddDocument(SQLModel, table=True):
    __tablename__ = "sdd_documents"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    type: str = Field(max_length=50)  # spec | tasks | requirements | docs | cycle | other
    file_path: str = Field(max_length=1024)
    title: str | None = Field(default=None, max_length=300)
    content_hash: str = Field(max_length=64)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SddTask(SQLModel, table=True):
    __tablename__ = "sdd_tasks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    cycle: str | None = Field(default=None, max_length=100, index=True)
    task_code: str | None = Field(default=None, max_length=50, index=True)
    title: str = Field(max_length=300)
    status: str | None = Field(default=None, max_length=50)
    file_path: str | None = Field(default=None, max_length=1024)
    # Dominio inferido: backend | frontend | wrapper | devops | e2e | security | api | docs | other | unknown
    domain: str | None = Field(default=None, max_length=32, index=True)
