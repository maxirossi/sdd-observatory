"""Claude provider adapter — wrapper sobre app.services.claude_logs.

Mantiene la implementación existente (que ya hace ON CONFLICT idempotente y
extrae agent mentions) y la expone bajo el contrato `ProviderAdapter` para
que el collector la trate igual que cualquier otro provider.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

from sqlmodel import Session

from app.services.claude_logs import ingest_path as _legacy_ingest_path
from app.services.runtime.base import (
    IngestStats,
    ProviderAdapter,
    SOURCE_KIND_LOCAL_LOGS,
)


class ClaudeAdapter(ProviderAdapter):
    name = "claude"
    source_kind = SOURCE_KIND_LOCAL_LOGS

    def discover(self, root: Path) -> Iterable[Path]:
        if not root.exists():
            return []
        return list(root.rglob("*.jsonl"))

    def ingest_path(self, root: Path, session: Session) -> IngestStats:
        legacy = _legacy_ingest_path(root, session)
        return IngestStats(
            files_seen=getattr(legacy, "files_seen", 0),
            lines_seen=getattr(legacy, "lines_seen", 0),
            events_inserted=getattr(legacy, "events_inserted", 0),
            interactions_inserted=getattr(legacy, "interactions_inserted", 0),
            mentions_inserted=getattr(legacy, "mentions_inserted", 0),
            invocations_inserted=getattr(legacy, "invocations_inserted", 0),
            skipped=getattr(legacy, "skipped", 0),
            errors=getattr(legacy, "errors", 0),
        )
