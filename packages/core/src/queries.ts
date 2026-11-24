import type { Row } from './db';
import { ShopError, type ShopEngine } from './engine';
import { divRound } from './money';
import { SCHEMA_VERSION } from './schema';

export function session(e: ShopEngine) {
  const businessId = e.businessId;
  const business = businessId ? e.db.get(`SELECT * FROM businesses WHERE id = ?`, [businessId]) ?? null : null;
  const branch = e.branchId ? e.db.get(`SELECT * FROM branches WHERE id = ?`, [e.branchId]) ?? null : null;
  const branches = e.db.all(`SELECT * FROM branches WHERE deleted = 0 ORDER BY name`);
  return {
    setup: Boolean(business),
    deviceId: e.deviceId,
    seriesCode: e.seriesCode,
    userName: e.userId,
    business,
    branch,
    branches,
    schemaVersion: SCHEMA_VERSION,
    pendingOps: e.db.get<{ n: number }>(`SELECT count(*) AS n FROM ops WHERE origin = 'local' AND seq IS NULL`)?.n ?? 0,
    totalOps: e.db.get<{ n: number }>(`SELECT count(*) AS n FROM ops`)?.n ?? 0,
    lastBackupAt: e.meta('last_backup_at') ? Number(e.meta('last_backup_at')) : null,
    hub: {
      url: e.meta('hub_url'),
      orgId: e.meta('hub_org_id'),
      enrolled: Boolean(e.meta('hub_device_token')),
      email: e.meta('hub_email'),
      lastSyncAt: e.meta('last_sync_at') ? Number(e.meta('last_sync_at')) : null,
      lastSyncError: e.meta('last_sync_error'),
      cursor: Number(e.meta('pull_cursor') ?? 0),
    },
    pinSet: Boolean(e.meta('app_pin')),
  };
}

export function listCategories(e: ShopEngine) {
  return e.db.all(
    `SELECT c.*, (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.deleted = 0) AS product_count
     FROM categories c WHERE c.deleted = 0 ORDER BY c.sort, c.name`,
  );
}

export function listProducts(e: ShopEngine, r: { q?: string; categoryId?: string | null; includeInactive?: boolean; favouritesOnly?: boolean; limit?: number } = {}) {
  const params: unknown[] = [e.branchId ?? ''];
  let where = `p.deleted = 0`;
  if (!r.includeInactive) where += ` AND p.is_active = 1`;
  if (r.categoryId) {
    where += ` AND p.category_id = ?`;
    params.push(r.categoryId);
  }
  if (r.favouritesOnly) where += ` AND p.favourite = 1`;
  if (r.q?.trim()) {
    const q = r.q.trim();
    where += ` AND (p.name LIKE ? OR p.barcode = ? OR p.sku LIKE ? OR p.hsn = ?)`;
    params.push(`%${q}%`, q, `${q}%`, q);
  }
  params.push(r.limit ?? 500);
  return e.db
    .all(
      `SELECT p.*, c.name AS category_name, c.color AS category_color,
              coalesce(s.qty_milli, 0) AS stock_milli, coalesce(s.value_paise, 0) AS stock_value_paise, s.last_cost_paise
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels s ON s.product_id = p.id AND s.branch_id = ?
       WHERE ${where} ORDER BY p.favourite DESC, p.name LIMIT ?`,
      params,
    )
    .map((p): Row => ({ ...p, avg_cost_paise: p.stock_milli > 0 ? divRound(p.stock_value_paise * 1000, p.stock_milli) : p.last_cost_paise || p.cost_paise || 0 }));
}

export function findProductByCode(e: ShopEngine, code: string) {
  const c = code.trim();
  if (!c) return null;
  return (
    e.db.get(`SELECT * FROM products WHERE deleted = 0 AND is_active = 1 AND (barcode = ? OR sku = ?) LIMIT 1`, [c, c]) ?? null
  );
}

