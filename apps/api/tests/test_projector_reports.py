from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.models import SrvAccount, SrvBranch, SrvJournalLine

from .helpers import BUSINESS_ID, DEFAULT_WALL_MS, OpChain, auth, create_org, enrol, push

ACCOUNTS = [
    # id, code, name, type, system_key
    ("acc-cash", "1001", "Cash in hand", "asset", "cash"),
    ("acc-inventory", "1201", "Inventory", "asset", "inventory"),
    ("acc-gst", "2201", "Output GST", "liability", "output_gst"),
    ("acc-capital", "3001", "Owner's capital", "equity", "capital"),
    ("acc-sales", "4001", "Sales", "income", None),
    ("acc-cogs", "5001", "Cost of goods sold", "expense", "cogs"),
    ("acc-rent", "5101", "Rent", "expense", None),
]


def journal(entry_id: str, branch_id: str, business_date: str, lines: list[tuple[str, int, int]]) -> dict:
    """A journal entry plus lines like the client writes them (lines carry no date)."""
    return {
        "journal_entries": [
            {
                "id": entry_id,
                "business_id": BUSINESS_ID,
                "branch_id": branch_id,
                "business_date": business_date,
                "source_type": "sale",
                "source_id": f"src-{entry_id}",
                "narration": None,
                "reverses_id": None,
                "is_adjustment": False,
            }
        ],
        "journal_lines": [
            {
                "id": f"{entry_id}-l{i}",
                "entry_id": entry_id,
                "account_id": account_id,
                "party_id": None,
                "branch_id": branch_id,
                "debit_paise": debit,
                "credit_paise": credit,
                "tax_code": None,
            }
            for i, (account_id, debit, credit) in enumerate(lines)
        ],
    }


@pytest.fixture
def books(client):
    owner = create_org(client)
    jwt = owner["access_token"]
    a = enrol(client, jwt, "dev-a", "Main counter")["device_token"]
    b = enrol(client, jwt, "dev-b", "Mall counter")["device_token"]
    chain_a = OpChain("dev-a", branch_id="br-main")
    # Device B's clock runs a minute behind, so its HLCs sort before A's.
    chain_b = OpChain("dev-b", branch_id="br-mall", wall_ms=DEFAULT_WALL_MS - 60_000)

    setup_ops = [
        chain_a.patch(
            "accounts",
            acc_id,
            {k: v for k, v in
             {"business_id": BUSINESS_ID, "code": code, "name": name, "type": kind, "system_key": key}.items()
             if v is not None},
            create=True,
        )
        for acc_id, code, name, kind, key in ACCOUNTS
    ]
    setup_ops += [
        chain_a.patch("branches", "br-main", {"business_id": BUSINESS_ID, "name": "Main Bazaar", "code": "MB"},
                      create=True),
        chain_a.patch("branches", "br-mall", {"business_id": BUSINESS_ID, "name": "City Mall", "code": "CM"},
                      create=True),
        chain_a.fact("capital.introduced", "journal_entries", "je-open", journal("je-open", "br-main", "2026-10-01", [
            ("acc-cash", 500_000, 0), ("acc-inventory", 200_000, 0), ("acc-capital", 0, 700_000),
        ])),
        chain_a.fact("sale.issued", "sales_docs", "sale-1", journal("je-s1", "br-main", "2026-11-05", [
            ("acc-cash", 11_800, 0), ("acc-sales", 0, 10_000), ("acc-gst", 0, 1_800),
            ("acc-cogs", 6_000, 0), ("acc-inventory", 0, 6_000),
        ])),
        chain_a.fact("expense.recorded", "expenses", "exp-1", journal("je-rent", "br-main", "2026-11-15", [
            ("acc-rent", 5_000, 0), ("acc-cash", 0, 5_000),
        ])),
        chain_a.fact("sale.issued", "sales_docs", "sale-3", journal("je-s3", "br-main", "2026-12-02", [
            ("acc-cash", 1_180, 0), ("acc-sales", 0, 1_000), ("acc-gst", 0, 180),
        ])),
    ]
    res = push(client, a, setup_ops)
    assert res["rejected"] == []

    mall_sale = chain_b.fact("sale.issued", "sales_docs", "sale-2", journal("je-s2", "br-mall", "2026-11-10", [
        ("acc-cash", 23_600, 0), ("acc-sales", 0, 20_000), ("acc-gst", 0, 3_600),
        ("acc-cogs", 12_000, 0), ("acc-inventory", 0, 12_000),
    ]))
    res = push(client, b, [mall_sale])
    assert res["rejected"] == []
    return {"client": client, "jwt": jwt, "a": a, "b": b, "chain_a": chain_a, "chain_b": chain_b,
            "mall_sale": mall_sale, "org_id": owner["org_id"]}


def get_pnl(client, jwt, start="2026-11-01", end="2026-11-30"):
    res = client.get("/v1/reports/pnl", params={"from": start, "to": end}, headers=auth(jwt))
    assert res.status_code == 200, res.text
    return res.json()


