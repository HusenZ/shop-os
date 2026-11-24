import { canonicalJson, sha256Hex } from './canonical';
import type { Row, SqlDb } from './db';
import { HlcClock } from './hlc';
import { uuidv7 } from './ids';
import { divRound, fyLabel, localDate } from './money';
import { FACT_TABLES, REFERENCE_TABLES, migrate, tableColumns, type FactTable, type ReferenceTable } from './schema';

export interface Op {
  op_id: string;
  v: number;
  device_id: string;
  user_id: string;
  hlc: string;
  kind: 'fact' | 'patch';
  type: string;
  entity: string;
  entity_id: string;
  business_id: string | null;
  branch_id: string | null;
  created_at: number;
  payload: FactPayload | PatchPayload;
  prev_hash: string | null;
  hash: string;
  seq?: number;
}

export interface FactPayload {
  tables: Partial<Record<FactTable, Row[]>>;
}

export interface PatchPayload {
  table: ReferenceTable;
  id: string;
  create: boolean;
  set: Row;
  before: Row;
}

/** sha256 over the canonical JSON of the op without `hash` and `seq`. */
export function hashOp(op: Omit<Op, 'hash'> & { hash?: string }): string {
  const { hash: _h, seq: _s, ...rest } = op as Op;
  return sha256Hex(canonicalJson(rest));
}

export class ShopError extends Error {
  constructor(
    message: string,
    readonly code: string = 'invalid',
  ) {
    super(message);
    this.name = 'ShopError';
  }
}

export interface EngineOptions {
  now?: () => number;
  deviceId?: string;
}

export class ShopEngine {
  readonly clock: HlcClock;
  readonly deviceId: string;
  readonly now: () => number;
  private accountsByKey: Map<string, string> | null = null;
  private keyByAccount: Map<string, string | null> | null = null;
  private metaCache = new Map<string, string | null>();

  static open(db: SqlDb, opts: EngineOptions = {}): ShopEngine {
    migrate(db);
    return new ShopEngine(db, opts);
  }

  private constructor(
    readonly db: SqlDb,
    opts: EngineOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    let deviceId = this.meta('device_id');
    if (!deviceId) {
      deviceId = opts.deviceId ?? uuidv7(this.now());
      this.setMeta('device_id', deviceId);
    }
    this.deviceId = deviceId;
    const last = db.get<{ hlc: string | null }>(`SELECT max(hlc) AS hlc FROM ops`)?.hlc ?? null;
    this.clock = new HlcClock(deviceId, last, this.now);
  }

  // ---------- meta ----------
  meta(key: string): string | null {
    if (this.metaCache.has(key)) return this.metaCache.get(key)!;
    const v = this.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null;
    this.metaCache.set(key, v);
    return v;
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.db.run(`DELETE FROM meta WHERE key = ?`, [key]);
    else this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
    this.metaCache.set(key, value);
  }

  get businessId(): string | null {
    return this.meta('business_id');
  }
  get branchId(): string | null {
    return this.meta('branch_id');
  }
  get userId(): string {
    return this.meta('user_name') ?? 'Owner';
  }
  get seriesCode(): string {
    return this.meta('series_code') ?? 'A';
  }

  today(): string {
    return localDate(this.now());
  }

  business(): Row {
    const id = this.businessId;
    const b = id ? this.db.get(`SELECT * FROM businesses WHERE id = ?`, [id]) : undefined;
    if (!b) throw new ShopError('The shop is not set up yet', 'not_setup');
    return b;
  }

  branch(id?: string | null): Row {
    const bid = id ?? this.branchId;
    const b = bid ? this.db.get(`SELECT * FROM branches WHERE id = ?`, [bid]) : undefined;
    if (!b) throw new ShopError('No branch selected on this device', 'no_branch');
    return b;
  }

  requireBranchId(): string {
    return this.branch().id;
  }

  // ---------- accounts ----------
  private loadAccounts() {
    const rows = this.db.all<{ id: string; system_key: string | null }>(`SELECT id, system_key FROM accounts`);
    this.accountsByKey = new Map();
    this.keyByAccount = new Map();
    for (const r of rows) {
      if (r.system_key) this.accountsByKey.set(r.system_key, r.id);
      this.keyByAccount.set(r.id, r.system_key);
    }
  }

