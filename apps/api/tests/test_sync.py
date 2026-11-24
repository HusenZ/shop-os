from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor

import pytest

from .helpers import OpChain, auth, create_org, enrol, op_hash, pull, push, rehash


@pytest.fixture
def org(client):
    owner = create_org(client)
    a = enrol(client, owner["access_token"], "dev-a", "Counter 1")
    b = enrol(client, owner["access_token"], "dev-b", "Counter 2")
    return {
        "owner": owner,
        "jwt": owner["access_token"],
        "a": a["device_token"],
        "b": b["device_token"],
        "chain_a": OpChain("dev-a"),
        "chain_b": OpChain("dev-b"),
    }


def test_push_then_pull_with_seq_and_cursor_paging(client, org):
    chain = org["chain_a"]
    ops = [chain.note(f"note {i} — नमस्ते") for i in range(5)]
    res = push(client, org["a"], ops)
    assert res["rejected"] == []
    assert res["acked"] == [{"op_id": op["op_id"], "seq": i + 1} for i, op in enumerate(ops)]

    page1 = pull(client, org["b"], cursor=0, limit=2)
    assert [op["seq"] for op in page1["ops"]] == [1, 2]
    assert page1["next_cursor"] == 2 and page1["more"] is True
    page2 = pull(client, org["b"], cursor=page1["next_cursor"], limit=2)
    assert [op["seq"] for op in page2["ops"]] == [3, 4]
    assert page2["next_cursor"] == 4 and page2["more"] is True
    page3 = pull(client, org["b"], cursor=page2["next_cursor"], limit=2)
    assert [op["seq"] for op in page3["ops"]] == [5]
    assert page3["next_cursor"] == 5 and page3["more"] is False
    empty = pull(client, org["b"], cursor=5, limit=2)
    assert empty == {"ops": [], "next_cursor": 5, "more": False}

    pulled = page1["ops"] + page2["ops"] + page3["ops"]
    for original, received in zip(ops, pulled, strict=True):
        # Same op back (plus seq), and it re-hashes to the same value.
        assert {k: v for k, v in received.items() if k != "seq"} == original
        assert op_hash(received) == original["hash"]
    assert pulled[0]["payload"]["tables"]["notes"][0]["text"] == "note 0 — नमस्ते"


def test_pull_never_returns_own_ops(client, org):
    a_ops = [org["chain_a"].note("from a") for _ in range(3)]
    push(client, org["a"], a_ops)
    b_ops = [org["chain_b"].note("from b") for _ in range(2)]
    res = push(client, org["b"], b_ops)
    assert [ack["seq"] for ack in res["acked"]] == [4, 5]

    # B scans everything but only receives A's ops.
    page = pull(client, org["b"], cursor=0, limit=10)
    assert {op["device_id"] for op in page["ops"]} == {"dev-a"}
    assert page["next_cursor"] == 5 and page["more"] is False

    # A window of only B's own ops still advances the cursor.
    own_window = pull(client, org["b"], cursor=3, limit=2)
    assert own_window == {"ops": [], "next_cursor": 5, "more": False}

    page_a = pull(client, org["a"], cursor=0)
    assert [op["seq"] for op in page_a["ops"]] == [4, 5]
    assert {op["device_id"] for op in page_a["ops"]} == {"dev-b"}


def test_status_reports_latest_seq_and_chain_head(client, org):
    ops = [org["chain_a"].note() for _ in range(3)]
    push(client, org["a"], ops)
    status = client.get("/v1/sync/status", headers=auth(org["a"])).json()
    assert status == {
        "org_id": org["owner"]["org_id"],
        "device_id": "dev-a",
        "series_code": "A",
        "latest_seq": 3,
        "last_hash": ops[-1]["hash"],
    }
    devices = {d["device_id"]: d for d in client.get("/v1/devices", headers=auth(org["jwt"])).json()}
    assert devices["dev-a"]["last_hash"] == ops[-1]["hash"]
    assert devices["dev-a"]["last_seen_at"] is not None


def test_repush_is_idempotent(client, org):
    ops = [org["chain_a"].note() for _ in range(3)]
    first = push(client, org["a"], ops)
    again = push(client, org["a"], ops)
    assert again == first
    # Duplicates inside one batch are acked too.
    nxt = org["chain_a"].note()
    res = push(client, org["a"], [ops[0], nxt, nxt])
    assert res["rejected"] == []
    assert res["acked"] == [
        {"op_id": ops[0]["op_id"], "seq": 1},
        {"op_id": nxt["op_id"], "seq": 4},
        {"op_id": nxt["op_id"], "seq": 4},
    ]
    assert client.get("/v1/sync/status", headers=auth(org["a"])).json()["latest_seq"] == 4


def test_bad_hash_on_tampered_payload(client, org):
    chain = org["chain_a"]
    good = chain.note("fine")
    tampered = chain.note("original text")
    tampered["payload"]["tables"]["notes"][0]["text"] = "edited after hashing"
    after = chain.note("after")
    res = push(client, org["a"], [good, tampered, after])
    assert res["acked"] == [{"op_id": good["op_id"], "seq": 1}]
    assert res["rejected"] == [
        {"op_id": tampered["op_id"], "reason": "bad_hash"},
        {"op_id": after["op_id"], "reason": "chain_broken"},
    ]