def get_tb(client, jwt, as_of="2026-11-30"):
    res = client.get("/v1/reports/trial-balance", params={"as_of": as_of}, headers=auth(jwt))
    assert res.status_code == 200, res.text
    return res.json()


def test_projections_are_built(books):
    client = books["client"]
    with client.app.state.session_factory() as db:
        accounts = {a.id: a for a in db.scalars(select(SrvAccount))}
        branches = {b.id: b for b in db.scalars(select(SrvBranch))}
        lines = list(db.scalars(select(SrvJournalLine)))
    assert set(accounts) == {row[0] for row in ACCOUNTS}
    sales = accounts["acc-sales"]
    assert (sales.code, sales.name, sales.type, sales.business_id) == ("4001", "Sales", "income", BUSINESS_ID)
    assert set(json.loads(sales.field_hlc)) == {"business_id", "code", "name", "type"}
    assert branches["br-mall"].name == "City Mall" and branches["br-mall"].code == "CM"
    assert len(lines) == 3 + 5 + 2 + 3 + 5
    s2 = next(line for line in lines if line.id == "je-s2-l0")
    # business_date and business_id come from the journal entry in the same op.
    assert (s2.business_date, s2.branch_id, s2.business_id) == ("2026-11-10", "br-mall", BUSINESS_ID)
    assert s2.op_id == books["mall_sale"]["op_id"] and s2.debit_paise == 23_600


def test_pnl_by_branch(books):
    pnl = get_pnl(books["client"], books["jwt"])
    assert pnl["from"] == "2026-11-01" and pnl["to"] == "2026-11-30"
    assert pnl["total"] == {"income_paise": 30_000, "expense_paise": 23_000, "net_profit_paise": 7_000}
    assert pnl["branches"] == [
        {"branch_id": "br-mall", "branch_name": "City Mall",
         "income_paise": 20_000, "expense_paise": 12_000, "net_profit_paise": 8_000},
        {"branch_id": "br-main", "branch_name": "Main Bazaar",
         "income_paise": 10_000, "expense_paise": 11_000, "net_profit_paise": -1_000},
    ]
    assert pnl["accounts"] == [
        {"account_id": "acc-sales", "code": "4001", "name": "Sales", "type": "income",
         "by_branch": {"br-main": 10_000, "br-mall": 20_000}, "total_paise": 30_000},
        {"account_id": "acc-cogs", "code": "5001", "name": "Cost of goods sold", "type": "expense",
         "by_branch": {"br-main": 6_000, "br-mall": 12_000}, "total_paise": 18_000},
        {"account_id": "acc-rent", "code": "5101", "name": "Rent", "type": "expense",
         "by_branch": {"br-main": 5_000}, "total_paise": 5_000},
    ]

    # The range is inclusive on both ends, and December's sale is only in a December range.
    one_day = get_pnl(books["client"], books["jwt"], "2026-11-10", "2026-11-10")
    assert one_day["total"] == {"income_paise": 20_000, "expense_paise": 12_000, "net_profit_paise": 8_000}
    december = get_pnl(books["client"], books["jwt"], "2026-12-01", "2026-12-31")
    assert december["total"]["income_paise"] == 1_000


def test_trial_balance(books):
    tb = get_tb(books["client"], books["jwt"])
    assert tb["as_of"] == "2026-11-30"
    rows = {row["account_id"]: (row["debit_paise"], row["credit_paise"]) for row in tb["accounts"]}
    assert rows == {
        "acc-cash": (530_400, 0),
        "acc-inventory": (182_000, 0),
        "acc-gst": (0, 5_400),
        "acc-capital": (0, 700_000),
        "acc-sales": (0, 30_000),
        "acc-cogs": (18_000, 0),
        "acc-rent": (5_000, 0),
    }
    assert [row["code"] for row in tb["accounts"]] == ["1001", "1201", "2201", "3001", "4001", "5001", "5101"]
    assert tb["accounts"][0] == {"account_id": "acc-cash", "code": "1001", "name": "Cash in hand",
                                 "type": "asset", "debit_paise": 530_400, "credit_paise": 0}
    assert tb["total_debit_paise"] == tb["total_credit_paise"] == 735_400
    assert tb["balanced"] is True

    later = get_tb(books["client"], books["jwt"], "2026-12-31")
    rows = {row["account_id"]: (row["debit_paise"], row["credit_paise"]) for row in later["accounts"]}
    assert rows["acc-cash"] == (531_580, 0) and rows["acc-sales"] == (0, 31_000)
    assert later["balanced"] is True

    before_anything = get_tb(books["client"], books["jwt"], "2026-09-30")
    assert before_anything["accounts"] == [] and before_anything["balanced"] is True


