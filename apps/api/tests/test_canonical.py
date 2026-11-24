from __future__ import annotations

import hashlib
import json

from app.canonical import canonical_json, compute_op_hash

from .helpers import OpChain, op_hash


def test_canonical_json_format():
    value = {"b": 1, "a": {"z": None, "y": [3, {"k": True, "j": "₹ नमस्ते"}]}, "c": "x\"\n"}
    assert canonical_json(value) == '{"a":{"y":[3,{"j":"₹ नमस्ते","k":true}],"z":null},"b":1,"c":"x\\"\\n"}'


def test_matches_javascript_number_and_string_quirks():
    # JSON.stringify(1.0) === "1"; lone surrogates are escaped, lowercase hex.
    assert canonical_json({"n": 1.0, "m": -0.5}) == '{"m":-0.5,"n":1}'
    assert canonical_json({"s": "a\ud800b"}) == '{"s":"a\\ud800b"}'
    assert canonical_json({"c": "\u001f"}) == '{"c":"\\u001f"}'


def test_hash_rule_excludes_hash_and_seq_but_includes_prev_hash():
    op = OpChain("dev-a").note("hi")
    body = {k: v for k, v in op.items() if k != "hash"}
    expected = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    assert compute_op_hash(op) == expected == op["hash"] == op_hash(op)
    assert compute_op_hash({**op, "seq": 42}) == op["hash"]
    assert compute_op_hash({**op, "prev_hash": "00"}) != op["hash"]
