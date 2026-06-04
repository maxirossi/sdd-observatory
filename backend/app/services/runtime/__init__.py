"""Runtime capture module.

Provider-agnostic ingest pipeline:
    raw event → adapter.parse() → sanitizer → inference → RuntimeEvent row

Adapters live next to this package; new providers implement `ProviderAdapter`.
"""
from app.services.runtime.base import (
    IngestStats,
    ParsedEvent,
    ProviderAdapter,
    SOURCE_KIND_LOCAL_LOGS,
    SOURCE_KIND_MANUAL_IMPORT,
    SOURCE_KIND_NETWORK_PROXY,
    SOURCE_KIND_PROJECT_SCAN,
)
from app.services.runtime.inference import enrich_metadata, extract_inference

# NOTA: `registry` (y sus adapters) NO se importan acá a propósito. Los adapters
# importan claude_logs / copilot_logs, que a su vez importan
# runtime.inference → este __init__. Importar registry acá crea un ciclo que
# rompe el CLI (`python -m app.cli`). Quien necesite los adapters debe hacer
# `from app.services.runtime.registry import available_adapters`.

__all__ = [
    "IngestStats",
    "ParsedEvent",
    "ProviderAdapter",
    "SOURCE_KIND_LOCAL_LOGS",
    "SOURCE_KIND_MANUAL_IMPORT",
    "SOURCE_KIND_NETWORK_PROXY",
    "SOURCE_KIND_PROJECT_SCAN",
    "enrich_metadata",
    "extract_inference",
]
