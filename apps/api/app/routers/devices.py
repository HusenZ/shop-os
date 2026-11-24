"""Device enrolment, listing and revocation (owner JWT)."""

from __future__ import annotations

import re
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..deps import DbSession, Owner
from ..models import Device
from ..schemas import DeviceOut, EnrolRequest, EnrolResponse
from ..security import generate_device_token, hash_token, now_ms

router = APIRouter(prefix="/v1/devices", tags=["devices"])

_SERIES_RE = re.compile(r"^[A-Z]{1,8}$")


def series_code_for(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, ... (spreadsheet-column style)."""
    code = ""
    n = index + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        code = chr(ord("A") + rem) + code
    return code


def iter_series_codes() -> Iterator[str]:
    index = 0
    while True:
        yield series_code_for(index)
        index += 1


def pick_series(taken: set[str], preferred: str | None) -> str:
    if preferred and preferred not in taken:
        return preferred
    for code in iter_series_codes():
        if code not in taken:
            return code
    raise AssertionError("unreachable")


def device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        device_id=device.device_id,
        name=device.name,
        series_code=device.series_code,
        enrolled_at=device.enrolled_at,
        last_seen_at=device.last_seen_at,
        revoked_at=device.revoked_at,
        last_hash=device.last_hash,
    )


@router.post("/enrol", response_model=EnrolResponse)
def enrol_device(body: EnrolRequest, owner: Owner, request: Request, db: DbSession) -> EnrolResponse:
    device_id = body.device_id.strip()
    name = body.name.strip()
    if not device_id or not name:
        raise HTTPException(status_code=422, detail="device_id_and_name_required")
    preferred = (body.preferred_series or "").strip().upper() or None
    if preferred is not None and not _SERIES_RE.match(preferred):
        raise HTTPException(status_code=422, detail="invalid_preferred_series")

    token = generate_device_token()
    with request.app.state.write_lock:
        device = db.get(Device, device_id)
        if device is not None and device.org_id != owner.org_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="device_in_other_org")
        now = now_ms()
        if device is None:
            taken = set(db.scalars(select(Device.series_code).where(Device.org_id == owner.org_id)))
            device = Device(
                device_id=device_id,
                org_id=owner.org_id,
                name=name,
                series_code=pick_series(taken, preferred),
                token_hash=hash_token(token),
                enrolled_by=owner.user_id,
                enrolled_at=now,
                last_seen_at=None,
                revoked_at=None,
                last_hash=None,
            )
            db.add(device)
        else:
            # Re-enrolment: fresh token (the old one stops working), same series and chain.
            device.name = name
            device.token_hash = hash_token(token)
            device.enrolled_by = owner.user_id
            device.revoked_at = None
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="enrol_conflict") from None

    return EnrolResponse(
        device_id=device.device_id,
        device_token=token,
        series_code=device.series_code,
        org_id=device.org_id,
    )


@router.get("", response_model=list[DeviceOut])
def list_devices(owner: Owner, db: DbSession) -> list[DeviceOut]:
    devices = db.scalars(
        select(Device)
        .where(Device.org_id == owner.org_id)
        .order_by(Device.enrolled_at, Device.device_id)
    )
    return [device_out(d) for d in devices]


@router.post("/{device_id}/revoke", response_model=DeviceOut)
def revoke_device(device_id: str, owner: Owner, request: Request, db: DbSession) -> DeviceOut:
    with request.app.state.write_lock:
        device = db.get(Device, device_id)
        if device is None or device.org_id != owner.org_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="device_not_found")
        if device.revoked_at is None:
            device.revoked_at = now_ms()
            db.commit()
    return device_out(device)
