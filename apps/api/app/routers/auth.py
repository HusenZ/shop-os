"""Org sign-up and owner login."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..deps import AppSettings, DbSession
from ..models import Org, User
from ..schemas import AuthResponse, LoginRequest, OrgCreate
from ..security import (
    create_access_token,
    hash_password,
    now_ms,
    verify_dummy_password,
    verify_password,
)

router = APIRouter(prefix="/v1", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(email: str) -> str:
    return email.strip().lower()


@router.post("/orgs", status_code=status.HTTP_201_CREATED, response_model=AuthResponse)
def create_org(body: OrgCreate, request: Request, db: DbSession, settings: AppSettings) -> AuthResponse:
    email = normalize_email(body.email)
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="invalid_email")
    org_name = body.org_name.strip()
    if not org_name:
        raise HTTPException(status_code=422, detail="invalid_org_name")

    password_hash = hash_password(body.password)  # slow; done outside the write lock
    with request.app.state.write_lock:
        if db.scalar(select(User.id).where(User.email == email)) is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email_exists")
        now = now_ms()
        org = Org(id=str(uuid.uuid4()), name=org_name, created_at=now, last_seq=0)
        user = User(
            id=str(uuid.uuid4()),
            org_id=org.id,
            email=email,
            password_hash=password_hash,
            created_at=now,
        )
        db.add(org)
        db.flush()
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email_exists") from None

    token = create_access_token(settings, user_id=user.id, org_id=org.id)
    return AuthResponse(org_id=org.id, user_id=user.id, access_token=token)


@router.post("/auth/login", response_model=AuthResponse)
def login(body: LoginRequest, db: DbSession, settings: AppSettings) -> AuthResponse:
    user = db.scalar(select(User).where(User.email == normalize_email(body.email)))
    if user is None:
        verify_dummy_password(body.password)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")
    token = create_access_token(settings, user_id=user.id, org_id=user.org_id)
    return AuthResponse(org_id=user.org_id, user_id=user.id, access_token=token)
