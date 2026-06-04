"""Copilot provider adapter — wrapper sobre app.services.copilot_logs.

Misma idea que ClaudeAdapter: la lógica de parseo de los `window*.log` de
VSCode ya existe, acá la exponemos bajo el contrato `ProviderAdapter`.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

from sqlmodel import Session

from app.services.copilot_logs import ingest_path as _legacy_ingest_path
from app.services.runtime.base import (
    IngestStats,
    ProviderAdapter,
    SOURCE_KIND_LOCAL_LOGS,
)


class CopilotAdapter(ProviderAdapter):
    name = "copilot"
    source_kind = SOURCE_KIND_LOCAL_LOGS

    def discover(self, root: Path) -> Iterable[Path]:
        if not root.exists():
            return []
        # Logs de Copilot dentro de VS Code: window*.log o exthost.log
        return list(root.rglob("window*.log")) + list(root.rglob("exthost*.log"))

    def ingest_path(self, root: Path, session: Session) -> IngestStats:
        legacy = _legacy_ingest_path(root, session)
        return IngestStats(
            files_seen=getattr(legacy, "files_seen", 0),
            lines_seen=getattr(legacy, "lines_seen", 0),
            events_inserted=getattr(legacy, "events_inserted", 0),
            interactions_inserted=getattr(legacy, "interactions_inserted", 0),
            mentions_inserted=getattr(legacy, "mentions_inserted", 0),
            skipped=getattr(legacy, "skipped", 0),
            errors=getattr(legacy, "errors", 0),
        )
