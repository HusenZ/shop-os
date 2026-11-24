/// <reference lib="webworker" />
/**
 * The DB worker owns SQLite (official WASM build) on OPFS through the SAH-pool VFS.
 * Every ShopOS service runs here, synchronously, inside one transaction per call.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  APP_VERSION,
  backupCounts,
  createApi,
  createBackupFile,
  httpTransport,
  openBackupFile,
  readBackupHeader,
  SCHEMA_VERSION,
  ShopEngine,
  syncOnce,
  wrapOo1,
  type ShopApi,
} from '@shopos/core';

declare const self: DedicatedWorkerGlobalScope;

const DB_FILE = '/shopos.sqlite3';
let sqlite3: any;
let pool: any = undefined;
let raw: any;
let engine: ShopEngine;
let api: ShopApi;
let mode: 'opfs' | 'memory' = 'memory';
let syncing: Promise<unknown> | null = null;

async function installPool() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'shopos-pool', initialCapacity: 6 });
    } catch (err: any) {
      // Another tab may still be releasing its file handles.
      if (attempt === 19 || !/NoModificationAllowed|locked|Access Handles/i.test(String(err?.message ?? err))) {
        console.warn('OPFS unavailable, falling back to memory', err);
        return null;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return null;
}

async function open() {
  sqlite3 ??= await (sqlite3InitModule as any)({ print: () => {}, printErr: (...a: unknown[]) => console.warn(...a) });
  if (pool === undefined) pool = await installPool();
  if (pool) {
    raw = new pool.OpfsSAHPoolDb(DB_FILE);
    mode = 'opfs';
  } else {
    raw = new sqlite3.oo1.DB(':memory:', 'c');
    mode = 'memory';
  }
  engine = ShopEngine.open(wrapOo1(raw, sqlite3));
  api = createApi(engine);
}

function close() {
  try {
    raw?.close();
  } catch {
    /* already closed */
  }
}

function deserializeInto(bytes: Uint8Array) {
  raw = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    raw.pointer, 'main', p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) throw new Error('Could not open the backup database');
}

const special = {
  async init() {
    return { mode, schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, deviceId: engine.deviceId };
  },

  async exportBackup(passphrase?: string) {
    const bytes: Uint8Array = engine.db.exportBytes();
    const business = engine.businessId ? engine.db.get<{ name: string }>(`SELECT name FROM businesses WHERE id = ?`, [engine.businessId]) : null;
    const file = await createBackupFile(
      bytes,
      { schema_v: SCHEMA_VERSION, app_v: APP_VERSION, device_id: engine.deviceId, business_name: business?.name ?? null, counts: backupCounts(engine) },
      passphrase || undefined,
    );
    engine.setMeta('last_backup_at', String(Date.now()));
    return file;
  },

  async inspectBackup(file: Uint8Array) {
    return readBackupHeader(file).header;
  },

  async restoreBackup(file: Uint8Array, passphrase?: string) {
    const { header, dbBytes } = await openBackupFile(file, passphrase || undefined);
    // Validate before replacing anything: open the image in memory and migrate it.
    const prevRaw = raw;
    deserializeInto(dbBytes);
    const probe = ShopEngine.open(wrapOo1(raw, sqlite3));
    const health = createApi(probe).healthCheck();
    raw.close();
    raw = prevRaw;
    close();
    if (pool) pool.importDb(DB_FILE, dbBytes);
    else deserializeInto(dbBytes);
    if (pool) await open();
    else {
      engine = ShopEngine.open(wrapOo1(raw, sqlite3));
      api = createApi(engine);
    }
    return { header, health };
  },

  async resetShop() {
    close();
    if (pool) pool.unlink(DB_FILE);
    await open();
    return true;
  },

  async sync() {
    if (syncing) return syncing;
    const url = engine.meta('hub_url');
    const token = engine.meta('hub_device_token');
    if (!url || !token) throw new Error('This device is not connected to a hub');
    syncing = syncOnce(engine, httpTransport(url, token))
      .catch((err) => {
        engine.setMeta('last_sync_error', String(err?.message ?? err));
        throw err;
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  },

  async applyEnrolment(info: { url: string; orgId: string; deviceToken: string; seriesCode: string; email: string; jwt?: string }) {
    engine.db.tx(() => {
      engine.setMeta('hub_url', info.url.replace(/\/$/, ''));
      engine.setMeta('hub_org_id', info.orgId);
      engine.setMeta('hub_device_token', info.deviceToken);
      engine.setMeta('hub_email', info.email);
      if (info.jwt) engine.setMeta('hub_jwt', info.jwt);
      engine.setMeta('series_code', info.seriesCode);
    });
    return true;
  },

  async disconnectHub() {
    for (const k of ['hub_device_token', 'hub_jwt', 'hub_org_id', 'last_sync_error']) engine.setMeta(k, null);
    return true;
  },

  async storageEstimate() {
    const est = await navigator.storage?.estimate?.();
    return { mode, usage: est?.usage ?? null, quota: est?.quota ?? null };
  },
};

type Msg = { id: number; method: string; args: unknown[] };

const ready = open();

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const { id, method, args } = ev.data;
  try {
    await ready;
    let result: unknown;
    if (method in special) result = await (special as any)[method](...args);
    else if (method in api) result = (api as any)[method](...args);
    else throw new Error(`Unknown method ${method}`);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer as Transferable[]);
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: { message: String(err?.message ?? err), code: err?.code ?? 'error' } });
  }
};
