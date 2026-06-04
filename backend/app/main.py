import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from app.api import audit as audit_api
from app.api import events as events_api
from app.api import findings as findings_api
from app.api import health as health_api
from app.api import intelligence as intelligence_api
from app.api import projects as projects_api
from app.api import providers as providers_api
from app.api import runner as runner_api
from app.api import runtime as runtime_api
from app.api import sessions as sessions_api
from app.api import tree as tree_api
from app.api import wave5 as wave5_api
from app.api import usage as usage_api
from app.config import settings
from app.db import engine
from app.models import ProviderConfig
from app.services.runtime import collector as runtime_collector

log = logging.getLogger(__name__)


def _run_migrations() -> None:
    """Apply pending Alembic migrations. Idempotent — no-op when already up-to-date."""
    config_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = AlembicConfig(str(config_path))
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    command.upgrade(cfg, "head")


def _seed_default_providers() -> None:
    """Ensure the supported providers exist with safe defaults. Idempotent."""
    defaults = {
        "claude": {"enabled": True, "capture_metadata": True},
        "copilot": {"enabled": True, "capture_metadata": True},
    }
    with Session(engine) as session:
        # Remove provider rows that were seeded but are no longer in the
        # supported catalogue (keeps the UI honest).
        legacy = ["cursor", "openai", "gemini", "ollama", "custom", "network_proxy"]
        for old in legacy:
            existing = session.exec(
                select(ProviderConfig).where(ProviderConfig.provider == old)
            ).first()
            if existing is not None:
                session.delete(existing)
        for provider, fields in defaults.items():
            existing = session.exec(
                select(ProviderConfig).where(ProviderConfig.provider == provider)
            ).first()
            if existing is None:
                session.add(ProviderConfig(provider=provider, **fields))
        session.commit()


def _run_ingest_once() -> None:
    """Una pasada del runtime collector — delega a app.services.runtime.collector.

    Los providers habilitados se leen de ProviderConfig (DB). Adapters
    se autoregistran en services/runtime/registry.py.
    """
    runtime_collector.run_once()


async def _ingest_watch_loop() -> None:
    """Periodic ingest of Claude session logs. Runs only when enabled."""
    interval = max(5, settings.ingest_watch_interval_seconds)
    log.info("ingest watch enabled — every %ds reading %s", interval, settings.ingest_watch_path)
    while True:
        try:
            await asyncio.to_thread(_run_ingest_once)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("ingest watch tick failed: %s", exc)
        await asyncio.sleep(interval)


def _run_scan_once() -> None:
    """Re-escanea el proyecto target (tasks/cycles/docs) y graba un snapshot de
    progreso por ciclo. Idempotente (upsert por path)."""
    from pathlib import Path

    from app.services.scanner import persist, scan
    from app.services.snapshots import record_cycle_snapshots

    path = settings.scan_target_mount_path
    if not path or not Path(path).exists():
        return
    result = scan(path)
    with Session(engine) as session:
        project = persist(result, session)
        record_cycle_snapshots(project.id, session)


async def _scan_watch_loop() -> None:
    """Re-scan periódico del proyecto. Corre una vez al arranque y luego cada
    `scan_watch_interval_seconds`."""
    interval = max(60, settings.scan_watch_interval_seconds)
    log.info("scan watch enabled — every %ds scanning %s", interval, settings.scan_target_mount_path)
    while True:
        try:
            await asyncio.to_thread(_run_scan_once)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("scan watch tick failed: %s", exc)
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    try:
        _run_migrations()
    except Exception as exc:
        log.warning("Auto-migrate skipped: %s", exc)
    try:
        _seed_default_providers()
    except Exception as exc:
        log.warning("Provider seed skipped: %s", exc)

    tasks: list[asyncio.Task[None]] = []
    if settings.ingest_watch_enabled:
        tasks.append(asyncio.create_task(_ingest_watch_loop()))
    if settings.scan_watch_enabled:
        tasks.append(asyncio.create_task(_scan_watch_loop()))

    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass


app = FastAPI(title="SDD Observatory API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_api.router)
app.include_router(health_api.router)
app.include_router(findings_api.router)
app.include_router(usage_api.router)
app.include_router(events_api.router)
app.include_router(providers_api.router)
app.include_router(runtime_api.router)
app.include_router(runner_api.router)
app.include_router(sessions_api.router)
app.include_router(tree_api.router)
app.include_router(intelligence_api.router)
app.include_router(wave5_api.router)
app.include_router(audit_api.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.app_env, "privacyMode": settings.privacy_mode}


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "ssdoffice-backend", "version": "0.1.0"}
