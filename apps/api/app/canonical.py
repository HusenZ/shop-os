"""Canonical JSON and op hashing, byte-compatible with the TypeScript clients.

Canonical JSON = keys sorted ascending at every level, no whitespace, UTF-8, non-ASCII
characters not escaped. ``hash = sha256_hex(canonical_json(op minus "hash" and "seq"))``.

Two small adjustments make Python's output match ``JSON.stringify`` for inputs the spec
does not promise to exclude:

* floats with an integral value (``1.0``) are written as integers, as JavaScript does;
* lone UTF-16 surrogates are written as ``\\udXXX`` escapes, as ``JSON.stringify`` does.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

HASH_EXCLUDED_KEYS = frozenset({"hash", "seq"})

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _normalize(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e21:
            return int(value)
        return value
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    return value


def canonical_json(value: Any) -> str:
    text = json.dumps(
        _normalize(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    if _LONE_SURROGATE.search(text):
        text = _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)
    return text


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def op_hash_body(op: dict[str, Any]) -> dict[str, Any]:
    """The object that is hashed: the op without ``hash`` and ``seq`` (``prev_hash`` stays)."""
    return {k: v for k, v in op.items() if k not in HASH_EXCLUDED_KEYS}


def compute_op_hash(op: dict[str, Any]) -> str:
    return sha256_hex(canonical_bytes(op_hash_body(op)))