def test_chain_broken_rejects_rest_of_batch(client, org):
    chain = org["chain_a"]
    first = chain.note("one")
    push(client, org["a"], [first])

    wrong = copy.deepcopy(chain.note("two"))
    wrong["prev_hash"] = "f" * 64
    rehash(wrong)  # the hash itself is valid; only the link is wrong
    # A perfectly valid continuation of the stored chain, sent after the bad op.
    chain.prev_hash = first["hash"]
    valid_next = chain.note("three")
    res = push(client, org["a"], [wrong, valid_next, first])
    assert res["rejected"] == [
        {"op_id": wrong["op_id"], "reason": "chain_broken"},
        {"op_id": valid_next["op_id"], "reason": "chain_broken"},
    ]
    # Already stored op_ids are still acked after the rejection.
    assert res["acked"] == [{"op_id": first["op_id"], "seq": 1}]

    # Sent alone, the valid continuation is accepted.
    assert push(client, org["a"], [valid_next])["acked"] == [{"op_id": valid_next["op_id"], "seq": 2}]


def test_first_op_must_have_null_prev_hash(client, org):
    op = org["chain_a"].note()
    op["prev_hash"] = "a" * 64
    rehash(op)
    res = push(client, org["a"], [op])
    assert res["rejected"] == [{"op_id": op["op_id"], "reason": "chain_broken"}]


def test_device_mismatch(client, org):
    foreign = org["chain_b"].note("B's op sent with A's token")
    res = push(client, org["a"], [foreign])
    assert res == {"acked": [], "rejected": [{"op_id": foreign["op_id"], "reason": "device_mismatch"}]}


def test_unbalanced_journal(client, org):
    chain = org["chain_a"]
    entry_id = "je-1"
    tables = {
        "journal_entries": [{"id": entry_id, "business_date": "2026-11-01"}],
        "journal_lines": [
            {"id": "jl-1", "entry_id": entry_id, "account_id": "acc-cash", "debit_paise": 10000, "credit_paise": 0},
            {"id": "jl-2", "entry_id": entry_id, "account_id": "acc-sales", "debit_paise": 0, "credit_paise": 9999},
        ],
    }
    op = chain.fact("sale.issued", "sales_docs", "sd-1", tables)
    res = push(client, org["a"], [op])
    assert res["rejected"] == [{"op_id": op["op_id"], "reason": "unbalanced_journal"}]
    assert client.get("/v1/sync/status", headers=auth(org["a"])).json()["latest_seq"] == 0


def test_malformed_op_is_rejected_not_500(client, org):
    op = org["chain_a"].note()
    del op["hlc"]
    res = push(client, org["a"], [op, {"not": "an op"}])
    assert res["rejected"] == [
        {"op_id": op["op_id"], "reason": "invalid_op"},
        {"op_id": None, "reason": "chain_broken"},
    ]


def test_push_batch_limit(client, org):
    res = client.post("/v1/sync/push", json={"ops": [{}] * 1001}, headers=auth(org["a"]))
    assert res.status_code == 422


def test_pull_limit_validation(client, org):
    push(client, org["a"], [org["chain_a"].note() for _ in range(3)])
    assert client.get("/v1/sync/pull?limit=0", headers=auth(org["b"])).status_code == 422
    assert client.get("/v1/sync/pull?cursor=-1", headers=auth(org["b"])).status_code == 422
    big = pull(client, org["b"], cursor=0, limit=100_000)  # clamped to 2000, not an error
    assert len(big["ops"]) == 3
    default = pull(client, org["b"])
    assert len(default["ops"]) == 3 and default["next_cursor"] == 3


def test_orgs_are_isolated(client, org):
    push(client, org["a"], [org["chain_a"].note() for _ in range(2)])
    other = create_org(client, email="other@shop.test")
    x = enrol(client, other["access_token"], "dev-x")
    assert pull(client, x["device_token"]) == {"ops": [], "next_cursor": 0, "more": False}
    res = push(client, x["device_token"], [OpChain("dev-x").note()])
    assert res["acked"][0]["seq"] == 1  # seq is per org


def test_revoked_device_gets_403_everywhere(client, org):
    push(client, org["a"], [org["chain_a"].note()])
    res = client.post("/v1/devices/dev-b/revoke", headers=auth(org["jwt"]))
    assert res.status_code == 200 and res.json()["revoked_at"] is not None

    headers = auth(org["b"])
    calls = [
        client.post("/v1/sync/push", json={"ops": []}, headers=headers),
        client.get("/v1/sync/pull", headers=headers),
        client.get("/v1/sync/status", headers=headers),
        client.put("/v1/backups", content=b"x", headers=headers),
        client.get("/v1/backups", headers=headers),
        client.get("/v1/backups/whatever", headers=headers),
    ]
    for call in calls:
        assert call.status_code == 403, call.request.url
        assert call.json() == {"detail": "device_revoked"}

    # Device A is unaffected; unknown tokens are 401.
    assert client.get("/v1/sync/status", headers=auth(org["a"])).status_code == 200
    assert client.get("/v1/sync/status", headers=auth("nope")).status_code == 401
    assert client.get("/v1/sync/status").status_code == 401


def test_concurrent_pushes_get_gap_free_seqs(client, org):
    batches = {
        "a": [[org["chain_a"].note(f"a{i}")] for i in range(15)],
        "b": [[org["chain_b"].note(f"b{i}")] for i in range(15)],
    }

    def run(device: str) -> list[int]:
        seqs = []
        for batch in batches[device]:
            res = push(client, org[device], batch)
            assert res["rejected"] == []
            seqs.extend(ack["seq"] for ack in res["acked"])
        return seqs

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, ["a", "b"]))
    all_seqs = sorted(results[0] + results[1])
    assert all_seqs == list(range(1, 31))
    assert results[0] == sorted(results[0]) and results[1] == sorted(results[1])