export function getProduct(e: ShopEngine, id: string) {
  const p = e.db.get(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, [id]);
  if (!p) throw new ShopError('Item not found', 'not_found');
  const levels = e.db.all(
    `SELECT s.*, b.name AS branch_name FROM stock_levels s JOIN branches b ON b.id = s.branch_id WHERE s.product_id = ? ORDER BY b.name`,
    [id],
  );
  const movements = e.db.all(
    `SELECT m.*, b.name AS branch_name FROM stock_movements m LEFT JOIN branches b ON b.id = m.branch_id
     WHERE m.product_id = ? ORDER BY m.hlc DESC LIMIT 100`,
    [id],
  );
  const sold = e.db.get(
    `SELECT coalesce(sum(CASE WHEN d.doc_type = 'credit_note' THEN -l.qty_milli ELSE l.qty_milli END), 0) AS qty_milli,
            coalesce(sum(CASE WHEN d.doc_type = 'credit_note' THEN -l.taxable_paise ELSE l.taxable_paise END), 0) AS net_paise,
            coalesce(sum(CASE WHEN d.doc_type = 'credit_note' THEN -l.cost_paise ELSE l.cost_paise END), 0) AS cost_paise
     FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     WHERE l.product_id = ? AND NOT EXISTS (SELECT 1 FROM doc_events v WHERE v.doc_id = d.id AND v.event = 'void')`,
    [id],
  );
  const here = levels.find((l) => l.branch_id === e.branchId);
  return {
    product: p,
    levels,
    movements,
    sold,
    stockMilli: here?.qty_milli ?? 0,
    avgCostPaise: e.branchId ? e.avgCost(id) : p.cost_paise,
  };
}

export function listMovements(e: ShopEngine, r: { limit?: number; reason?: string } = {}) {
  return e.db.all(
    `SELECT m.*, p.name AS product_name, p.unit FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE (? IS NULL OR m.reason = ?) AND (m.branch_id = ? OR ? IS NULL)
     ORDER BY m.hlc DESC LIMIT ?`,
    [r.reason ?? null, r.reason ?? null, e.branchId, e.branchId, r.limit ?? 200],
  );
}

export function listParties(e: ShopEngine, r: { kind?: 'customer' | 'supplier'; q?: string; withBalance?: boolean; limit?: number } = {}) {
  const params: unknown[] = [];
  let where = `p.deleted = 0 AND p.merged_into_id IS NULL`;
  if (r.kind) {
    where += ` AND (p.kind = ? OR p.kind = 'both')`;
    params.push(r.kind);
  }
  if (r.q?.trim()) {
    where += ` AND (p.name LIKE ? OR p.phone LIKE ? OR p.gstin = ?)`;
    params.push(`%${r.q.trim()}%`, `%${r.q.trim()}%`, r.q.trim().toUpperCase());
  }
  if (r.withBalance) where += ` AND (coalesce(b.receivable_paise, 0) <> 0 OR coalesce(b.payable_paise, 0) <> 0)`;
  params.push(r.limit ?? 500);
  return e.db.all(
    `SELECT p.*, coalesce(b.receivable_paise, 0) AS receivable_paise, coalesce(b.payable_paise, 0) AS payable_paise,
            (SELECT max(d.business_date) FROM sales_docs d WHERE d.party_id = p.id) AS last_sale_date,
            (SELECT min(l.business_date) FROM journal_lines l WHERE l.party_id = p.id AND l.debit_paise > 0) AS oldest_debit_date
     FROM parties p LEFT JOIN party_balances b ON b.party_id = p.id
     WHERE ${where} ORDER BY ${r.withBalance ? 'coalesce(b.receivable_paise, 0) + coalesce(b.payable_paise, 0) DESC' : 'p.name'} LIMIT ?`,
    params,
  );
}

export function getParty(e: ShopEngine, id: string) {
  const party = e.db.get(
    `SELECT p.*, coalesce(b.receivable_paise, 0) AS receivable_paise, coalesce(b.payable_paise, 0) AS payable_paise
     FROM parties p LEFT JOIN party_balances b ON b.party_id = p.id WHERE p.id = ?`,
    [id],
  );
  if (!party) throw new ShopError('Not found', 'not_found');
  const stats = e.db.get(
    `SELECT count(*) AS bills, coalesce(sum(total_paise), 0) AS total_paise, max(business_date) AS last_visit, min(business_date) AS first_visit
     FROM sales_docs d WHERE d.party_id = ? AND d.doc_type <> 'credit_note' AND NOT EXISTS (SELECT 1 FROM doc_events v WHERE v.doc_id = d.id AND v.event = 'void')`,
    [id],
  );
  const sales = e.db.all(
    `SELECT d.*, EXISTS (SELECT 1 FROM doc_events v WHERE v.doc_id = d.id AND v.event = 'void') AS voided
     FROM sales_docs d WHERE d.party_id = ? ORDER BY d.business_date DESC, d.hlc DESC LIMIT 50`,
    [id],
  );
  const purchases = e.db.all(`SELECT * FROM purchase_docs WHERE party_id = ? ORDER BY business_date DESC, hlc DESC LIMIT 50`, [id]);
  const favourites = e.db.all(
    `SELECT l.name, sum(l.qty_milli) AS qty_milli, l.unit FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     WHERE d.party_id = ? AND d.doc_type <> 'credit_note' GROUP BY l.product_id ORDER BY count(*) DESC LIMIT 5`,
    [id],
  );
  return {
    party,
    stats: { ...(stats ?? {}), avg_bill_paise: stats?.bills ? divRound(stats.total_paise, stats.bills) : 0 } as Row,
    sales,
    purchases,
    favourites,
  };
}

