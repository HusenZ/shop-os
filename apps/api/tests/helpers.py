"""Test helpers that build ops exactly like the TypeScript client does.

Deliberately independent of ``app.canonical``: canonical JSON is written out here from the
spec, so the tests check the server against the wire contract, not against itself.
"""

from __future__ import annotations

import copy
import hashlib
import json
import uuid
from typing import Any

from fastapi.testclient import TestClient

BUSINESS_ID = "0193a1f2-0000-7000-8000-00000000b001"
DEFAULT_WALL_MS = 1_795_000_000_000


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def op_hash(op: dict[str, Any]) -> str:
    body = {k: v for k, v in op.items() if k not in ("hash", "seq")}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def rehash(op: dict[str, Any]) -> dict[str, Any]:
    """Recompute ``hash`` after editing an op (the edit is then 'valid' on its own)."""
    op["hash"] = op_hash(op)
    return op


def new_id() -> str:
    return str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())


class OpChain:
    """One device's op log: HLC stamps plus the prev_hash -> hash chain."""

    def __init__(
        self,
        device_id: str,
        *,
        user_id: str = "usr_owner",
        business_id: str = BUSINESS_ID,
        branch_id: str | None = None,
        wall_ms: int = DEFAULT_WALL_MS,
    ) -> None:
        self.device_id = device_id
        self.user_id = user_id
        self.business_id = business_id
        self.branch_id = branch_id
        self.wall = wall_ms
        self.counter = -1
        self.prev_hash: str | None = None

    def _hlc(self, wall: int | None) -> tuple[str, int]:
        if wall is None:
            self.counter += 1
            wall = self.wall
        else:
            # An explicit wall clock (e.g. a device whose clock is behind).
            self.counter = 0
        return f"{wall:015d}-{self.counter:04d}-{self.device_id}", wall

    def build(
        self,
        *,
        kind: str,
        type: str,
        entity: str,
        entity_id: str,
        payload: dict[str, Any],
        wall: int | None = None,
        branch_id: Any = ...,  # Ellipsis = use the chain default
    ) -> dict[str, Any]:
        hlc, wall_ms = self._hlc(wall)
        op = {
            "op_id": new_id(),
            "v": 1,
            "device_id": self.device_id,
            "user_id": self.user_id,
            "hlc": hlc,
            "kind": kind,
            "type": type,
            "entity": entity,
            "entity_id": entity_id,
            "business_id": self.business_id,
            "branch_id": self.branch_id if branch_id is ... else branch_id,
            "created_at": wall_ms + max(self.counter, 0),
            "payload": payload,
            "prev_hash": self.prev_hash,
        }
        op["hash"] = op_hash(op)
        self.prev_hash = op["hash"]
        return op

    def fact(
        self, type: str, entity: str, entity_id: str, tables: dict[str, list[dict]], **kw: Any
    ) -> dict[str, Any]:
        return self.build(
            kind="fact", type=type, entity=entity, entity_id=entity_id,
            payload={"tables": copy.deepcopy(tables)}, **kw,
        )

    def patch(
        self,
        table: str,
        row_id: str,
        set_: dict[str, Any],
        *,
        before: dict[str, Any] | None = None,
        create: bool = False,
        type: str | None = None,
        **kw: Any,
    ) -> dict[str, Any]:
        payload = {
            "table": table,
            "id": row_id,
            "create": create,
            "set": dict(set_),
            "before": dict(before or {}),
        }
        op_type = type or f"{table.rstrip('s')}.{'created' if create else 'patched'}"
        return self.build(kind="patch", type=op_type, entity=table, entity_id=row_id, payload=payload, **kw)

    def note(self, text: str = "hello", **kw: Any) -> dict[str, Any]:
        """A small fact op with no journal (e.g. a party note)."""
        row_id = new_id()
        return self.fact(
            "note.added", "notes", row_id, {"notes": [{"id": row_id, "text": text, "pinned": False}]}, **kw
        )


# --- API helpers ------------------------------------------------------------------------


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def create_org(client: TestClient, email: str = "owner@shop.test", password: str = "s3cret-pass",
               org_name: str = "Sharma Stores") -> dict[str, Any]:
    res = client.post("/v1/orgs", json={"org_name": org_name, "email": email, "password": password})
    assert res.status_code == 201, res.text
    return res.json()


def enrol(client: TestClient, jwt: str, device_id: str, name: str = "Counter",
          preferred_series: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"device_id": device_id, "name": name}
    if preferred_series is not None:
        body["preferred_series"] = preferred_series
    res = client.post("/v1/devices/enrol", json=body, headers=auth(jwt))
    assert res.status_code == 200, res.text
    return res.json()


def push(client: TestClient, device_token: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
    res = client.post("/v1/sync/push", json={"ops": ops}, headers=auth(device_token))
    assert res.status_code == 200, res.text
    return res.json()


def pull(client: TestClient, device_token: str, cursor: int = 0, limit: int | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"cursor": cursor}
    if limit is not None:
        params["limit"] = limit
    res = client.get("/v1/sync/pull", params=params, headers=auth(device_token))
    assert res.status_code == 200, res.text
    return res.json()
