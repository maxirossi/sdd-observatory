"""Runtime Collector.

Orquesta el ciclo: providers habilitados → adapter.ingest_path() → stats.

La configuración viene de:
 - ProviderConfig (DB) — flag enabled por provider
 - Settings (env) — paths de logs (CLAUDE_LOGS_PATH, COPILOT_LOGS_PATH)
"""
from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path

from sqlmodel import Session, select

from app.config import settings
from app.db import engine
from app.models import ProviderConfig
from app.services.runtime.base import IngestStats
from app.services.runtime.registry import available_adapters

log = logging.getLogger(__name__)


_PROVIDER_PATH_RESOLVERS = {
    "claude": lambda: settings.ingest_watch_path,
    # Para Copilot priorizamos el workspaceStorage (chatSessions completos).
    # Si no está configurado, caemos al log path (metadata only).
    "copilot": lambda: settings.copilot_storage_path or settings.copilot_logs_path,
}


def enabled_providers(session: Session) -> list[str]:
    """Devuelve nombres de providers con `enabled=true` en DB."""
    rows = session.exec(
        select(ProviderConfig.provider).where(ProviderConfig.enabled.is_(True))  # type: ignore[union-attr]
    ).all()
    return list(rows)


def run_once() -> dict[str, IngestStats]:
    """Una pasada del collector sobre todos los providers habilitados.

    Devuelve {provider: stats}. Usa una nueva Session por provider para no
    arrastrar locks si uno explota.
    """
    out: dict[str, IngestStats] = {}
    with Session(engine) as session:
        enabled = set(enabled_providers(session))

    adapters = available_adapters()
    for name, adapter in adapters.items():
        if name not in enabled:
            continue
        path_str = _PROVIDER_PATH_RESOLVERS.get(name, lambda: None)()
        if not path_str:
            log.debug("runtime collector: %s sin path configurado, skip", name)
            continue
        root = Path(path_str)
        if not root.exists():
            log.warning("runtime collector: %s path %s no existe", name, root)
            continue
        try:
            with Session(engine) as session:
                stats = adapter.ingest_path(root, session)
            out[name] = stats
            # Tick log siempre — útil para confirmar que el watch loop está vivo
            # incluso cuando no hay eventos nuevos.
            log.info(
                "runtime tick %s: files=%d new=%d skipped=%d",
                name,
                stats.files_seen,
                stats.events_inserted,
                stats.skipped,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort, no queremos romper el watch
            log.warning("runtime collector %s failed: %s", name, exc)
            stats = IngestStats(errors=1)
            out[name] = stats
    return out


def run_once_for(provider: str) -> IngestStats | None:
    """Corre un único provider, ignorando el flag enabled. Útil para CLI/admin."""
    adapter = available_adapters().get(provider)
    if adapter is None:
        return None
    path_str = _PROVIDER_PATH_RESOLVERS.get(provider, lambda: None)()
    if not path_str:
        return None
    root = Path(path_str)
    if not root.exists():
        return None
    with Session(engine) as session:
        return adapter.ingest_path(root, session)


def stats_to_dict(stats: IngestStats) -> dict:
    return asdict(stats)