export function listSales(e: ShopEngine, r: { from?: string; to?: string; q?: string; partyId?: string; limit?: number; allBranches?: boolean } = {}) {
  const params: unknown[] = [r.from ?? '0000-01-01', r.to ?? '9999-12-31'];
  let where = `d.business_date BETWEEN ? AND ?`;
  if (!r.allBranches && e.branchId) {
    where += ` AND d.branch_id = ?`;
    params.push(e.branchId);
  }
  if (r.partyId) {
    where += ` AND d.party_id = ?`;
    params.push(r.partyId);
  }
  if (r.q?.trim()) {
    where += ` AND (d.doc_no LIKE ? OR d.party_name LIKE ? OR d.party_phone LIKE ?)`;
    const q = `%${r.q.trim()}%`;
    params.push(q, q, q);
  }
  params.push(r.limit ?? 300);
  return e.db.all(
    `SELECT d.*, EXISTS (SELECT 1 FROM doc_events v WHERE v.doc_id = d.id AND v.event = 'void') AS voided,
            (SELECT count(*) FROM sales_lines l WHERE l.doc_id = d.id) AS line_count,
            (SELECT group_concat(method, ', ') FROM (SELECT DISTINCT method FROM payments p WHERE p.ref_id = d.id AND p.direction = 'in')) AS methods
     FROM sales_docs d WHERE ${where} ORDER BY d.business_date DESC, d.hlc DESC LIMIT ?`,
    params,
  );
}

export function getSale(e: ShopEngine, id: string) {
  const doc = e.db.get(`SELECT * FROM sales_docs WHERE id = ?`, [id]);
  if (!doc) throw new ShopError('Bill not found', 'not_found');
  const lines = e.db.all(`SELECT * FROM sales_lines WHERE doc_id = ? ORDER BY line_no`, [id]);
  for (const l of lines) {
    l.returned_milli = e.db.get<{ q: number }>(`SELECT coalesce(sum(qty_milli), 0) AS q FROM sales_lines WHERE original_line_id = ?`, [l.id])!.q;
  }
  const payments = e.db.all(`SELECT * FROM payments WHERE ref_id = ? ORDER BY hlc`, [id]);
  const events = e.db.all(`SELECT * FROM doc_events WHERE doc_id = ? ORDER BY hlc`, [id]);
  const creditNotes = e.db.all(`SELECT * FROM sales_docs WHERE original_doc_id = ? ORDER BY hlc`, [id]);
  const original = doc.original_doc_id ? e.db.get(`SELECT id, doc_no, business_date FROM sales_docs WHERE id = ?`, [doc.original_doc_id]) : null;
  const branch = e.db.get(`SELECT * FROM branches WHERE id = ?`, [doc.branch_id]);
  const business = e.db.get(`SELECT * FROM businesses WHERE id = ?`, [doc.business_id]);
  const party = doc.party_id
    ? e.db.get(
        `SELECT p.*, coalesce(b.receivable_paise, 0) AS receivable_paise FROM parties p LEFT JOIN party_balances b ON b.party_id = p.id WHERE p.id = ?`,
        [doc.party_id],
      )
    : null;
  const journal = e.db.all(
    `SELECT l.*, a.name AS account_name, a.code AS account_code FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id WHERE j.source_id = ? ORDER BY l.debit_paise DESC`,
    [id],
  );
  return { doc, lines, payments, events, voided: events.some((x) => x.event === 'void'), creditNotes, original, branch, business, party, journal };
}

export function listPurchases(e: ShopEngine, r: { from?: string; to?: string; partyId?: string; limit?: number } = {}) {
  return e.db.all(
    `SELECT d.*, (SELECT count(*) FROM purchase_lines l WHERE l.doc_id = d.id) AS line_count FROM purchase_docs d
     WHERE d.business_date BETWEEN ? AND ? AND (? IS NULL OR d.party_id = ?) ORDER BY d.business_date DESC, d.hlc DESC LIMIT ?`,
    [r.from ?? '0000-01-01', r.to ?? '9999-12-31', r.partyId ?? null, r.partyId ?? null, r.limit ?? 300],
  );
}

