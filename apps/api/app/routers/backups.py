"""Encrypted backup blobs (device token). The hub stores the bytes as-is."""

from __future__ import annotations

import hashlib
import os
import re
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from ..deps import AppSettings, CurrentDevice, DbSession
from ..models import Backup
from ..schemas import BackupCreated, BackupOut
from ..security import now_ms

router = APIRouter(prefix="/v1/backups", tags=["backups"])

_UNSAFE_NAME = re.compile(r"[\x00-\x1f\x7f/\\]")


def _org_dir(settings, org_id: str) -> Path:
    return Path(settings.backup_dir) / org_id


def _clean_name(name: str | None) -> str | None:
    if name is None:
        return None
    cleaned = _UNSAFE_NAME.sub("_", name).strip()
    return cleaned[:255] or None


def _backup_out(b: Backup) -> BackupOut:
    return BackupOut(
        backup_id=b.id,
        size=b.size,
        sha256=b.sha256,
        created_at=b.created_at,
        name=b.name,
        device_id=b.device_id,
    )


@router.put(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=BackupCreated,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def upload_backup(
    request: Request,
    device: CurrentDevice,
    db: DbSession,
    settings: AppSettings,
    x_backup_name: Annotated[str | None, Header(max_length=1024)] = None,
) -> BackupCreated:
    limit = settings.max_backup_bytes
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="backup_too_large")

    backup_id = str(uuid.uuid4())
    folder = _org_dir(settings, device.org_id)
    await run_in_threadpool(folder.mkdir, parents=True, exist_ok=True)
    final_path = folder / f"{backup_id}.bin"
    temp_path = folder / f".{backup_id}.part"

    digest = hashlib.sha256()
    size = 0
    handle = await run_in_threadpool(open, temp_path, "wb")
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            size += len(chunk)
            if size > limit:
                raise HTTPException(
                    status_code=413, detail="backup_too_large"
                )
            digest.update(chunk)
            await run_in_threadpool(handle.write, chunk)
        await run_in_threadpool(handle.flush)
        await run_in_threadpool(os.fsync, handle.fileno())
    except BaseException:
        handle.close()
        temp_path.unlink(missing_ok=True)
        raise
    handle.close()

    if size == 0:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="empty_backup")
    os.replace(temp_path, final_path)

    backup = Backup(
        id=backup_id,
        org_id=device.org_id,
        device_id=device.device_id,
        name=_clean_name(x_backup_name),
        size=size,
        sha256=digest.hexdigest(),
        created_at=now_ms(),
        file_name=final_path.name,
    )

    def _save() -> None:
        db.add(backup)
        db.commit()

    try:
        await run_in_threadpool(_save)
    except BaseException:
        final_path.unlink(missing_ok=True)
        raise
    return BackupCreated(
        backup_id=backup.id, size=backup.size, sha256=backup.sha256, created_at=backup.created_at
    )


@router.get("", response_model=list[BackupOut])
def list_backups(device: CurrentDevice, db: DbSession) -> list[BackupOut]:
    rows = db.scalars(
        select(Backup)
        .where(Backup.org_id == device.org_id)
        .order_by(Backup.created_at.desc(), Backup.id)
    )
    return [_backup_out(b) for b in rows]


@router.get(
    "/{backup_id}",
    response_class=FileResponse,
    responses={200: {"content": {"application/octet-stream": {}}, "description": "Backup bytes"}},
)
def download_backup(
    backup_id: str, device: CurrentDevice, db: DbSession, settings: AppSettings
) -> FileResponse:
    backup = db.get(Backup, backup_id)
    if backup is None or backup.org_id != device.org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backup_not_found")
    path = _org_dir(settings, backup.org_id) / backup.file_name
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backup_file_missing")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=backup.name or f"{backup.id}.bin",
        headers={"X-Backup-Sha256": backup.sha256, "X-Backup-Id": backup.id},
    )
