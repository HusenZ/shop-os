"""Verifying and storing pushed ops."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .canonical import canonical_json, compute_op_hash
from .models import Device, Op, Org
from .projector import project_op
from .security import now_ms

# Rejection reasons (wire values).
DEVICE_MISMATCH = "device_mismatch"
BAD_HASH = "bad_hash"
CHAIN_BROKEN = "chain_broken"
UNBALANCED_JOURNAL = "unbalanced_journal"
INVALID_OP = "invalid_op"

_REQUIRED_STR = ("op_id", "device_id", "hlc", "hash")
_OPTIONAL_STR = ("user_id", "type", "entity", "entity_id", "business_id", "branch_id", "prev_hash")
_OPTIONAL_INT = ("v", "created_at")
_MAX_ID_LEN = 128


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def envelope_error(op: dict[str, Any]) -> str | None:
    """Return ``invalid_op`` if the op is not shaped like an op at all."""
    for key in _REQUIRED_STR:
        value = op.get(key)
        if not isinstance(value, str) or not value:
            return INVALID_OP
    if len(op["op_id"]) > _MAX_ID_LEN or len(op["device_id"]) > _MAX_ID_LEN or len(op["hlc"]) > 200:
        return INVALID_OP
    for key in _OPTIONAL_STR:
        if op.get(key) is not None and not isinstance(op[key], str):
            return INVALID_OP
    for key in _OPTIONAL_INT:
        if op.get(key) is not None and not _is_int(op[key]):
            return INVALID_OP
    if op.get("kind") not in ("fact", "patch"):
        return INVALID_OP
    if not isinstance(op.get("payload"), dict):
        return INVALID_OP
    return None


def journal_error(op: dict[str, Any]) -> str | None:
    """For fact ops carrying ``tables.journal_lines``: Σ debit must equal Σ credit."""
    if op["kind"] != "fact":
        return None
    tables = op["payload"].get("tables")
    if tables is None:
        return None
    if not isinstance(tables, dict):
        return INVALID_OP
    if "journal_lines" not in tables:
        return None
    lines = tables["journal_lines"]
    if not isinstance(lines, list):
        return INVALID_OP
    debit = credit = 0
    for line in lines:
        if not isinstance(line, dict):
            return INVALID_OP
        d = line.get("debit_paise") or 0
        c = line.get("credit_paise") or 0
        if not _is_int(d) or not _is_int(c):
            return INVALID_OP
        debit += d
        credit += c
    return UNBALANCED_JOURNAL if debit != credit else None


@dataclass
class PushResult:
    acked: list[dict[str, Any]] = field(default_factory=list)
    rejected: list[dict[str, Any]] = field(default_factory=list)


def _existing_seqs(db: Session, org_id: str, op_ids: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    unique = list(dict.fromkeys(op_ids))
    for start in range(0, len(unique), 500):
        chunk = unique[start : start + 500]
        rows = db.execute(select(Op.op_id, Op.seq).where(Op.org_id == org_id, Op.op_id.in_(chunk)))
        found.update({op_id: seq for op_id, seq in rows})
    return found


def push_ops(db: Session, device: Device, ops: list[dict[str, Any]]) -> PushResult:
    """Verify and append ``ops`` for ``device`` in order, in one transaction.

    The caller must hold the app's write lock so seq numbers are assigned without races.
    """
    org_id = device.org_id
    result = PushResult()

    # Start the SQLite write transaction first, so everything read below is current and
    # nothing else (even another process) can append to this org until we commit.
    db.execute(text("UPDATE orgs SET last_seq = last_seq WHERE id = :id"), {"id": org_id})
    last_seq = db.scalar(select(Org.last_seq).where(Org.id == org_id)) or 0
    head: str | None = db.scalar(select(Device.last_hash).where(Device.device_id == device.device_id))
    head_hlc: str | None = None

    op_ids = [op["op_id"] for op in ops if isinstance(op.get("op_id"), str)]
    existing = _existing_seqs(db, org_id, op_ids)

    broken = False
    stored = 0
    received_at = now_ms()
    for op in ops:
        raw_id = op.get("op_id")
        op_id = raw_id if isinstance(raw_id, str) else None

        if op_id is not None and op_id in existing:
            result.acked.append({"op_id": op_id, "seq": existing[op_id]})
            continue
        if broken:
            result.rejected.append({"op_id": op_id, "reason": CHAIN_BROKEN})
            continue

        reason = envelope_error(op)
        if reason is None and op["device_id"] != device.device_id:
            reason = DEVICE_MISMATCH
        if reason is None:
            try:
                if compute_op_hash(op) != op["hash"]:
                    reason = BAD_HASH
            except ValueError:  # NaN / Infinity cannot come from a JS client
                reason = INVALID_OP
        if reason is None and op.get("prev_hash") != head:
            reason = CHAIN_BROKEN
        if reason is None:
            reason = journal_error(op)
        if reason is not None:
            result.rejected.append({"op_id": op_id, "reason": reason})
            broken = True
            continue

        last_seq += 1
        stored_op = {k: v for k, v in op.items() if k != "seq"}
        db.add(
            Op(
                org_id=org_id,
                seq=last_seq,
                op_id=op["op_id"],
                device_id=op["device_id"],
                user_id=op.get("user_id"),
                hlc=op["hlc"],
                kind=op["kind"],
                op_type=op.get("type"),
                entity=op.get("entity"),
                entity_id=op.get("entity_id"),
                business_id=op.get("business_id"),
                branch_id=op.get("branch_id"),
                created_at=op.get("created_at"),
                received_at=received_at,
                prev_hash=op.get("prev_hash"),
                hash=op["hash"],
                op_json=canonical_json(stored_op),
            )
        )
        project_op(db, org_id, stored_op)
        existing[op["op_id"]] = last_seq
        head = op["hash"]
        head_hlc = op["hlc"]
        stored += 1
        result.acked.append({"op_id": op["op_id"], "seq": last_seq})

    if stored:
        db.execute(
            text("UPDATE orgs SET last_seq = :seq WHERE id = :id"), {"seq": last_seq, "id": org_id}
        )
        device.last_hash = head
        device.last_hlc = head_hlc
    device.last_seen_at = received_at
    db.commit()
    return result
