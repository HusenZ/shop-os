import type { SqlDb } from './db';

/**
 * Data classes:
 *  - REFERENCE tables are mutable; they merge per field (LWW on HLC) through patch ops.
 *  - FACT tables are insert-only; they merge by union through fact ops.
 *  - DERIVED tables are local caches rebuilt from facts; never synced.
 *  - LOCAL tables belong to this device only.
 */
export const REFERENCE_TABLES = ['businesses', 'branches', 'categories', 'products', 'parties', 'accounts'] as const;
export const FACT_TABLES = [
  'sales_docs',
  'sales_lines',
  'purchase_docs',
  'purchase_lines',
  'payments',
  'stock_movements',
  'journal_entries',
  'journal_lines',
  'expenses',
  'doc_events',
  'cash_sessions',
  'stock_transfers',
] as const;

export type ReferenceTable = (typeof REFERENCE_TABLES)[number];
export type FactTable = (typeof FACT_TABLES)[number];

const REF = `id TEXT PRIMARY KEY, field_hlc TEXT NOT NULL DEFAULT '{}', updated_hlc TEXT, deleted INTEGER NOT NULL DEFAULT 0`;
const FACT = `id TEXT PRIMARY KEY, business_id TEXT, branch_id TEXT, op_id TEXT, hlc TEXT, created_at INTEGER, created_by TEXT, device_id TEXT`;

const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE businesses (${REF},
  name TEXT, legal_name TEXT, gst_scheme TEXT, composition_rate_bp INTEGER, shop_type TEXT, fy_start_month INTEGER,
  price_mode TEXT, round_off INTEGER, lock_date TEXT, phone TEXT, email TEXT, pan TEXT);

CREATE TABLE branches (${REF},
  business_id TEXT, name TEXT, code TEXT, kind TEXT, address TEXT, phone TEXT, state_code TEXT, gstin TEXT,
  upi_id TEXT, upi_name TEXT, invoice_prefix TEXT, receipt_footer TEXT, negative_stock TEXT, receipt_width TEXT);

CREATE TABLE categories (${REF}, business_id TEXT, parent_id TEXT, name TEXT, color TEXT, sort INTEGER);

CREATE TABLE products (${REF},
  business_id TEXT, category_id TEXT, name TEXT, sku TEXT, barcode TEXT, hsn TEXT, unit TEXT, allow_decimal INTEGER,
  mrp_paise INTEGER, price_paise INTEGER, cost_paise INTEGER, gst_rate_bp INTEGER, cess_rate_bp INTEGER,
  track_stock INTEGER, reorder_level_milli INTEGER, is_active INTEGER, favourite INTEGER);
CREATE INDEX products_name ON products(name);
CREATE INDEX products_barcode ON products(barcode);
CREATE INDEX products_sku ON products(sku);
CREATE INDEX products_category ON products(category_id);

CREATE TABLE parties (${REF},
  business_id TEXT, kind TEXT, name TEXT, phone TEXT, email TEXT, gstin TEXT, state_code TEXT, address TEXT,
  notes TEXT, tags TEXT, credit_limit_paise INTEGER, credit_days INTEGER, merged_into_id TEXT);
CREATE INDEX parties_phone ON parties(phone);
CREATE INDEX parties_name ON parties(name);

CREATE TABLE accounts (${REF},
  business_id TEXT, code TEXT, name TEXT, type TEXT, system_key TEXT, parent_id TEXT, is_system INTEGER);
CREATE INDEX accounts_system_key ON accounts(system_key);

CREATE TABLE sales_docs (${FACT},
  doc_type TEXT, series TEXT, fy TEXT, seq INTEGER, doc_no TEXT, business_date TEXT,
  party_id TEXT, party_name TEXT, party_phone TEXT, party_gstin TEXT, place_of_supply TEXT, price_mode TEXT,
  subtotal_paise INTEGER, discount_paise INTEGER, taxable_paise INTEGER, cgst_paise INTEGER, sgst_paise INTEGER,
  igst_paise INTEGER, cess_paise INTEGER, round_off_paise INTEGER, total_paise INTEGER, paid_paise INTEGER,
  due_paise INTEGER, cost_total_paise INTEGER, original_doc_id TEXT, notes TEXT);
