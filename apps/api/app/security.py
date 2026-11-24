"""Password hashing, owner JWTs and device tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any

import jwt

from .config import Settings

PBKDF2_ITERATIONS = 200_000
_SCHEME = "pbkdf2_sha256"


def now_ms() -> int:
    return time.time_ns() // 1_000_000


# --- passwords ---------------------------------------------------------------


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "$".join(
        [
            _SCHEME,
            str(PBKDF2_ITERATIONS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
        if scheme != _SCHEME:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        rounds = int(iterations)
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(actual, expected)


# A valid hash to check against when the email is unknown, so timing does not reveal it.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def verify_dummy_password(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


# --- owner JWT ---------------------------------------------------------------


def create_access_token(settings: Settings, *, user_id: str, org_id: str) -> str:
    issued = int(time.time())
    claims = {
        "sub": user_id,
        "org": org_id,
        "iat": issued,
        "exp": issued + settings.jwt_ttl_days * 24 * 3600,
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(settings: Settings, token: str) -> dict[str, Any] | None:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub", "org"]},
        )
    except jwt.PyJWTError:
        return None
    if not isinstance(claims.get("sub"), str) or not isinstance(claims.get("org"), str):
        return None
    return claims


# --- device tokens -----------------------------------------------------------


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