  acct(systemKey: string): string {
    if (!this.accountsByKey) this.loadAccounts();
    const id = this.accountsByKey!.get(systemKey);
    if (!id) throw new ShopError(`Missing system account "${systemKey}"`, 'missing_account');
    return id;
  }

  accountKey(accountId: string): string | null {
    if (!this.keyByAccount) this.loadAccounts();
    if (!this.keyByAccount!.has(accountId)) this.loadAccounts();
    return this.keyByAccount!.get(accountId) ?? null;
  }

  invalidateAccounts() {
    this.accountsByKey = null;
    this.keyByAccount = null;
  }

  /** Throws when the date is inside a locked period. */
  assertOpen(date: string) {
    const lock = this.business().lock_date as string | null;
    if (lock && date <= lock) throw new ShopError(`The books are locked up to ${lock}. Use a later date.`, 'locked');
  }

  // ---------- write primitives (local) ----------

  /** Records immutable facts as one op: insert rows, update projections, append the op. */
  fact(type: string, entity: string, entityId: string, tables: Partial<Record<FactTable, Row[]>>, branchId?: string): Op {
    return this.db.tx(() => {
      const hlc = this.clock.tick();
      const opId = uuidv7(this.now());
      const now = this.now();
      for (const t of Object.keys(tables) as FactTable[]) {
        for (const row of tables[t]!) {
          row.id ??= uuidv7(now);
          row.op_id = opId;
          row.hlc = hlc;
          row.business_id ??= this.businessId;
          row.branch_id ??= branchId ?? this.branchId;
          row.created_at ??= now;
          row.created_by ??= this.userId;
          row.device_id ??= this.deviceId;
          for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null;
        }
      }
      const inserted = this.insertFacts(tables);
      this.project(inserted);
      return this.appendOp({ op_id: opId, kind: 'fact', type, entity, entity_id: entityId, payload: { tables }, hlc, branch_id: branchId });
    });
  }

