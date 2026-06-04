from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel


class AgentMention(SQLModel, table=True):
    __tablename__ = "agent_mentions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    agent_id: UUID = Field(foreign_key="agents.id", index=True)
    file_path: str = Field(max_length=1024)
    source_type: str = Field(max_length=50)  # docs | tasks | spec | requirements | other
    line_number: int | None = None
    snippet: str | None = Field(default=None, max_length=500)
