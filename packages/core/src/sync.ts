import type { Row } from './db';
import { hashOp, type FactPayload, type Op, type PatchPayload, type ShopEngine } from './engine';
import { canonicalJson } from './canonical';
import { formatQty } from './money';

export interface PushResult {
  acked: { op_id: string; seq: number }[];
  rejected: { op_id: string; reason: string }[];
}

export interface PullResult {
  ops: Op[];
  next_cursor: number;
  more: boolean;
}

export interface HubTransport {
  push(ops: Op[]): Promise<PushResult>;
  pull(cursor: number, limit: number): Promise<PullResult>;
}

function rowToOp(r: Row): Op {
  return {
    op_id: r.op_id, v: 1, device_id: r.device_id, user_id: r.user_id, hlc: r.hlc, kind: r.kind, type: r.type, entity: r.entity,
    entity_id: r.entity_id, business_id: r.business_id, branch_id: r.branch_id, created_at: r.created_at,
    payload: JSON.parse(r.payload), prev_hash: r.prev_hash, hash: r.hash,
  };
}

/** Local ops not yet acknowledged by the hub, in chain order. */
export function pendingOps(e: ShopEngine, limit = 500): Op[] {
  return e.db.all(`SELECT * FROM ops WHERE origin = 'local' AND seq IS NULL ORDER BY hlc LIMIT ?`, [limit]).map(rowToOp);
}

export function markPushed(e: ShopEngine, res: PushResult) {
  e.db.tx(() => {
    for (const a of res.acked) e.db.run(`UPDATE ops SET seq = ? WHERE op_id = ?`, [a.seq, a.op_id]);
    for (const r of res.rejected) {
      if (!e.db.get(`SELECT 1 FROM exceptions WHERE ref_id = ? AND kind = 'rejected_op' AND status = 'open'`, [r.op_id])) {
        e.raiseException('rejected_op', 'op', r.op_id, `The hub rejected a change (${r.reason})`, { reason: r.reason });
      }
    }
  });
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  invalid: number;
}

/** Applies ops pulled from the hub. Idempotent; each op is one transaction. */
export function applyRemoteOps(e: ShopEngine, ops: Op[]): ApplyResult {
  const result: ApplyResult = { applied: 0, skipped: 0, invalid: 0 };
  const sorted = [...ops].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const op of sorted) {
    const existing = e.db.get<{ seq: number | null }>(`SELECT seq FROM ops WHERE op_id = ?`, [op.op_id]);
    if (existing) {
      if (existing.seq == null && op.seq != null) e.db.run(`UPDATE ops SET seq = ? WHERE op_id = ?`, [op.seq, op.op_id]);
      result.skipped++;
      continue;
    }
    if (hashOp(op) !== op.hash) {
      e.raiseException('bad_op', 'op', op.op_id, 'A change from another device failed its integrity check and was ignored', { type: op.type });
      result.invalid++;
      continue;
    }
    e.db.tx(() => {
      e.clock.receive(op.hlc);
      if (e.clock.skewMs(op.hlc) > 24 * 3600_000) {
        e.raiseException('clock_skew', 'device', op.device_id, 'A device clock is more than a day ahead', { hlc: op.hlc });
      }
      if (op.kind === 'fact') {
        const inserted = e.insertFacts((op.payload as FactPayload).tables);
        e.project(inserted);
        postFactChecks(e, inserted);
      } else {
        const p = op.payload as PatchPayload;
        e.mergePatch(p.table, p.id, p.set, op.hlc, p.create);
        if (p.table === 'parties' && p.create) duplicatePartyCheck(e, p.id);
      }
      e.storeOp(op, 'remote', op.seq ?? null);
    });
    if (!e.businessId && op.entity === 'businesses') e.setMeta('business_id', op.entity_id);
    result.applied++;
  }
  return result;
}

function postFactChecks(e: ShopEngine, inserted: Partial<Record<string, Row[]>>) {
  const seen = new Set<string>();
  for (const m of inserted.stock_movements ?? []) {
    const key = `${m.branch_id}|${m.product_id}`;
    if (seen.has(key) || m.qty_delta_milli >= 0) continue;
    seen.add(key);
    const level = e.db.get<{ qty_milli: number }>(`SELECT qty_milli FROM stock_levels WHERE branch_id = ? AND product_id = ?`, [m.branch_id, m.product_id]);
    if (level && level.qty_milli < 0) {
      const open = e.db.get(`SELECT 1 FROM exceptions WHERE kind = 'negative_stock' AND ref_id = ? AND status = 'open'`, [m.product_id]);
      if (!open) {
        const p = e.db.get<{ name: string; unit: string }>(`SELECT name, unit FROM products WHERE id = ?`, [m.product_id]);
        e.raiseException('negative_stock', 'product', m.product_id, `${p?.name ?? 'An item'} went to ${formatQty(level.qty_milli)} ${p?.unit ?? ''} after syncing. Count it or adjust stock.`, { branch_id: m.branch_id });
      }
    }
  }
  const lock = e.businessId ? (e.db.get<{ lock_date: string | null }>(`SELECT lock_date FROM businesses WHERE id = ?`, [e.businessId])?.lock_date ?? null) : null;
  if (lock) {
    for (const j of inserted.journal_entries ?? []) {
      if (j.business_date <= lock) {
        e.raiseException('late_entry', 'journal_entry', j.id, `An entry dated ${j.business_date} arrived after the books were locked up to ${lock}`, { narration: j.narration });
      }
    }
  }
  for (const d of inserted.sales_docs ?? []) {
    if (!d.party_id || !d.due_paise) continue;
    const party = e.db.get(`SELECT p.name, p.credit_limit_paise, coalesce(b.receivable_paise, 0) AS r FROM parties p LEFT JOIN party_balances b ON b.party_id = p.id WHERE p.id = ?`, [d.party_id]);
    if (party && party.credit_limit_paise > 0 && party.r > party.credit_limit_paise) {
      e.raiseException('credit_limit', 'party', d.party_id, `${party.name} is over their credit limit after syncing`, { doc_no: d.doc_no });
    }
  }
}

