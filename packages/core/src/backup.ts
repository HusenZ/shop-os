import { sha256BytesHex } from './canonical';
import type { ShopEngine } from './engine';

/**
 * Backup file (.shopos):
 *   "SHOPOS" 0x01 | uint32 BE header length | header JSON (plaintext) | body
 * body = gzip(SQLite database bytes), then AES-GCM when a passphrase is given.
 * key = PBKDF2-SHA256(passphrase, salt, 600k iterations).
 */
export interface BackupHeader {
  format: 'shopos-backup';
  format_v: 1;
  schema_v: number;
  app_v: string;
  created_at: number;
  device_id: string;
  business_name: string | null;
  counts: Record<string, number>;
  sha256: string;
  encrypted: boolean;
  kdf?: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher?: { name: 'AES-GCM'; iv: string };
}

const MAGIC = new Uint8Array([0x53, 0x48, 0x4f, 0x50, 0x4f, 0x53, 0x01]); // "SHOPOS" 1
const ITERATIONS = 600_000;

const b64 = {
  enc: (u: Uint8Array) => {
    let s = '';
    for (const b of u) s += String.fromCharCode(b);
    return btoa(s);
  },
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as any);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function backupCounts(e: ShopEngine): Record<string, number> {
  const tables = ['products', 'parties', 'sales_docs', 'purchase_docs', 'journal_entries', 'stock_movements', 'ops'];
  return Object.fromEntries(tables.map((t) => [t, e.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)?.n ?? 0]));
}

export async function createBackupFile(
  dbBytes: Uint8Array,
  info: Pick<BackupHeader, 'schema_v' | 'app_v' | 'device_id' | 'business_name' | 'counts'> & { created_at?: number },
  passphrase?: string,
): Promise<Uint8Array> {
  const gz = await transform(dbBytes, new CompressionStream('gzip'));
  const header: BackupHeader = {
    format: 'shopos-backup',
    format_v: 1,
    created_at: info.created_at ?? Date.now(),
    schema_v: info.schema_v,
    app_v: info.app_v,
    device_id: info.device_id,
    business_name: info.business_name,
    counts: info.counts,
    sha256: sha256BytesHex(dbBytes),
    encrypted: Boolean(passphrase),
  };
  let body = gz;
  if (passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz as BufferSource));
    header.kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64.enc(salt) };
    header.cipher = { name: 'AES-GCM', iv: b64.enc(iv) };
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + body.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length);
  out.set(headerBytes, MAGIC.length + 4);
  out.set(body, MAGIC.length + 4 + headerBytes.length);
  return out;
}

export class BackupError extends Error {}

export function readBackupHeader(file: Uint8Array): { header: BackupHeader; bodyOffset: number } {
  if (file.length < MAGIC.length + 4 || !MAGIC.every((b, i) => file[i] === b)) throw new BackupError('This is not a ShopOS backup file');
  const len = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(MAGIC.length);
  const header = JSON.parse(new TextDecoder().decode(file.subarray(MAGIC.length + 4, MAGIC.length + 4 + len))) as BackupHeader;
  if (header.format !== 'shopos-backup') throw new BackupError('Unknown backup format');
  return { header, bodyOffset: MAGIC.length + 4 + len };
}

export async function openBackupFile(file: Uint8Array, passphrase?: string): Promise<{ header: BackupHeader; dbBytes: Uint8Array }> {
  const { header, bodyOffset } = readBackupHeader(file);
  let body = file.subarray(bodyOffset);
  if (header.encrypted) {
    if (!passphrase) throw new BackupError('This backup is protected. Enter its passphrase.');
    const key = await deriveKey(passphrase, b64.dec(header.kdf!.salt), header.kdf!.iterations);
    try {
      body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(header.cipher!.iv) as BufferSource }, key, body as BufferSource));
    } catch {
      throw new BackupError('Wrong passphrase, or the file is damaged');
    }
  }
  const dbBytes = await transform(body, new DecompressionStream('gzip'));
  if (sha256BytesHex(dbBytes) !== header.sha256) throw new BackupError('The backup is damaged (checksum mismatch)');
  return { header, dbBytes };
}
