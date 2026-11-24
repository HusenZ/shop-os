/**
 * A small synchronous SQL interface. Every ShopOS service runs synchronously
 * inside one SQLite transaction, so the same code runs in the browser worker
 * (sqlite-wasm on OPFS) and in Node tests (sqlite-wasm in memory).
 */
export type Row = Record<string, any>;

export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  all<T = Row>(sql: string, params?: unknown[]): T[];
  get<T = Row>(sql: string, params?: unknown[]): T | undefined;
  /** Runs fn in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;
  /** Serialises the whole database file (used for backups). */
  exportBytes(): Uint8Array;
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Wraps a sqlite-wasm `oo1.DB` (or `OpfsSAHPoolDb`). */
export function wrapOo1(db: any, sqlite3: any): SqlDb {
  let depth = 0;
  const plain = (rows: any[]) => rows.map((r) => ({ ...r }));
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = NORMAL;');
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.exec({ sql, bind: params.map(norm) });
      return { changes: db.changes() };
    },
    all: (sql, params = []) => plain(db.selectObjects(sql, params.map(norm))) as any,
    get: (sql, params = []) => {
      const rows = db.selectObjects(sql, params.map(norm));
      return rows.length ? ({ ...rows[0] } as any) : undefined;
    },
    tx: (fn) => {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    exportBytes: () => sqlite3.capi.sqlite3_js_db_export(db.pointer ?? db),
  };
}
