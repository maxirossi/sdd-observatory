from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, desc, select

from app.config import settings
from app.db import get_session
from app.models import LlmInteraction, ProviderConfig, RuntimeEvent
from app.services.sanitizer import estimate_chars, sanitize

router = APIRouter(prefix="/api/events", tags=["events"])


# ─────────────────────────── Schemas ───────────────────────────


_VALID_SOURCE_KINDS = {"local_logs", "network_proxy", "project_scan", "manual_import"}


class EventIn(BaseModel):
    provider: str
    event_type: str = Field(default="request")
    # local_logs (default) | network_proxy | project_scan | manual_import
    source_kind: str = Field(default="local_logs")
    project_id: UUID | None = None
    timestamp: datetime | None = None
    status_code: int | None = None
    latency_ms: int | None = None
    endpoint: str | None = None
    request_size: int | None = None
    response_size: int | None = None
    error_message: str | None = None
    event_metadata: dict | None = None

    # Optional LLM-specific extension (sanitized server-side).
    model: str | None = None
    prompt: str | None = None
    response: str | None = None


class EventRead(BaseModel):
    id: UUID
    provider: str
    event_type: str
    timestamp: datetime
    status_code: int | None
    latency_ms: int | None
    endpoint: str | None
    request_size: int | None
    response_size: int | None
    error_message: str | None
    has_interaction: bool


# ─────────────────────────── Helpers ───────────────────────────


def _resolve_capture_flags(provider: str, session: Session) -> tuple[bool, bool, bool]:
    cfg = session.exec(select(ProviderConfig).where(ProviderConfig.provider == provider)).first()
    if cfg is None:
        # Implicit defaults: metadata-only, disabled by configuration.
        return (True, False, False)
    return (cfg.capture_metadata, cfg.capture_payload, cfg.capture_response)


# ─────────────────────────── Endpoints ───────────────────────────


@router.post("", response_model=EventRead)
def ingest(event: EventIn, session: Session = Depends(get_session)) -> EventRead:
    if event.source_kind not in _VALID_SOURCE_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"source_kind inválido. Permitidos: {sorted(_VALID_SOURCE_KINDS)}",
        )

    cfg_metadata, cfg_payload, cfg_response = _resolve_capture_flags(event.provider, session)
    privacy = settings.privacy_mode

    if not cfg_metadata and privacy == "metadata_only":
        raise HTTPException(status_code=403, detail="Provider not configured to capture metadata")

    runtime = RuntimeEvent(
        project_id=event.project_id,
        provider=event.provider,
        source_kind=event.source_kind,
        event_type=event.event_type,
        timestamp=event.timestamp or datetime.utcnow(),
        status_code=event.status_code,
        latency_ms=event.latency_ms,
        request_size=event.request_size,
        response_size=event.response_size,
        endpoint=event.endpoint,
        error_message=event.error_message,
        event_metadata=event.event_metadata,
    )
    session.add(runtime)
    session.flush()

    has_interaction = False
    if event.prompt or event.response or event.model:
        sanitized_prompt: str | None = None
        sanitized_response: str | None = None

        if privacy == "raw_local_only":
            sanitized_prompt = event.prompt if cfg_payload else None
            sanitized_response = event.response if cfg_response else None
        elif privacy in ("sanitized_payload", "metadata_only"):
            if cfg_payload:
                sanitized_prompt = sanitize(event.prompt)
            if cfg_response:
                sanitized_response = sanitize(event.response)

        # Always record character counts even when payload is dropped — useful
        # for volume metrics without storing content.
        session.add(
            LlmInteraction(
                runtime_event_id=runtime.id,
                provider=event.provider,
                model=event.model,
                prompt_chars=estimate_chars(event.prompt),
                response_chars=estimate_chars(event.response),
                sanitized_prompt=sanitized_prompt,
                sanitized_response=sanitized_response,
            )
        )
        has_interaction = True

    session.commit()
    session.refresh(runtime)

    return EventRead(
        id=runtime.id,
        provider=runtime.provider,
        event_type=runtime.event_type,
        timestamp=runtime.timestamp,
        status_code=runtime.status_code,
        latency_ms=runtime.latency_ms,
        endpoint=runtime.endpoint,
        request_size=runtime.request_size,
        response_size=runtime.response_size,
        error_message=runtime.error_message,
        has_interaction=has_interaction,
    )


class EventTimelineBucket(BaseModel):
    bucket: datetime
    provider: str
    count: int


class ProviderStats(BaseModel):
    provider: str
    total: int
    last_seen: datetime | None


@router.get("/timeline", response_model=list[EventTimelineBucket])
def events_timeline(
    project_id: UUID | None = None,
    hours: int = Query(48, ge=1, le=720),
    session: Session = Depends(get_session),
) -> list[EventTimelineBucket]:
    """Hourly counts of runtime events per provider, last N hours."""
    threshold = datetime.utcnow() - timedelta(hours=hours)
    bucket = func.date_trunc("hour", RuntimeEvent.timestamp).label("bucket")
    stmt = (
        select(bucket, RuntimeEvent.provider, func.count(RuntimeEvent.id).label("c"))
        .where(RuntimeEvent.timestamp >= threshold)
        .group_by(bucket, RuntimeEvent.provider)
        .order_by(bucket.asc())
    )
    if project_id:
        stmt = stmt.where(RuntimeEvent.project_id == project_id)
    rows = session.exec(stmt).all()
    return [EventTimelineBucket(bucket=b, provider=p, count=c) for b, p, c in rows]


