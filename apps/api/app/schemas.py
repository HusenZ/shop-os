"""Request and response bodies."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# --- auth ---------------------------------------------------------------------


class OrgCreate(BaseModel):
    org_name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=6, max_length=1024)


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class AuthResponse(BaseModel):
    org_id: str
    user_id: str
    access_token: str


# --- devices -------------------------------------------------------------------


class EnrolRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    preferred_series: str | None = Field(default=None, max_length=8)


class EnrolResponse(BaseModel):
    device_id: str
    device_token: str
    series_code: str
    org_id: str


class DeviceOut(BaseModel):
    device_id: str
    name: str
    series_code: str
    enrolled_at: int
    last_seen_at: int | None
    revoked_at: int | None
    last_hash: str | None


# --- sync ----------------------------------------------------------------------


class PushRequest(BaseModel):
    # Ops are kept as plain dicts so the hash is checked on exactly what the client sent.
    ops: list[dict[str, Any]] = Field(max_length=1000)


class Ack(BaseModel):
    op_id: str
    seq: int


class Rejection(BaseModel):
    op_id: str | None
    reason: str


class PushResponse(BaseModel):
    acked: list[Ack]
    rejected: list[Rejection]


class PullResponse(BaseModel):
    ops: list[dict[str, Any]]
    next_cursor: int
    more: bool


class SyncStatus(BaseModel):
    org_id: str
    device_id: str
    series_code: str
    latest_seq: int
    last_hash: str | None


# --- backups -------------------------------------------------------------------


class BackupCreated(BaseModel):
    backup_id: str
    size: int
    sha256: str
    created_at: int


class BackupOut(BackupCreated):
    name: str | None
    device_id: str


# --- reports -------------------------------------------------------------------


class PnlBranch(BaseModel):
    branch_id: str | None
    branch_name: str | None
    income_paise: int
    expense_paise: int
    net_profit_paise: int


class PnlAccount(BaseModel):
    account_id: str
    code: str | None
    name: str | None
    type: str
    by_branch: dict[str, int]
    total_paise: int


class PnlTotal(BaseModel):
    income_paise: int
    expense_paise: int
    net_profit_paise: int


class PnlReport(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    branches: list[PnlBranch]
    accounts: list[PnlAccount]
    total: PnlTotal


class TrialBalanceAccount(BaseModel):
    account_id: str | None
    code: str | None
    name: str | None
    type: str | None
    debit_paise: int
    credit_paise: int


class TrialBalance(BaseModel):
    as_of: str
    accounts: list[TrialBalanceAccount]
    total_debit_paise: int
    total_credit_paise: int
    balanced: bool


class Health(BaseModel):
    status: str