export function getPurchase(e: ShopEngine, id: string) {
  const doc = e.db.get(`SELECT * FROM purchase_docs WHERE id = ?`, [id]);
  if (!doc) throw new ShopError('Purchase not found', 'not_found');
  return {
    doc,
    lines: e.db.all(`SELECT * FROM purchase_lines WHERE doc_id = ? ORDER BY line_no`, [id]),
    payments: e.db.all(`SELECT * FROM payments WHERE ref_id = ?`, [id]),
    journal: e.db.all(
      `SELECT l.*, a.name AS account_name FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE j.source_id = ? ORDER BY l.debit_paise DESC`,
      [id],
    ),
  };
}

export function listExpenses(e: ShopEngine, r: { from?: string; to?: string; limit?: number } = {}) {
  return e.db.all(
    `SELECT x.*, a.name AS account_name FROM expenses x JOIN accounts a ON a.id = x.account_id
     WHERE x.business_date BETWEEN ? AND ? ORDER BY x.business_date DESC, x.hlc DESC LIMIT ?`,
    [r.from ?? '0000-01-01', r.to ?? '9999-12-31', r.limit ?? 300],
  );
}

export function listAccounts(e: ShopEngine, r: { type?: string } = {}) {
  return e.db.all(`SELECT * FROM accounts WHERE deleted = 0 AND (? IS NULL OR type = ?) ORDER BY code`, [r.type ?? null, r.type ?? null]);
}

export function listMoneyEntries(e: ShopEngine, r: { limit?: number } = {}) {
  return e.db.all(
    `SELECT j.*, (SELECT sum(debit_paise) FROM journal_lines l WHERE l.entry_id = j.id) AS amount_paise
     FROM journal_entries j WHERE j.source_type IN ('money', 'day_close', 'expense') ORDER BY j.hlc DESC LIMIT ?`,
    [r.limit ?? 100],
  );
}

export function listCashSessions(e: ShopEngine) {
  return e.db.all(`SELECT * FROM cash_sessions WHERE branch_id = ? ORDER BY hlc DESC LIMIT 60`, [e.branchId]);
}

export function listOps(e: ShopEngine, r: { limit?: number; entityId?: string; q?: string; before?: string } = {}) {
  const params: unknown[] = [];
  let where = '1 = 1';
  if (r.entityId) {
    where += ` AND entity_id = ?`;
    params.push(r.entityId);
  }
  if (r.q) {
    where += ` AND (type LIKE ? OR entity LIKE ? OR user_id LIKE ?)`;
    params.push(`%${r.q}%`, `%${r.q}%`, `%${r.q}%`);
  }
  if (r.before) {
    where += ` AND hlc < ?`;
    params.push(r.before);
  }
  params.push(r.limit ?? 100);
  return e.db
    .all(`SELECT * FROM ops WHERE ${where} ORDER BY hlc DESC LIMIT ?`, params)
    .map((o): Row => ({ ...o, payload: JSON.parse(o.payload) }));
}

export function listExceptions(e: ShopEngine, r: { status?: string } = {}) {
  return e.db
    .all(`SELECT * FROM exceptions WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200`, [r.status ?? null, r.status ?? null])
    .map((x): Row => ({ ...x, details: JSON.parse(x.details || '{}') }));
}

export function resolveException(e: ShopEngine, id: string, status: 'resolved' | 'ignored') {
  e.db.run(`UPDATE exceptions SET status = ?, resolved_at = ? WHERE id = ?`, [status, e.now(), id]);
}

export function searchAll(e: ShopEngine, q: string) {
  const like = `%${q.trim()}%`;
  if (!q.trim()) return { products: [], parties: [], sales: [] } as Record<string, Row[]>;
  return {
    products: e.db.all(`SELECT id, name, price_paise, unit FROM products WHERE deleted = 0 AND (name LIKE ? OR barcode = ?) LIMIT 8`, [like, q.trim()]),
    parties: e.db.all(`SELECT id, name, phone, kind FROM parties WHERE deleted = 0 AND (name LIKE ? OR phone LIKE ?) LIMIT 8`, [like, like]),
    sales: e.db.all(`SELECT id, doc_no, total_paise, business_date FROM sales_docs WHERE doc_no LIKE ? ORDER BY hlc DESC LIMIT 8`, [like]),
  };
}
