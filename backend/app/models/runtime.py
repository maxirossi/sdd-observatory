from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


class AgentRun(SQLModel, table=True):
    """Job de auto-ejecución. El backend lo ENCOLA (status=queued); un runner
    host-side lo toma (claim → running), corre `claude -p <prompt>` en `cwd`, y
    reporta (done/error) con el session_id capturado para linkear con el log.
    El backend nunca ejecuta — solo es la cola/estado."""

    __tablename__ = "agent_runs"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    provider: str = Field(default="claude", max_length=50)
    cwd: str = Field(max_length=500)  # path host donde corre el agente
    prompt: str
    task_ref: str | None = Field(default=None, max_length=50)
    permission_mode: str = Field(default="acceptEdits", max_length=50)
    status: str = Field(default="queued", max_length=20, index=True)  # queued|running|done|error|canceled
    session_id: str | None = Field(default=None, max_length=200)
    exit_code: int | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    started_at: datetime | None = None
    ended_at: datetime | None = None


class ProviderConfig(SQLModel, table=True):
    __tablename__ = "provider_configs"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    provider: str = Field(max_length=50, unique=True, index=True)
    enabled: bool = False
    capture_metadata: bool = True
    capture_payload: bool = False
    capture_response: bool = False
    updated_at: datetime = Field(default_factory=datetime.utcnow)


RUNTIME_SOURCE_KINDS = ("project_scan", "local_logs", "network_proxy", "manual_import")


class RuntimeEvent(SQLModel, table=True):
    __tablename__ = "runtime_events"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID | None = Field(default=None, foreign_key="projects.id", index=True)
    provider: str = Field(max_length=50, index=True)
    # Origen del registro. Ver RUNTIME_SOURCE_KINDS para los valores válidos.
    source_kind: str = Field(default="local_logs", max_length=32, index=True)
    event_type: str = Field(max_length=50)  # request | response | error | heartbeat | user | assistant | tool_use | tool_result
    timestamp: datetime = Field(default_factory=datetime.utcnow, index=True)
    status_code: int | None = None
    latency_ms: int | None = None
    request_size: int | None = None
    response_size: int | None = None
    endpoint: str | None = Field(default=None, max_length=500)
    error_message: str | None = Field(default=None, max_length=1000)
    external_id: str | None = Field(default=None, max_length=200, index=True)
    event_metadata: dict | None = Field(default=None, sa_column=Column(JSONB))


class LlmInteraction(SQLModel, table=True):
    __tablename__ = "llm_interactions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    runtime_event_id: UUID = Field(foreign_key="runtime_events.id", index=True)
    provider: str = Field(max_length=50, index=True)
    model: str | None = Field(default=None, max_length=100)
    prompt_chars: int | None = None
    response_chars: int | None = None
    sanitized_prompt: str | None = None
    sanitized_response: str | None = None
    detected_agent_id: UUID | None = Field(default=None, foreign_key="agents.id")
    detected_task_id: UUID | None = Field(default=None, foreign_key="sdd_tasks.id")


class CycleSnapshot(SQLModel, table=True):
    """Foto del progreso de un ciclo en un momento dado. Una fila por (proyecto,
    ciclo) en cada re-scan. Permite calcular el avance en una ventana de tiempo."""

    __tablename__ = "cycle_snapshots"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    cycle: str = Field(max_length=100, index=True)
    done: int = 0
    in_progress: int = 0
    pending: int = 0
    unknown: int = 0
    total: int = 0
    captured_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class AgentInvocation(SQLModel, table=True):
    """Delegación REAL de un agente — la señal de intervención efectiva.

    A diferencia de `AgentMention` (nombre del agente aparece en el texto, señal
    débil con falsos positivos), esto se deriva de la herramienta de delegación
    del orchestrator: `runSubagent` en Copilot (`toolSpecificData.kind ==
    "subagent"`), o el `Task` tool en Claude. Cada fila es un sub-agente que
    efectivamente se ejecutó por orden del agente padre.
    """

    __tablename__ = "agent_invocations"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    project_id: UUID = Field(foreign_key="projects.id", index=True)
    # agent_id puede ser None: el agentName delegado puede no corresponder a un
    # agent declarado del repo (p.ej. "Explore", "frontend-tdd").
    agent_id: UUID | None = Field(default=None, foreign_key="agents.id", index=True)
    agent_name: str = Field(max_length=200, index=True)  # raw agentName delegado
    provider: str = Field(max_length=50, index=True)  # copilot | claude
    tool: str = Field(max_length=50)  # runSubagent | Task
    session_id: str | None = Field(default=None, max_length=200, index=True)
    request_id: str | None = Field(default=None, max_length=200)
    runtime_event_id: UUID | None = Field(
        default=None, foreign_key="runtime_events.id", index=True
    )
    # Idempotencia: (provider, external_id) único.
    external_id: str = Field(max_length=300, index=True)
    description: str | None = Field(default=None, max_length=1000)
    model: str | None = Field(default=None, max_length=100)
    prompt_chars: int | None = None
    result_chars: int | None = None
    # Solo poblados si privacy_mode lo permite (sanitized_payload/raw_local_only).
    sanitized_prompt: str | None = None
    sanitized_result: str | None = None
    order_index: int = Field(default=0)
    timestamp: datetime = Field(default_factory=datetime.utcnow, index=True)
