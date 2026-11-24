import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Canonical JSON: keys sorted at every level, no whitespace, undefined keys
 * dropped. Matches Python `json.dumps(obj, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for the integer/string/null/boolean payloads ShopOS uses.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error(`floats are not allowed in ops: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v ?? null)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function sha256BytesHex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
