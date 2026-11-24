"""Server-side projections built from stored ops, for consolidated reports.

* Fact ops: ``payload.tables.journal_lines`` rows -> ``srv_journal_lines`` (insert-or-ignore by id).
* Patch ops on ``accounts`` / ``branches`` -> ``srv_accounts`` / ``srv_branches``, merged per
  field, last writer wins by the op's HLC (an older HLC never overwrites a newer value).

Both are idempotent and independent of arrival order, so they can be rebuilt from ``ops``.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from .canonical import canonical_json
from .models import SrvAccount, SrvBranch, SrvJournalLine

ACCOUNT_FIELDS = ("business_id", "code", "name", "type", "system_key")
BRANCH_FIELDS = ("business_id", "name", "code")

REFERENCE_TABLES: dict[str, tuple[type, tuple[str, ...]]] = {
    "accounts": (SrvAccount, ACCOUNT_FIELDS),
    "branches": (SrvBranch, BRANCH_FIELDS),
}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _first(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _as_int(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return 0


def to_business_date(value: Any) -> str | None:
    """``YYYY-MM-DD`` from a date string, an ISO timestamp, or epoch milliseconds (UTC)."""
    if isinstance(value, str) and _DATE_RE.match(value):
        return value[:10]
    if isinstance(value, int) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value / 1000, tz=UTC).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    return None


def project_op(db: Session, org_id: str, op: dict[str, Any]) -> None:
    payload = op.get("payload")
    if not isinstance(payload, dict):
        return
    if op.get("kind") == "fact":
        tables = payload.get("tables")
        if isinstance(tables, dict):
            _project_journal_lines(db, org_id, op, tables)
            _project_reference_rows(db, org_id, op, tables)
    elif op.get("kind") == "patch":
        _project_patch(db, org_id, op, payload)


# --- journal lines -----------------------------------------------------------------


def _project_journal_lines(db: Session, org_id: str, op: dict[str, Any], tables: dict) -> None:
    lines = tables.get("journal_lines")
    if not isinstance(lines, list):
        return
    entries: dict[str, dict] = {}
    raw_entries = tables.get("journal_entries")
    if isinstance(raw_entries, list):
        for entry in raw_entries:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                entries[entry["id"]] = entry

    fallback_date = to_business_date(op.get("created_at"))
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("id"), str):
            continue
        if db.get(SrvJournalLine, (org_id, line["id"])) is not None:
            continue  # insert-or-ignore: facts never change
        entry = entries.get(line.get("entry_id"), {}) if isinstance(line.get("entry_id"), str) else {}
        db.add(
            SrvJournalLine(
                org_id=org_id,
                id=line["id"],
                op_id=op["op_id"],
                business_id=_as_str(
                    _first(line.get("business_id"), entry.get("business_id"), op.get("business_id"))
                ),
                branch_id=_as_str(
                    _first(line.get("branch_id"), entry.get("branch_id"), op.get("branch_id"))
                ),
                business_date=_first(
                    to_business_date(line.get("business_date")),
                    to_business_date(entry.get("business_date")),
                    fallback_date,
                ),
                account_id=_as_str(line.get("account_id")),
                party_id=_as_str(line.get("party_id")),
                debit_paise=_as_int(line.get("debit_paise")),
                credit_paise=_as_int(line.get("credit_paise")),
            )
        )
        db.flush()


# --- reference data (accounts, branches) -------------------------------------------------


def merge_reference(
    db: Session,
    table: str,
    org_id: str,
    row_id: str,
    values: dict[str, Any],
    hlc: str,
    default_business_id: str | None,
) -> None:
    """Merge ``values`` into the projected row field by field; newer HLC wins per field."""
    model, fields = REFERENCE_TABLES[table]
    row = db.get(model, (org_id, row_id))
    if row is None:
        row = model(org_id=org_id, id=row_id, field_hlc="{}")
        db.add(row)
    stamps: dict[str, str] = json.loads(row.field_hlc or "{}")
    for name in fields:
        if name not in values:
            continue
        previous = stamps.get(name)
        if previous is not None and previous >= hlc:
            continue  # an older (or the same) write never overwrites a newer value
        setattr(row, name, _as_str(values[name]))
        stamps[name] = hlc
    if row.business_id is None and default_business_id is not None:
        # Not stamped: an explicit business_id from any op still wins later.
        row.business_id = default_business_id
    row.field_hlc = canonical_json(stamps)
    db.flush()


def _project_patch(db: Session, org_id: str, op: dict[str, Any], payload: dict) -> None:
    table = payload.get("table")
    if not isinstance(table, str):
        table = op.get("entity")
    if table not in REFERENCE_TABLES:
        return
    row_id = payload.get("id")
    if not isinstance(row_id, str):
        row_id = op.get("entity_id")
    if not isinstance(row_id, str) or not row_id:
        return
    values = payload.get("set")
    if not isinstance(values, dict):
        values = {}
    # ``create: true`` inserts the row if missing. A non-create patch for a row the hub has
    # not seen also creates it (holding only the patched fields), so the projection
    # converges whatever order ops arrive in.
    merge_reference(db, table, org_id, row_id, values, op["hlc"], _as_str(op.get("business_id")))


def _project_reference_rows(db: Session, org_id: str, op: dict[str, Any], tables: dict) -> None:
    """Extension: ``accounts`` / ``branches`` rows inside a fact op count as creates at its HLC."""
    for table in REFERENCE_TABLES:
        rows = tables.get(table)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]:
                merge_reference(
                    db, table, org_id, row["id"], row, op["hlc"], _as_str(op.get("business_id"))
                )
