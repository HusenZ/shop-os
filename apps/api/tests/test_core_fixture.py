"""Cross-language check: ops produced by the real TypeScript core (packages/core) must
hash identically in Python and be accepted, relayed and projected by the hub.

The fixture is written by `npm test` in packages/core (test/backup.test.ts)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.canonical import compute_op_hash

from .helpers import auth, create_org, enrol, pull, push

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "core" / "test" / "fixtures" / "ops-from-core.json"

pytestmark = pytest.mark.skipif(not FIXTURE.exists(), reason="run `npm test` in packages/core first")


def load() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_core_ops_hash_identically_in_python():
    data = load()
    ops = data["ops"]
    assert len(ops) > 40
    for op in ops:
        assert compute_op_hash(op) == op["hash"], op["type"]
    # the chain is continuous
    prev = None
    for op in ops:
        assert op["prev_hash"] == prev
        prev = op["hash"]


def test_hub_accepts_relays_and_projects_core_ops(client):
    data = load()
    ops = data["ops"]
    org = create_org(client)
    a = enrol(client, org["access_token"], data["device_id"], name="Counter A", preferred_series="A")
    assert a["series_code"] == "A"
    res = push(client, a["device_token"], ops)
    assert res["rejected"] == []
    assert [x["op_id"] for x in res["acked"]] == [o["op_id"] for o in ops]

    b = enrol(client, org["access_token"], "0190ffff-0000-7000-8000-00000000000b", name="Counter B")
    pulled = pull(client, b["device_token"], limit=2000)
    assert len(pulled["ops"]) == len(ops)
    for got, sent in zip(pulled["ops"], ops):
        assert compute_op_hash(got) == sent["hash"]

    tb = client.get("/v1/reports/trial-balance", params={"as_of": "9999-12-31"}, headers=auth(org["access_token"])).json()
    assert tb["balanced"] is True
    assert tb["total_debit_paise"] > 0
    sale = next(o for o in ops if o["type"] == "sale.issued")
    day = sale["payload"]["tables"]["sales_docs"][0]["business_date"]
    pnl = client.get("/v1/reports/pnl", params={"from": day, "to": day}, headers=auth(org["access_token"])).json()
    expected_sales = sale["payload"]["tables"]["sales_docs"][0]["taxable_paise"]
    sales_row = next(a for a in pnl["accounts"] if a["name"] == "Sales")
    assert sales_row["total_paise"] == expected_sales
