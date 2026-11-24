"""Consolidated reports from the server projections (owner JWT). Amounts are integer paise."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import and_, func, select

from ..deps import DbSession, Owner
from ..models import SrvAccount, SrvBranch, SrvJournalLine
from ..schemas import (
    PnlAccount,
    PnlBranch,
    PnlReport,
    PnlTotal,
    TrialBalance,
    TrialBalanceAccount,
)

router = APIRouter(prefix="/v1/reports", tags=["reports"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Key used in ``by_branch`` for lines that carry no branch.
NO_BRANCH_KEY = "null"


def _parse_date(value: str, name: str) -> str:
    if not _DATE_RE.match(value):
        raise HTTPException(status_code=422, detail=f"invalid_{name}")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"invalid_{name}") from None
    return value


def _sort_key(code: str | None, name: str | None, ident: str | None) -> tuple:
    return (code is None, code or "", name or "", ident or "")


@router.get("/pnl", response_model=PnlReport)
def profit_and_loss(
    owner: Owner,
    db: DbSession,
    from_: Annotated[str, Query(alias="from", description="YYYY-MM-DD, inclusive")],
    to: Annotated[str, Query(description="YYYY-MM-DD, inclusive")],
    business_id: Annotated[str | None, Query(description="Limit to one business")] = None,
) -> PnlReport:
    start = _parse_date(from_, "from")
    end = _parse_date(to, "to")
    if start > end:
        raise HTTPException(status_code=422, detail="from_after_to")

    line = SrvJournalLine
    acct = SrvAccount
    query = (
        select(
            line.account_id,
            line.branch_id,
            acct.code,
            acct.name,
            acct.type,
            func.coalesce(func.sum(line.debit_paise), 0),
            func.coalesce(func.sum(line.credit_paise), 0),
        )
        .join(acct, and_(acct.org_id == line.org_id, acct.id == line.account_id))
        .where(
            line.org_id == owner.org_id,
            line.business_date >= start,
            line.business_date <= end,
            acct.type.in_(("income", "expense")),
        )
        .group_by(line.account_id, line.branch_id, acct.code, acct.name, acct.type)
    )
    if business_id is not None:
        query = query.where(line.business_id == business_id)

    accounts: dict[str, dict] = {}
    branch_totals: dict[str | None, dict[str, int]] = defaultdict(lambda: {"income": 0, "expense": 0})
    for account_id, branch_id, code, name, kind, debit, credit in db.execute(query):
        amount = int(credit) - int(debit) if kind == "income" else int(debit) - int(credit)
        entry = accounts.setdefault(
            account_id,
            {"account_id": account_id, "code": code, "name": name, "type": kind, "by_branch": {}},
        )
        key = branch_id if branch_id is not None else NO_BRANCH_KEY
        entry["by_branch"][key] = entry["by_branch"].get(key, 0) + amount
        branch_totals[branch_id][kind] += amount

    branch_query = select(SrvBranch).where(SrvBranch.org_id == owner.org_id)
    if business_id is not None:
        branch_query = branch_query.where(SrvBranch.business_id == business_id)
    known = {b.id: b for b in db.scalars(branch_query)}

    branches: list[PnlBranch] = []
    ordered = sorted(known.values(), key=lambda b: _sort_key(b.code, b.name, b.id))
    branch_ids = [b.id for b in ordered] + sorted(
        (bid for bid in branch_totals if bid is not None and bid not in known)
    )
    if None in branch_totals:
        branch_ids.append(None)
    for bid in branch_ids:
        totals = branch_totals.get(bid, {"income": 0, "expense": 0})
        known_branch = known.get(bid) if bid is not None else None
        branches.append(
            PnlBranch(
                branch_id=bid,
                branch_name=known_branch.name if known_branch else None,
                income_paise=totals["income"],
                expense_paise=totals["expense"],
                net_profit_paise=totals["income"] - totals["expense"],
            )
        )

    account_rows = [
        PnlAccount(**entry, total_paise=sum(entry["by_branch"].values()))
        for entry in sorted(
            accounts.values(),
            key=lambda a: (a["type"] != "income", *_sort_key(a["code"], a["name"], a["account_id"])),
        )
    ]
    income = sum(a.total_paise for a in account_rows if a.type == "income")
    expense = sum(a.total_paise for a in account_rows if a.type == "expense")
    return PnlReport(
        from_=start,
        to=end,
        branches=branches,
        accounts=account_rows,
        total=PnlTotal(income_paise=income, expense_paise=expense, net_profit_paise=income - expense),
    )


@router.get("/trial-balance", response_model=TrialBalance)
def trial_balance(
    owner: Owner,
    db: DbSession,
    as_of: Annotated[
        str | None, Query(description="YYYY-MM-DD, inclusive; defaults to today (UTC)")
    ] = None,
    business_id: Annotated[str | None, Query(description="Limit to one business")] = None,
) -> TrialBalance:
    cutoff = _parse_date(as_of, "as_of") if as_of else datetime.now(UTC).date().isoformat()

    line = SrvJournalLine
    acct = SrvAccount
    query = (
        select(
            line.account_id,
            acct.code,
            acct.name,
            acct.type,
            func.coalesce(func.sum(line.debit_paise), 0),
            func.coalesce(func.sum(line.credit_paise), 0),
        )
        .outerjoin(acct, and_(acct.org_id == line.org_id, acct.id == line.account_id))
        .where(line.org_id == owner.org_id, line.business_date <= cutoff)
        .group_by(line.account_id, acct.code, acct.name, acct.type)
    )
    if business_id is not None:
        query = query.where(line.business_id == business_id)

    rows: list[TrialBalanceAccount] = []
    for account_id, code, name, kind, debit, credit in db.execute(query):
        # Closing balance on its natural side: Dr if debits exceed credits, else Cr.
        net = int(debit) - int(credit)
        rows.append(
            TrialBalanceAccount(
                account_id=account_id,
                code=code,
                name=name,
                type=kind,
                debit_paise=net if net > 0 else 0,
                credit_paise=-net if net < 0 else 0,
            )
        )
    rows.sort(key=lambda a: _sort_key(a.code, a.name, a.account_id))
    total_debit = sum(a.debit_paise for a in rows)
    total_credit = sum(a.credit_paise for a in rows)
    return TrialBalance(
        as_of=cutoff,
        accounts=rows,
        total_debit_paise=total_debit,
        total_credit_paise=total_credit,
        balanced=total_debit == total_credit,
    )
