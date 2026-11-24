import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createApi, ShopEngine, wrapOo1, type EngineOptions, type SetupInput } from '../src';

let sqlite3: any;

export async function sqlite() {
  if (!sqlite3) sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
  return sqlite3;
}

export async function newEngine(opts: EngineOptions = {}) {
  const s = await sqlite();
  const raw = new s.oo1.DB(':memory:', 'c');
  const db = wrapOo1(raw, s);
  const e = ShopEngine.open(db, opts);
  return { e, api: createApi(e), db, raw };
}

/** Opens a database file image (e.g. from a backup) as a new engine. */
export async function engineFromBytes(bytes: Uint8Array) {
  const s = await sqlite();
  const raw = new s.oo1.DB(':memory:', 'c');
  const p = s.wasm.allocFromTypedArray(bytes);
  const rc = s.capi.sqlite3_deserialize(
    raw.pointer,
    'main',
    p,
    bytes.length,
    bytes.length,
    s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) throw new Error(`deserialize failed: ${rc}`);
  const db = wrapOo1(raw, s);
  const e = ShopEngine.open(db);
  return { e, api: createApi(e), db, raw };
}

export const GSTIN_MH = '27AAAPL1234C1Z5';

export function shopInput(over: Partial<SetupInput> = {}): SetupInput {
  return {
    businessName: 'Test Kirana',
    shopType: 'kirana',
    gstScheme: 'regular',
    stateCode: '27',
    gstin: GSTIN_MH,
    priceMode: 'inclusive',
    roundOff: false,
    upiId: 'testkirana@upi',
    invoicePrefix: 'INV',
    ...over,
  };
}

export async function newShop(over: Partial<SetupInput> = {}, opts: EngineOptions = {}) {
  const ctx = await newEngine(opts);
  ctx.api.setupShop(shopInput(over));
  return ctx;
}

/** A comparable snapshot of everything that must converge across devices. */
export function digest(e: ShopEngine) {
  const db = e.db;
  return {
    stock: db.all(
      `SELECT branch_id, product_id, qty_milli, value_paise, last_cost_paise FROM stock_levels
       WHERE qty_milli <> 0 OR value_paise <> 0 ORDER BY branch_id, product_id`,
    ),
    accounts: db.all(
      `SELECT account_id, branch_id, business_date, debit_paise, credit_paise FROM account_daily
       WHERE debit_paise <> 0 OR credit_paise <> 0 ORDER BY account_id, branch_id, business_date`,
    ),
    parties: db.all(`SELECT party_id, receivable_paise, payable_paise FROM party_balances ORDER BY party_id`),
    products: db.all(`SELECT id, name, price_paise, deleted, field_hlc FROM products ORDER BY id`),
    customers: db.all(`SELECT id, name, phone, credit_limit_paise, field_hlc FROM parties ORDER BY id`),
    sales: db.all(`SELECT id, doc_no, total_paise FROM sales_docs ORDER BY id`),
    journal: db.get(`SELECT count(*) AS n, sum(debit_paise) AS dr, sum(credit_paise) AS cr FROM journal_lines`),
    ops: db.get(`SELECT count(*) AS n FROM ops`),
  };
}

export function rupees(n: number) {
  return Math.round(n * 100);
}
