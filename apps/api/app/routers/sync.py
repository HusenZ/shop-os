"""Op relay: push, pull and status (device token)."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from ..deps import AppSettings, CurrentDevice, DbSession
from ..models import Op, Org
from ..oplog import push_ops
from ..schemas import PullResponse, PushRequest, PushResponse, SyncStatus

router = APIRouter(prefix="/v1/sync", tags=["sync"])


@router.post("/push", response_model=PushResponse)
def push(body: PushRequest, device: CurrentDevice, request: Request, db: DbSession) -> PushResponse:
    with request.app.state.write_lock:
        result = push_ops(db, device, body.ops)
    return PushResponse.model_validate({"acked": result.acked, "rejected": result.rejected})


@router.get(
    "/pull",
    response_model=None,
    responses={200: {"model": PullResponse, "description": "Ops from other devices, by seq"}},
)
def pull(
    device: CurrentDevice,
    db: DbSession,
    settings: AppSettings,
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int | None, Query(ge=1)] = None,
) -> JSONResponse:
    size = min(limit or settings.pull_default_limit, settings.pull_max_limit)
    rows = db.execute(
        select(Op.seq, Op.device_id, Op.op_json)
        .where(Op.org_id == device.org_id, Op.seq > cursor)
        .order_by(Op.seq)
        .limit(size)
    ).all()

    ops = []
    for seq, author, op_json in rows:
        if author == device.device_id:
            continue
        op = json.loads(op_json)
        op["seq"] = seq
        ops.append(op)

    next_cursor = rows[-1].seq if rows else cursor
    latest = db.scalar(select(Org.last_seq).where(Org.id == device.org_id)) or 0
    # Return the parsed original op text (not a re-serialised model) so it re-hashes exactly.
    return JSONResponse({"ops": ops, "next_cursor": next_cursor, "more": latest > next_cursor})


@router.get("/status", response_model=SyncStatus)
def sync_status(device: CurrentDevice, db: DbSession) -> SyncStatus:
    latest = db.scalar(select(Org.last_seq).where(Org.id == device.org_id)) or 0
    return SyncStatus(
        org_id=device.org_id,
        device_id=device.device_id,
        series_code=device.series_code,
        latest_seq=latest,
        last_hash=device.last_hash,
    )
