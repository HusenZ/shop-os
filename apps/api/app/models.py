"""ORM tables. Timestamps are integer milliseconds since the Unix epoch (UTC)."""

from __future__ import annotations

from sqlalchemy import BigInteger, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Org(Base):
    __tablename__ = "orgs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[int] = mapped_column(BigInteger)
    # Highest seq handed out in this org; seqs are 1..last_seq with no gaps.
    last_seq: Mapped[int] = mapped_column(BigInteger, default=0)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[int] = mapped_column(BigInteger)


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("org_id", "series_code", name="uq_devices_org_series"),)

    # Device ids are chosen by the client and are global: one device belongs to one org.
    device_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    series_code: Mapped[str] = mapped_column(String(8))
    # sha256 hex of the current device token; the token itself is never stored.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    enrolled_by: Mapped[str] = mapped_column(String(64))
    enrolled_at: Mapped[int] = mapped_column(BigInteger)
    last_seen_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Hash of the last op stored for this device (head of its chain).
    last_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_hlc: Mapped[str | None] = mapped_column(String(200), nullable=True)


class Op(Base):
    """Append-only, verified op log. ``op_json`` is the canonical JSON of the op as received."""

    __tablename__ = "ops"
    __table_args__ = (
        UniqueConstraint("org_id", "op_id", name="uq_ops_org_op_id"),
        Index("ix_ops_org_device", "org_id", "device_id"),
    )

    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    op_id: Mapped[str] = mapped_column(String(128))
    device_id: Mapped[str] = mapped_column(String(128))
    user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    hlc: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))
    op_type: Mapped[str | None] = mapped_column("type", String(128), nullable=True)
    entity: Mapped[str | None] = mapped_column(String(128), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    business_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    branch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    received_at: Mapped[int] = mapped_column(BigInteger)
    prev_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    hash: Mapped[str] = mapped_column(String(128))
    op_json: Mapped[str] = mapped_column(Text)


class Backup(Base):
    __tablename__ = "backups"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"), index=True)
    device_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(BigInteger)
    file_name: Mapped[str] = mapped_column(String(255))


# ---------------------------------------------------------------------------
# Server-side projections (rebuildable from ``ops``)
# ---------------------------------------------------------------------------


class SrvJournalLine(Base):
    __tablename__ = "srv_journal_lines"
    __table_args__ = (Index("ix_srv_jl_org_date", "org_id", "business_date"),)

    org_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    op_id: Mapped[str] = mapped_column(String(128))
    business_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    branch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    business_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    account_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    party_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    debit_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    credit_paise: Mapped[int] = mapped_column(BigInteger, default=0)


class SrvAccount(Base):
    __tablename__ = "srv_accounts"

    org_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    business_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    system_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # JSON object {field: hlc} - the hlc of the op that last wrote each field.
    field_hlc: Mapped[str] = mapped_column(Text, default="{}")


class SrvBranch(Base):
    __tablename__ = "srv_branches"

    org_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    business_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    field_hlc: Mapped[str] = mapped_column(Text, default="{}")


__all__ = [
    "Backup",
    "Device",
    "Op",
    "Org",
    "SrvAccount",
    "SrvBranch",
    "SrvJournalLine",
    "User",
]