  /** Creates or updates a reference row as a field-level patch op. */
  patch(table: ReferenceTable, id: string, set: Row, opts: { create?: boolean; type?: string } = {}): Op {
    return this.db.tx(() => {
      const hlc = this.clock.tick();
      const cols = tableColumns(this.db, table);
      const clean: Row = {};
      for (const [k, v] of Object.entries(set)) {
        if (v === undefined || !cols.has(k) || k === 'id' || k === 'field_hlc' || k === 'updated_hlc') continue;
        clean[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      }
      const existing = this.db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      if (!existing && !opts.create) throw new ShopError(`${table} ${id} not found`, 'not_found');
      const before: Row = {};
      if (existing) for (const k of Object.keys(clean)) before[k] = existing[k] ?? null;
      this.mergePatch(table, id, clean, hlc, !existing);
      return this.appendOp({
        op_id: uuidv7(this.now()),
        kind: 'patch',
        type: opts.type ?? `${table}.${existing ? 'patched' : 'created'}`,
        entity: table,
        entity_id: id,
        payload: { table, id, create: !existing, set: clean, before },
        hlc,
      });
    });
  }

  private appendOp(o: {
    op_id: string;
    kind: 'fact' | 'patch';
    type: string;
    entity: string;
    entity_id: string;
    payload: FactPayload | PatchPayload;
    hlc: string;
    branch_id?: string;
  }): Op {
    const op: Omit<Op, 'hash'> = {
      op_id: o.op_id,
      v: 1,
      device_id: this.deviceId,
      user_id: this.userId,
      hlc: o.hlc,
      kind: o.kind,
      type: o.type,
      entity: o.entity,
      entity_id: o.entity_id,
      business_id: this.businessId,
      branch_id: o.branch_id ?? this.branchId,
      created_at: this.now(),
      payload: o.payload,
      prev_hash: this.meta('chain_head'),
    };
    const full: Op = { ...op, hash: hashOp(op) };
    this.storeOp(full, 'local');
    this.setMeta('chain_head', full.hash);
    return full;
  }

  storeOp(op: Op, origin: 'local' | 'remote', seq: number | null = null) {
    this.db.run(
      `INSERT INTO ops (op_id, device_id, user_id, hlc, kind, type, entity, entity_id, business_id, branch_id,
        created_at, payload, prev_hash, hash, seq, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        op.op_id, op.device_id, op.user_id, op.hlc, op.kind, op.type, op.entity, op.entity_id, op.business_id,
        op.branch_id, op.created_at, JSON.stringify(op.payload), op.prev_hash, op.hash, seq, origin,
      ],
    );
  }

  // ---------- apply primitives (shared by local writes and remote sync) ----------

  insertFacts(tables: Partial<Record<string, Row[]>>): Partial<Record<FactTable, Row[]>> {
    const inserted: Partial<Record<FactTable, Row[]>> = {};
    for (const t of Object.keys(tables)) {
      if (!(FACT_TABLES as readonly string[]).includes(t)) throw new ShopError(`Unknown fact table ${t}`, 'bad_op');
      const cols = tableColumns(this.db, t);
      for (const row of tables[t] ?? []) {
        const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined);
        const res = this.db.run(
          `INSERT OR IGNORE INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          keys.map((k) => row[k]),
        );
        if (res.changes) (inserted[t as FactTable] ??= []).push(row);
      }
    }
    return inserted;
  }

  /** Updates derived tables for newly inserted facts. Additive, so order-independent. */
  project(inserted: Partial<Record<FactTable, Row[]>>) {
    for (const m of inserted.stock_movements ?? []) {
      this.db.run(
        `INSERT INTO stock_levels (branch_id, product_id, qty_milli, value_paise) VALUES (?, ?, ?, ?)
         ON CONFLICT(branch_id, product_id) DO UPDATE SET
           qty_milli = qty_milli + excluded.qty_milli, value_paise = value_paise + excluded.value_paise`,
        [m.branch_id, m.product_id, m.qty_delta_milli, m.value_paise],
      );
      if (m.qty_delta_milli > 0 && m.unit_cost_paise > 0 && m.reason !== 'void' && m.reason !== 'sale_return') {
        this.db.run(
          `UPDATE stock_levels SET last_cost_paise = ?, last_cost_hlc = ?
           WHERE branch_id = ? AND product_id = ? AND (last_cost_hlc IS NULL OR last_cost_hlc < ?)`,
          [m.unit_cost_paise, m.hlc, m.branch_id, m.product_id, m.hlc],
        );
      }
    }
    for (const l of inserted.journal_lines ?? []) {
      this.db.run(
        `INSERT INTO account_daily (account_id, branch_id, business_date, debit_paise, credit_paise) VALUES (?,?,?,?,?)
         ON CONFLICT(account_id, branch_id, business_date) DO UPDATE SET
           debit_paise = debit_paise + excluded.debit_paise, credit_paise = credit_paise + excluded.credit_paise`,
        [l.account_id, l.branch_id ?? '', l.business_date, l.debit_paise, l.credit_paise],
      );
      if (l.party_id) {
        const key = this.accountKey(l.account_id);
        if (key === 'ar' || key === 'ap') {
          const recv = key === 'ar' ? l.debit_paise - l.credit_paise : 0;
          const pay = key === 'ap' ? l.credit_paise - l.debit_paise : 0;
          this.db.run(
            `INSERT INTO party_balances (party_id, receivable_paise, payable_paise) VALUES (?,?,?)
             ON CONFLICT(party_id) DO UPDATE SET receivable_paise = receivable_paise + excluded.receivable_paise,
               payable_paise = payable_paise + excluded.payable_paise`,
            [l.party_id, recv, pay],
          );
        }
      }
    }
  }

  /** Per-field last-writer-wins merge. Returns the fields that were applied. */
  mergePatch(table: string, id: string, set: Row, hlc: string, create: boolean): Row {
    if (!(REFERENCE_TABLES as readonly string[]).includes(table)) throw new ShopError(`Unknown reference table ${table}`, 'bad_op');
    const cols = tableColumns(this.db, table);
    const keys = Object.keys(set).filter((k) => cols.has(k) && !['id', 'field_hlc', 'updated_hlc'].includes(k));
    const existing = this.db.get<{ field_hlc: string; updated_hlc: string | null }>(
      `SELECT field_hlc, updated_hlc FROM ${table} WHERE id = ?`,
      [id],
    );
    let applied: Row = {};
    if (!existing) {
      void create; // a patch can arrive for a row we have not seen; create it from the fields we have
      const fh: Record<string, string> = {};
      for (const k of keys) fh[k] = hlc;
      const allKeys = ['id', ...keys, 'field_hlc', 'updated_hlc'];
      this.db.run(
        `INSERT INTO ${table} (${allKeys.join(',')}) VALUES (${allKeys.map(() => '?').join(',')})`,
        [id, ...keys.map((k) => set[k]), canonicalJson(fh), hlc],
      );
      applied = Object.fromEntries(keys.map((k) => [k, set[k]]));
    } else {
      const fh: Record<string, string> = JSON.parse(existing.field_hlc || '{}');
      for (const k of keys) {
        if (!fh[k] || hlc > fh[k]) {
          applied[k] = set[k];
          fh[k] = hlc;
        }
      }
      const ak = Object.keys(applied);
      if (ak.length) {
        const updated = !existing.updated_hlc || hlc > existing.updated_hlc ? hlc : existing.updated_hlc;
        this.db.run(
          `UPDATE ${table} SET ${ak.map((k) => `${k} = ?`).join(', ')}, field_hlc = ?, updated_hlc = ? WHERE id = ?`,
          [...ak.map((k) => applied[k]), canonicalJson(fh), updated, id],
        );
      }
    }
    if (table === 'accounts') this.invalidateAccounts();
    return applied;
  }

  raiseException(kind: string, refType: string, refId: string, message: string, details: Row = {}) {
    this.db.run(
      `INSERT INTO exceptions (id, kind, ref_type, ref_id, message, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv7(this.now()), kind, refType, refId, message, JSON.stringify(details), 'open', this.now()],
    );
  }

  // ---------- helpers used by services ----------

  nextDocNo(kind: 'INV' | 'CN', date: string): { series: string; fy: string; seq: number; docNo: string } {
    const fy = fyLabel(date, Number(this.business().fy_start_month ?? 4));
    const row = this.db.get<{ next_seq: number }>(
      `SELECT next_seq FROM doc_series WHERE device_id = ? AND kind = ? AND fy = ?`,
      [this.deviceId, kind, fy],
    );
    const seq = row?.next_seq ?? 1;
    this.db.run(
      `INSERT INTO doc_series (device_id, kind, fy, next_seq) VALUES (?,?,?,?)
       ON CONFLICT(device_id, kind, fy) DO UPDATE SET next_seq = excluded.next_seq`,
      [this.deviceId, kind, fy, seq + 1],
    );
    const prefix = kind === 'INV' ? String(this.branch().invoice_prefix || 'INV').slice(0, 4) : 'CN';
    const series = this.seriesCode;
    return { series, fy, seq, docNo: `${prefix}-${series}${fy}-${String(seq).padStart(5, '0')}` };
  }

  stockLevel(productId: string, branchId?: string): { qty_milli: number; value_paise: number; last_cost_paise: number | null } {
    return (
      this.db.get(`SELECT qty_milli, value_paise, last_cost_paise FROM stock_levels WHERE branch_id = ? AND product_id = ?`, [
        branchId ?? this.requireBranchId(),
        productId,
      ]) ?? { qty_milli: 0, value_paise: 0, last_cost_paise: null }
    );
  }

  /** Cost of issuing qty from stock at the current weighted average. */
  issueCost(productId: string, qtyMilli: number, branchId?: string): number {
    const sl = this.stockLevel(productId, branchId);
    if (sl.qty_milli > 0) {
      if (qtyMilli === sl.qty_milli) return sl.value_paise;
      if (qtyMilli < sl.qty_milli) return divRound(qtyMilli * sl.value_paise, sl.qty_milli);
      const avgUnit = divRound(sl.value_paise * 1000, sl.qty_milli);
      return sl.value_paise + divRound((qtyMilli - sl.qty_milli) * avgUnit, 1000);
    }
    const product = this.db.get<{ cost_paise: number | null }>(`SELECT cost_paise FROM products WHERE id = ?`, [productId]);
    const unit = sl.last_cost_paise || product?.cost_paise || 0;
    return divRound(qtyMilli * unit, 1000);
  }

  /** Current average cost per unit (paise). */
  avgCost(productId: string, branchId?: string): number {
    const sl = this.stockLevel(productId, branchId);
    if (sl.qty_milli > 0) return divRound(sl.value_paise * 1000, sl.qty_milli);
    const product = this.db.get<{ cost_paise: number | null }>(`SELECT cost_paise FROM products WHERE id = ?`, [productId]);
    return sl.last_cost_paise || product?.cost_paise || 0;
  }
}