CREATE INDEX sales_docs_date ON sales_docs(business_date);
CREATE INDEX sales_docs_party ON sales_docs(party_id);
CREATE INDEX sales_docs_original ON sales_docs(original_doc_id);

CREATE TABLE sales_lines (${FACT},
  doc_id TEXT, line_no INTEGER, product_id TEXT, name TEXT, hsn TEXT, unit TEXT, qty_milli INTEGER,
  unit_price_paise INTEGER, discount_paise INTEGER, taxable_paise INTEGER, gst_rate_bp INTEGER,
  cgst_paise INTEGER, sgst_paise INTEGER, igst_paise INTEGER, cess_paise INTEGER, line_total_paise INTEGER,
  cost_paise INTEGER, original_line_id TEXT);
CREATE INDEX sales_lines_doc ON sales_lines(doc_id);
CREATE INDEX sales_lines_product ON sales_lines(product_id);
CREATE INDEX sales_lines_original ON sales_lines(original_line_id);

CREATE TABLE purchase_docs (${FACT},
  doc_type TEXT, supplier_bill_no TEXT, business_date TEXT, party_id TEXT, party_name TEXT, itc_eligible INTEGER,
  taxable_paise INTEGER, cgst_paise INTEGER, sgst_paise INTEGER, igst_paise INTEGER, cess_paise INTEGER,
  total_paise INTEGER, paid_paise INTEGER, due_paise INTEGER, original_doc_id TEXT, notes TEXT);
CREATE INDEX purchase_docs_date ON purchase_docs(business_date);
CREATE INDEX purchase_docs_party ON purchase_docs(party_id);

CREATE TABLE purchase_lines (${FACT},
  doc_id TEXT, line_no INTEGER, product_id TEXT, name TEXT, hsn TEXT, unit TEXT, qty_milli INTEGER,
  unit_cost_paise INTEGER, taxable_paise INTEGER, gst_rate_bp INTEGER, cgst_paise INTEGER, sgst_paise INTEGER,
  igst_paise INTEGER, cess_paise INTEGER, line_total_paise INTEGER, inventory_value_paise INTEGER);
CREATE INDEX purchase_lines_doc ON purchase_lines(doc_id);

CREATE TABLE payments (${FACT},
  direction TEXT, party_id TEXT, method TEXT, amount_paise INTEGER, tendered_paise INTEGER, change_paise INTEGER,
  business_date TEXT, ref_type TEXT, ref_id TEXT, reference TEXT, note TEXT);
CREATE INDEX payments_date ON payments(business_date);
CREATE INDEX payments_ref ON payments(ref_id);
CREATE INDEX payments_party ON payments(party_id);

CREATE TABLE stock_movements (${FACT},
  product_id TEXT, qty_delta_milli INTEGER, value_paise INTEGER, unit_cost_paise INTEGER, reason TEXT,
  source_type TEXT, source_id TEXT, business_date TEXT, note TEXT);
CREATE INDEX stock_movements_product ON stock_movements(product_id, branch_id);
CREATE INDEX stock_movements_source ON stock_movements(source_id);

CREATE TABLE journal_entries (${FACT},
  business_date TEXT, source_type TEXT, source_id TEXT, narration TEXT, reverses_id TEXT);
CREATE INDEX journal_entries_date ON journal_entries(business_date);
CREATE INDEX journal_entries_source ON journal_entries(source_id);

CREATE TABLE journal_lines (${FACT},
  entry_id TEXT, business_date TEXT, account_id TEXT, party_id TEXT, debit_paise INTEGER, credit_paise INTEGER);
CREATE INDEX journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX journal_lines_account ON journal_lines(account_id, business_date);
CREATE INDEX journal_lines_party ON journal_lines(party_id);

CREATE TABLE expenses (${FACT},
  business_date TEXT, account_id TEXT, method TEXT, amount_paise INTEGER, payee TEXT, note TEXT);
CREATE INDEX expenses_date ON expenses(business_date);

CREATE TABLE doc_events (${FACT}, doc_kind TEXT, doc_id TEXT, event TEXT, reason TEXT, business_date TEXT);
CREATE INDEX doc_events_doc ON doc_events(doc_id);

