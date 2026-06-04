from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db import get_session
from app.models import ProviderConfig

router = APIRouter(prefix="/api/providers", tags=["providers"])

# Providers with a working collector. Add to this list when a new ingest path
# is implemented (PLAN.md Fase 5).
SUPPORTED_PROVIDERS = ["claude", "copilot"]


class ProviderConfigRead(BaseModel):
    provider: str
    enabled: bool
    capture_metadata: bool
    capture_payload: bool
    capture_response: bool
    updated_at: datetime


class ProviderConfigUpdate(BaseModel):
    enabled: bool | None = None
    capture_metadata: bool | None = None
    capture_payload: bool | None = None
    capture_response: bool | None = None


def _to_read(cfg: ProviderConfig) -> ProviderConfigRead:
    return ProviderConfigRead(
        provider=cfg.provider,
        enabled=cfg.enabled,
        capture_metadata=cfg.capture_metadata,
        capture_payload=cfg.capture_payload,
        capture_response=cfg.capture_response,
        updated_at=cfg.updated_at,
    )


@router.get("", response_model=list[ProviderConfigRead])
def list_providers(session: Session = Depends(get_session)) -> list[ProviderConfigRead]:
    existing = {c.provider: c for c in session.exec(select(ProviderConfig)).all()}
    # Surface placeholders for known providers even if not yet stored.
    result: list[ProviderConfigRead] = []
    for name in SUPPORTED_PROVIDERS:
        if name in existing:
            result.append(_to_read(existing[name]))
        else:
            result.append(
                ProviderConfigRead(
                    provider=name,
                    enabled=name in ("claude", "copilot"),
                    capture_metadata=True,
                    capture_payload=False,
                    capture_response=False,
                    updated_at=datetime.utcnow(),
                )
            )
    # Also surface any custom provider already stored that isn't in the known list.
    for name, cfg in existing.items():
        if name not in SUPPORTED_PROVIDERS:
            result.append(_to_read(cfg))
    return result


@router.put("/{provider}", response_model=ProviderConfigRead)
def upsert_provider(
    provider: str,
    update: ProviderConfigUpdate,
    session: Session = Depends(get_session),
) -> ProviderConfigRead:
    if not provider or len(provider) > 50:
        raise HTTPException(status_code=400, detail="Invalid provider name")

    cfg = session.exec(select(ProviderConfig).where(ProviderConfig.provider == provider)).first()
    if cfg is None:
        cfg = ProviderConfig(
            provider=provider,
            enabled=update.enabled if update.enabled is not None else False,
            capture_metadata=update.capture_metadata if update.capture_metadata is not None else True,
            capture_payload=update.capture_payload if update.capture_payload is not None else False,
            capture_response=update.capture_response if update.capture_response is not None else False,
        )
        session.add(cfg)
    else:
        if update.enabled is not None:
            cfg.enabled = update.enabled
        if update.capture_metadata is not None:
            cfg.capture_metadata = update.capture_metadata
        if update.capture_payload is not None:
            cfg.capture_payload = update.capture_payload
        if update.capture_response is not None:
            cfg.capture_response = update.capture_response
        cfg.updated_at = datetime.utcnow()

    session.commit()
    session.refresh(cfg)
    return _to_read(cfg)