@router.get("/by-provider", response_model=list[ProviderStats])
def stats_by_provider(
    project_id: UUID | None = None,
    session: Session = Depends(get_session),
) -> list[ProviderStats]:
    stmt = (
        select(
            RuntimeEvent.provider,
            func.count(RuntimeEvent.id).label("total"),
            func.max(RuntimeEvent.timestamp).label("last_seen"),
        )
        .group_by(RuntimeEvent.provider)
        .order_by(func.count(RuntimeEvent.id).desc())
    )
    if project_id:
        stmt = stmt.where(RuntimeEvent.project_id == project_id)
    rows = session.exec(stmt).all()
    return [ProviderStats(provider=p, total=t, last_seen=ls) for p, t, ls in rows]


class SourceProviderBreakdown(BaseModel):
    provider: str
    events: int
    last_seen: datetime | None


class RuntimeSourceBucket(BaseModel):
    """Eventos agrupados por source_kind. `enabled` indica si el módulo
    correspondiente está activo (logs locales = siempre)."""

    source_kind: str  # local_logs | project_scan | manual_import
    label: str
    description: str
    enabled: bool
    available: bool  # falso para módulos no implementados
    providers: list[SourceProviderBreakdown]
    total: int


_SOURCE_META: dict[str, tuple[str, str]] = {
    "local_logs": (
        "Logs locales",
        "Eventos reconstruidos desde archivos de log de herramientas (Claude Code, Copilot).",
    ),
    "project_scan": (
        "Scanner del proyecto",
        "Eventos derivados de archivos del repo (agents, docs, tasks).",
    ),
    "manual_import": (
        "Import manual",
        "JSON / CSV / dumps cargados a mano.",
    ),
}


@router.get("/runtime-sources", response_model=list[RuntimeSourceBucket])
def runtime_sources(
    project_id: UUID | None = None,
    session: Session = Depends(get_session),
) -> list[RuntimeSourceBucket]:
    """Resumen de actividad runtime agrupada por origen. Distingue el
    origen de cada evento — no llamar "network traffic" a algo que vino
    del filesystem."""

    stmt = (
        select(
            RuntimeEvent.source_kind,
            RuntimeEvent.provider,
            func.count(RuntimeEvent.id).label("events"),
            func.max(RuntimeEvent.timestamp).label("last_seen"),
        )
        .group_by(RuntimeEvent.source_kind, RuntimeEvent.provider)
        .order_by(func.count(RuntimeEvent.id).desc())
    )
    if project_id:
        stmt = stmt.where(RuntimeEvent.project_id == project_id)

    by_kind: dict[str, list[SourceProviderBreakdown]] = {}
    for kind, provider, events, last_seen in session.exec(stmt).all():
        by_kind.setdefault(kind, []).append(
            SourceProviderBreakdown(provider=provider, events=int(events), last_seen=last_seen)
        )

    # Orden estable: local_logs, project_scan, manual_import.
    order = ["local_logs", "project_scan", "manual_import"]
    available_kinds = {"local_logs", "project_scan", "manual_import"}

    out: list[RuntimeSourceBucket] = []
    for kind in order:
        providers = by_kind.get(kind, [])
        label, desc_text = _SOURCE_META.get(kind, (kind, ""))
        total = sum(p.events for p in providers)
        # `enabled` significa "está aceptando eventos / hay actividad".
        is_enabled = len(providers) > 0
        out.append(
            RuntimeSourceBucket(
                source_kind=kind,
                label=label,
                description=desc_text,
                enabled=is_enabled,
                available=kind in available_kinds,
                providers=providers,
                total=total,
            )
        )
    return out


@router.get("", response_model=list[EventRead])
def list_events(
    provider: str | None = None,
    project_id: UUID | None = None,
    limit: int = Query(50, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[EventRead]:
    stmt = select(RuntimeEvent).order_by(desc(RuntimeEvent.timestamp)).limit(limit)
    if provider:
        stmt = stmt.where(RuntimeEvent.provider == provider)
    if project_id:
        stmt = stmt.where(RuntimeEvent.project_id == project_id)
    events = session.exec(stmt).all()

    interaction_ids = {
        i.runtime_event_id
        for i in session.exec(
            select(LlmInteraction).where(
                LlmInteraction.runtime_event_id.in_([e.id for e in events])  # type: ignore[attr-defined]
            )
        ).all()
    }

    return [
        EventRead(
            id=e.id,
            provider=e.provider,
            event_type=e.event_type,
            timestamp=e.timestamp,
            status_code=e.status_code,
            latency_ms=e.latency_ms,
            endpoint=e.endpoint,
            request_size=e.request_size,
            response_size=e.response_size,
            error_message=e.error_message,
            has_interaction=e.id in interaction_ids,
        )
        for e in events
    ]
