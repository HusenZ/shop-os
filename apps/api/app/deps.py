"""Shared FastAPI dependencies: settings, owner JWT auth and device-token auth."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .db import get_db
from .models import Device, User
from .security import decode_access_token, hash_token, now_ms

owner_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="OwnerJWT",
    description="Owner access token from POST /v1/orgs or POST /v1/auth/login.",
)
device_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="DeviceToken",
    description="Device token from POST /v1/devices/enrol.",
)


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


DbSession = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_app_settings)]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


@dataclass(frozen=True)
class OwnerContext:
    user_id: str
    org_id: str


def get_owner(
    db: DbSession,
    settings: AppSettings,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(owner_bearer)],
) -> OwnerContext:
    if credentials is None or not credentials.credentials:
        raise _unauthorized("not_authenticated")
    claims = decode_access_token(settings, credentials.credentials)
    if claims is None:
        raise _unauthorized("invalid_token")
    user = db.get(User, claims["sub"])
    if user is None or user.org_id != claims["org"]:
        raise _unauthorized("invalid_token")
    return OwnerContext(user_id=user.id, org_id=user.org_id)


def get_device(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(device_bearer)],
) -> Device:
    if credentials is None or not credentials.credentials:
        raise _unauthorized("not_authenticated")
    device = db.scalar(select(Device).where(Device.token_hash == hash_token(credentials.credentials)))
    if device is None:
        raise _unauthorized("invalid_device_token")
    if device.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="device_revoked")
    device.last_seen_at = now_ms()
    db.commit()
    return device


Owner = Annotated[OwnerContext, Depends(get_owner)]
CurrentDevice = Annotated[Device, Depends(get_device)]