CREATE TABLE cash_sessions (${FACT},
  business_date TEXT, expected_paise INTEGER, counted_paise INTEGER, difference_paise INTEGER, denominations TEXT, note TEXT);

CREATE TABLE stock_transfers (${FACT}, from_branch_id TEXT, to_branch_id TEXT, business_date TEXT, lines TEXT, note TEXT);

-- Derived (rebuildable, never synced)
CREATE TABLE stock_levels (branch_id TEXT NOT NULL, product_id TEXT NOT NULL, qty_milli INTEGER NOT NULL DEFAULT 0,
  value_paise INTEGER NOT NULL DEFAULT 0, last_cost_paise INTEGER, last_cost_hlc TEXT, PRIMARY KEY (branch_id, product_id));
CREATE TABLE account_daily (account_id TEXT NOT NULL, branch_id TEXT NOT NULL, business_date TEXT NOT NULL,
  debit_paise INTEGER NOT NULL DEFAULT 0, credit_paise INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, branch_id, business_date));
CREATE INDEX account_daily_date ON account_daily(business_date);
CREATE TABLE party_balances (party_id TEXT PRIMARY KEY, receivable_paise INTEGER NOT NULL DEFAULT 0, payable_paise INTEGER NOT NULL DEFAULT 0);

-- Local to this device
CREATE TABLE ops (op_id TEXT PRIMARY KEY, device_id TEXT, user_id TEXT, hlc TEXT, kind TEXT, type TEXT, entity TEXT,
  entity_id TEXT, business_id TEXT, branch_id TEXT, created_at INTEGER, payload TEXT, prev_hash TEXT, hash TEXT,
  seq INTEGER, origin TEXT);
CREATE INDEX ops_hlc ON ops(hlc);
CREATE INDEX ops_pending ON ops(origin, seq);
CREATE INDEX ops_entity ON ops(entity_id);
CREATE TABLE doc_series (device_id TEXT, kind TEXT, fy TEXT, next_seq INTEGER, PRIMARY KEY (device_id, kind, fy));
CREATE TABLE held_bills (id TEXT PRIMARY KEY, label TEXT, cart TEXT, created_at INTEGER);
CREATE TABLE exceptions (id TEXT PRIMARY KEY, kind TEXT, ref_type TEXT, ref_id TEXT, message TEXT, details TEXT,
  status TEXT, created_at INTEGER, resolved_at INTEGER);
`;

function immutabilityTriggers(): string {
  return FACT_TABLES.map(
    (t) => `
CREATE TRIGGER ${t}_immutable_u BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'facts are immutable'); END;
CREATE TRIGGER ${t}_immutable_d BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'facts are immutable'); END;`,
  ).join('\n') +
    `
CREATE TRIGGER ops_immutable_u BEFORE UPDATE ON ops
  WHEN NEW.payload IS NOT OLD.payload OR NEW.hash IS NOT OLD.hash OR NEW.hlc IS NOT OLD.hlc
  BEGIN SELECT RAISE(ABORT, 'ops are immutable'); END;
CREATE TRIGGER ops_immutable_d BEFORE DELETE ON ops BEGIN SELECT RAISE(ABORT, 'ops are immutable'); END;`;
}

export const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: V1 + immutabilityTriggers() }];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function migrate(db: SqlDb): number {
  const hasMeta = db.get<{ n: number }>(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'`);
  let current = 0;
  if (hasMeta && hasMeta.n > 0) {
    current = Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)?.value ?? 0);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, [String(m.version)]);
    });
    current = m.version;
  }
  return current;
}

const columnCache = new WeakMap<SqlDb, Map<string, Set<string>>>();

/** Column names of a table (used to whitelist keys coming from remote ops). */
export function tableColumns(db: SqlDb, table: string): Set<string> {
  let byTable = columnCache.get(db);
  if (!byTable) {
    byTable = new Map();
    columnCache.set(db, byTable);
  }
  let cols = byTable.get(table);
  if (!cols) {
    cols = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
    byTable.set(table, cols);
  }
  return cols;
}
