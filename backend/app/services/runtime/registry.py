"""Registro de adapters disponibles.

El collector consulta este registro para saber qué providers correr.
Nuevos providers solo necesitan: agregarse al dict y exponer un adapter.
"""
from __future__ import annotations

from app.services.runtime.base import ProviderAdapter
from app.services.runtime.claude_adapter import ClaudeAdapter
from app.services.runtime.copilot_storage_adapter import CopilotChatStorageAdapter

# Copilot tiene dos posibles fuentes locales:
#   - `GitHub Copilot Chat.log` (solo metadata HTTP-style)
#   - `workspaceStorage/*/chatSessions/*.jsonl` (prompts, responses, agents,
#      contentReferences, tool calls)
# Usamos el storage adapter porque trae todo. El log adapter sigue en el
# código (copilot_adapter.py) por si más adelante queremos combinarlos.
_REGISTRY: dict[str, ProviderAdapter] = {
    "claude": ClaudeAdapter(),
    "copilot": CopilotChatStorageAdapter(),
}


def available_adapters() -> dict[str, ProviderAdapter]:
    """Snapshot del registro. NO necesariamente todos están habilitados —
    eso depende de ProviderConfig.enabled en DB."""
    return dict(_REGISTRY)


def get_adapter(name: str) -> ProviderAdapter | None:
    return _REGISTRY.get(name)