def test_repushed_and_duplicate_lines_are_not_double_counted(books):
    client = books["client"]
    # Same op again: acked, no new lines.
    res = push(client, books["b"], [books["mall_sale"]])
    assert res["rejected"] == [] and res["acked"][0]["op_id"] == books["mall_sale"]["op_id"]
    # A different op that repeats existing line ids: stored, but the lines are ignored.
    dup = books["chain_b"].fact("sale.issued", "sales_docs", "sale-2", journal("je-s2", "br-mall", "2026-11-10", [
        ("acc-cash", 23_600, 0), ("acc-sales", 0, 20_000), ("acc-gst", 0, 3_600),
        ("acc-cogs", 12_000, 0), ("acc-inventory", 0, 12_000),
    ]))
    assert push(client, books["b"], [dup])["rejected"] == []
    assert get_pnl(client, books["jwt"])["total"]["income_paise"] == 30_000
    assert get_tb(client, books["jwt"])["total_debit_paise"] == 735_400


def test_older_hlc_patch_does_not_overwrite_newer(books):
    client, jwt = books["client"], books["jwt"]

    # Device B's clock is behind: its rename is older than A's create, so it loses for
    # `name`, but `system_key` was never set, so B's value is kept for that field.
    stale = books["chain_b"].patch("accounts", "acc-sales", {"name": "Stale name", "system_key": "sales"},
                                   before={"name": "Sales"})
    assert push(client, books["b"], [stale])["rejected"] == []
    with client.app.state.session_factory() as db:
        sales = db.get(SrvAccount, (books["org_id"], "acc-sales"))
    assert sales.name == "Sales"
    assert sales.system_key == "sales"

    # A newer rename from A wins...
    newer = books["chain_a"].patch("accounts", "acc-sales", {"name": "Sales revenue"}, before={"name": "Sales"})
    assert push(client, books["a"], [newer])["rejected"] == []
    # ...and a later-arriving patch stamped earlier still does not undo it.
    late_but_old = books["chain_b"].patch("accounts", "acc-sales", {"name": "Older again"},
                                          wall=DEFAULT_WALL_MS - 1)
    assert late_but_old["hlc"] < newer["hlc"]
    assert push(client, books["b"], [late_but_old])["rejected"] == []

    pnl = get_pnl(client, jwt)
    assert pnl["accounts"][0]["name"] == "Sales revenue"
    tb = get_tb(client, jwt)
    assert next(r for r in tb["accounts"] if r["account_id"] == "acc-sales")["name"] == "Sales revenue"

    # Branch renames follow the same rule.
    rename = books["chain_a"].patch("branches", "br-mall", {"name": "City Mall (Phase 2)"})
    assert push(client, books["a"], [rename])["rejected"] == []
    old_rename = books["chain_b"].patch("branches", "br-mall", {"name": "Mall kiosk"})
    assert push(client, books["b"], [old_rename])["rejected"] == []
    assert get_pnl(client, jwt)["branches"][0]["branch_name"] == "City Mall (Phase 2)"


def test_patch_before_create_converges(client):
    """A rename that reaches the hub before the account's create still converges."""
    owner = create_org(client)
    jwt = owner["access_token"]
    a = enrol(client, jwt, "dev-a")["device_token"]
    b = enrol(client, jwt, "dev-b")["device_token"]
    chain_a = OpChain("dev-a", wall_ms=DEFAULT_WALL_MS)
    chain_b = OpChain("dev-b", wall_ms=DEFAULT_WALL_MS + 5_000)
    create = chain_a.patch("accounts", "acc-x", {"code": "4100", "name": "Repairs income", "type": "income"},
                           create=True)
    rename = chain_b.patch("accounts", "acc-x", {"name": "Service income"})
    push(client, b, [rename])
    push(client, a, [create])
    with client.app.state.session_factory() as db:
        row = db.get(SrvAccount, (owner["org_id"], "acc-x"))
    assert (row.code, row.name, row.type) == ("4100", "Service income", "income")


def test_report_validation_and_auth(books):
    client, jwt = books["client"], books["jwt"]
    bad = client.get("/v1/reports/pnl", params={"from": "2026-13-01", "to": "2026-11-30"}, headers=auth(jwt))
    assert bad.status_code == 422
    reversed_range = client.get("/v1/reports/pnl", params={"from": "2026-11-30", "to": "2026-11-01"},
                                headers=auth(jwt))
    assert reversed_range.status_code == 422
    assert client.get("/v1/reports/pnl", params={"from": "2026-11-01"}, headers=auth(jwt)).status_code == 422
    # Device tokens cannot read owner reports.
    res = client.get("/v1/reports/trial-balance", params={"as_of": "2026-11-30"}, headers=auth(books["a"]))
    assert res.status_code == 401
    # Another org sees nothing.
    other = create_org(client, email="other@shop.test")
    pnl = get_pnl(client, other["access_token"])
    assert pnl["accounts"] == [] and pnl["branches"] == []
    assert pnl["total"] == {"income_paise": 0, "expense_paise": 0, "net_profit_paise": 0}