function duplicatePartyCheck(e: ShopEngine, partyId: string) {
  const p = e.db.get(`SELECT * FROM parties WHERE id = ?`, [partyId]);
  if (!p?.phone) return;
  const dup = e.db.get(`SELECT id, name FROM parties WHERE phone = ? AND id <> ? AND deleted = 0 AND kind = ? AND merged_into_id IS NULL`, [p.phone, p.id, p.kind]);
  if (dup) e.raiseException('duplicate_party', 'party', p.id, `${p.name} and ${dup.name} share the phone number ${p.phone}`, { other_id: dup.id });
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  rejected: number;
  invalid: number;
  cursor: number;
}

/** One full sync round: push everything pending, then pull until caught up. */
export async function syncOnce(e: ShopEngine, t: HubTransport, opts: { batch?: number } = {}): Promise<SyncReport> {
  const batch = opts.batch ?? 500;
  const report: SyncReport = { pushed: 0, pulled: 0, rejected: 0, invalid: 0, cursor: Number(e.meta('pull_cursor') ?? 0) };
  for (;;) {
    const ops = pendingOps(e, batch);
    if (!ops.length) break;
    const res = await t.push(ops);
    markPushed(e, res);
    report.pushed += res.acked.length;
    report.rejected += res.rejected.length;
    if (res.rejected.length || res.acked.length === 0) break;
  }
  let cursor = report.cursor;
  for (;;) {
    const res = await t.pull(cursor, batch);
    const applied = applyRemoteOps(e, res.ops);
    report.pulled += applied.applied;
    report.invalid += applied.invalid;
    cursor = res.next_cursor;
    e.setMeta('pull_cursor', String(cursor));
    if (!res.more) break;
  }
  report.cursor = cursor;
  e.setMeta('last_sync_at', String(e.now()));
  e.setMeta('last_sync_error', null);
  return report;
}

/** HTTP transport for the FastAPI hub. */
export function httpTransport(baseUrl: string, deviceToken: string, fetchImpl: typeof fetch = fetch): HubTransport {
  const url = baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` };
  async function check(res: Response) {
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* not json */
      }
      throw new Error(`Hub error ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return res.json();
  }
  return {
    push: async (ops) => check(await fetchImpl(`${url}/v1/sync/push`, { method: 'POST', headers, body: JSON.stringify({ ops }) })),
    pull: async (cursor, limit) => check(await fetchImpl(`${url}/v1/sync/pull?cursor=${cursor}&limit=${limit}`, { headers })),
  };
}

/** In-memory hub with the same semantics as the FastAPI hub (used by tests and the simulator). */
export class MemoryHub {
  private ops: (Op & { seq: number })[] = [];
  private heads = new Map<string, string | null>();

  transport(deviceId: string): HubTransport {
    return {
      push: async (ops) => this.push(deviceId, ops),
      pull: async (cursor, limit) => this.pull(deviceId, cursor, limit),
    };
  }

  push(deviceId: string, ops: Op[]): PushResult {
    const res: PushResult = { acked: [], rejected: [] };
    let broken = false;
    for (const op of ops) {
      const existing = this.ops.find((o) => o.op_id === op.op_id);
      if (existing) {
        res.acked.push({ op_id: op.op_id, seq: existing.seq });
        continue;
      }
      if (broken) {
        res.rejected.push({ op_id: op.op_id, reason: 'chain_broken' });
        continue;
      }
      let reason: string | null = null;
      if (op.device_id !== deviceId) reason = 'device_mismatch';
      else if (hashOp(op) !== op.hash) reason = 'bad_hash';
      else if ((this.heads.get(deviceId) ?? null) !== op.prev_hash) reason = 'chain_broken';
      else if (op.kind === 'fact') {
        const lines = (op.payload as FactPayload).tables.journal_lines ?? [];
        const dr = lines.reduce((s, l) => s + l.debit_paise, 0);
        const cr = lines.reduce((s, l) => s + l.credit_paise, 0);
        if (dr !== cr) reason = 'unbalanced_journal';
      }
      if (reason) {
        res.rejected.push({ op_id: op.op_id, reason });
        broken = true;
        continue;
      }
      // like the real hub: store the canonical form (keys sorted), so clients must not depend on key order
      const stored = { ...(JSON.parse(canonicalJson(op)) as Op), seq: this.ops.length + 1 };
      this.ops.push(stored);
      this.heads.set(deviceId, op.hash);
      res.acked.push({ op_id: op.op_id, seq: stored.seq });
    }
    return res;
  }

  pull(deviceId: string, cursor: number, limit: number): PullResult {
    const window = this.ops.filter((o) => o.seq > cursor).slice(0, limit);
    const next = window.length ? window[window.length - 1].seq : cursor;
    return {
      ops: window.filter((o) => o.device_id !== deviceId).map((o) => structuredClone(o)),
      next_cursor: next,
      more: this.ops.some((o) => o.seq > next),
    };
  }

  get size() {
    return this.ops.length;
  }
}
