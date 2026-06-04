"""Runtime capture — provider-agnostic interface.

Each provider implements `ProviderAdapter`. The runtime collector iterates
over enabled adapters and pushes ParsedEvents into the same `runtime_events`
table, keeping a single normalized shape for downstream queries.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

from sqlmodel import Session

# Valores válidos del campo runtime_events.source_kind.
SOURCE_KIND_LOCAL_LOGS = "local_logs"
SOURCE_KIND_NETWORK_PROXY = "network_proxy"
SOURCE_KIND_PROJECT_SCAN = "project_scan"
SOURCE_KIND_MANUAL_IMPORT = "manual_import"


@dataclass
class ParsedEvent:
    """Shape común post-adapter, pre-persistencia.

    El adapter es responsable de mapear su raw payload a esta forma.
    El collector se encarga de: sanitizar, inferir contexto y persistir.
    """

    provider: str
    source_kind: str
    event_type: str           # request | response | user | assistant | tool_use | error | …
    timestamp: datetime
    external_id: str          # para idempotencia (provider, external_id) único
    session_id: str | None = None
    request_id: str | None = None
    project_cwd: str | None = None   # ruta del proyecto que originó el evento
    model: str | None = None
    endpoint: str | None = None
    status_code: int | None = None
    latency_ms: int | None = None
    request_size: int | None = None
    response_size: int | None = None
    error_message: str | None = None
    raw_text: str | None = None   # texto para inference (NUNCA persistir crudo)
    metadata: dict = field(default_factory=dict)


@dataclass
class IngestStats:
    files_seen: int = 0
    lines_seen: int = 0
    events_inserted: int = 0
    interactions_inserted: int = 0
    mentions_inserted: int = 0
    invocations_inserted: int = 0
    skipped: int = 0
    errors: int = 0


class ProviderAdapter(ABC):
    """Cada provider implementa: name, detectores, parser, fuente de paths."""

    name: str  # claude | copilot | ...
    source_kind: str = SOURCE_KIND_LOCAL_LOGS

    @abstractmethod
    def discover(self, root: Path) -> Iterable[Path]:
        """Devuelve paths con datos del provider bajo `root`.

        Por ejemplo, para Claude son los `.jsonl` de cada sesión;
        para Copilot son los `window*.log` de cada workspace.
        """

    @abstractmethod
    def ingest_path(self, root: Path, session: Session) -> IngestStats:
        """Idempotente. Persiste eventos nuevos desde la fuente del provider.

        Debe usar ON CONFLICT DO NOTHING sobre (provider, external_id) para
        no duplicar al re-correr.
        """
