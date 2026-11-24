# ShopOS sync hub (`apps/api`)

FastAPI service that relays operation logs between the devices of one org. Each device
keeps its own SQLite database and an append-only, hash-chained op log. The hub verifies
every pushed op (hash, chain, journal balance), stores it durably with an org-wide
sequence number, hands it to the org's other devices, and builds small projections
for consolidated reports. It runs fully offline: SQLite, no Docker, no external services.

## Setup, run, test

```bash
cd apps/api
uv sync                                            # Python 3.14 (.python-version) + deps
uv run uvicorn app.main:app --reload --port 8000   # API on http://localhost:8000 (docs at /docs)
uv run pytest -q                                   # each test gets a fresh temp database
```

Run a single worker. Seq numbers are assigned under an in-process lock plus a SQLite
write transaction.

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `SHOPOS_DATA_DIR` | `apps/api/data` | Holds `hub.db` and `backups/` |
| `SHOPOS_DATABASE_URL` | `sqlite:///<data_dir>/hub.db` | Tables are created on startup (`create_all`) |
| `SHOPOS_BACKUP_DIR` | `<data_dir>/backups` | Blobs go in `<backup_dir>/<org_id>/<backup_id>.bin` |
| `SHOPOS_JWT_SECRET` | dev secret (a warning is logged) | Set this outside development |
| `SHOPOS_CORS_ORIGINS` | `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173` | JSON list or comma-separated |
| `SHOPOS_MAX_BACKUP_BYTES` | `52428800` (50 MB) | |

A `.env` file in the working directory is read too.

## Endpoints

Owner endpoints take `Authorization: Bearer <JWT>` (HS256, 7 days, claims `sub` = user
id and `org` = org id). Device endpoints take `Authorization: Bearer <device token>`.
A revoked device gets `403 {"detail":"device_revoked"}` on every device endpoint.
Timestamps are integer milliseconds since the Unix epoch.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | `{status: "ok"}` |
| POST | `/v1/orgs` | none | `{org_name, email, password}` → `201 {org_id, user_id, access_token}`; `409` if the email exists |
| POST | `/v1/auth/login` | none | `{email, password}` → `{org_id, user_id, access_token}`; `401` on bad credentials |
| POST | `/v1/devices/enrol` | JWT | `{device_id, name, preferred_series?}` → `{device_id, device_token, series_code, org_id}` |
| GET | `/v1/devices` | JWT | Devices with `series_code`, `enrolled_at`, `last_seen_at`, `revoked_at`, `last_hash` |
| POST | `/v1/devices/{device_id}/revoke` | JWT | Revokes the device's token |
| POST | `/v1/sync/push` | device | `{ops: [...]}` (max 1000) → `{acked: [{op_id, seq}], rejected: [{op_id, reason}]}` |
| GET | `/v1/sync/pull?cursor=0&limit=500` | device | `{ops: [op + seq], next_cursor, more}` (limit is capped at 2000) |
| GET | `/v1/sync/status` | device | `{org_id, device_id, series_code, latest_seq, last_hash}` |
| PUT | `/v1/backups` | device | Raw body (`application/octet-stream`, max 50 MB, optional `X-Backup-Name`) → `201 {backup_id, size, sha256, created_at}` |
| GET | `/v1/backups` | device | The org's backups, newest first |
| GET | `/v1/backups/{id}` | device | Raw bytes (headers `X-Backup-Sha256`, `Content-Disposition`) |
| GET | `/v1/reports/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD` | JWT | P&L by branch and by account; the range is inclusive |
| GET | `/v1/reports/trial-balance?as_of=YYYY-MM-DD` | JWT | Closing balance per account, with totals and `balanced` |

Both reports also accept an optional `business_id` filter.

### Series codes

Series codes are unique within an org and run `A`…`Z`, then `AA`, `AB`, …. A free
`preferred_series` is granted; otherwise the device gets the first free code. Codes are
never reused, even after a device is revoked, because invoices carry them. Re-enrolling
a `device_id` in the same org issues a fresh token (the old token stops working), keeps
the series and chain head, and clears `revoked_at`. A `device_id` that belongs to
another org gets `409`.

## Op verification (push)

Ops are processed in order. For each op:

1. An `op_id` the org already stores is acked with its existing `seq`. This makes pushes idempotent.
2. After the first rejection in a batch, every later op that is not already stored is rejected as `chain_broken`.
3. A missing or wrongly typed envelope field (`op_id`, `device_id`, `hlc`, `hash`, `kind`, `payload`, …) gives `invalid_op`.
4. `device_id` ≠ the token's device gives `device_mismatch`.
5. `sha256_hex(canonical_json(op without "hash"/"seq"))` ≠ `hash` gives `bad_hash`.
6. `prev_hash` ≠ the device's last stored hash (`null` for its first op) gives `chain_broken`.
7. A fact whose `payload.tables.journal_lines` have Σ`debit_paise` ≠ Σ`credit_paise` gives `unbalanced_journal`.
8. Otherwise the op is stored with the next gap-free org `seq`, the device's `last_hash` moves forward, and the projector runs.

Canonical JSON is `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
The hub stores the canonical text of each op, and pull returns it parsed, so pulled ops
re-hash byte for byte.

## Projections and reports

- `srv_journal_lines`: built from `tables.journal_lines` of fact ops, insert-or-ignore by line id.
  `business_date`, `business_id` and `branch_id` come from the line, then the matching
  `journal_entries` row in the same op, then the op (or the UTC date of `created_at`).
- `srv_accounts` and `srv_branches`: built from patch ops on `accounts` and `branches`.
  Each field is merged last-writer-wins by the op's HLC, with a per-field HLC map. An
  `accounts` or `branches` row inside a fact op counts as a create at that op's HLC.
- P&L: only `income` and `expense` accounts. Income is credit − debit, and expense is debit − credit.
  `by_branch` is keyed by branch id; lines with no branch use the key `"null"`.
- Trial balance: each account's closing balance on its natural side (Dr if debits exceed
  credits, otherwise Cr), for lines dated on or before `as_of`.

## Layout

```
app/
  main.py        create_app() factory + module-level app (CORS, lifespan create_all)
  config.py      Settings (SHOPOS_* env)
  db.py          engine (SQLite WAL, synchronous=FULL), session dependency
  models.py      orgs, users, devices, ops, backups, srv_* projections
  schemas.py     request/response models
  security.py    PBKDF2-SHA256 (200k) passwords, JWT, device tokens (sha256 stored)
  canonical.py   canonical JSON + op hash
  oplog.py       push verification and storage
  projector.py   journal / account / branch projections
  deps.py        owner and device auth dependencies
  routers/       auth, devices, sync, backups, reports
tests/           pytest + TestClient; helpers.py builds ops like the TS client
```
