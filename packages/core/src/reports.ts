import type { Row } from './db';
import type { ShopEngine } from './engine';
import { addDays, daysBetween, divRound } from './money';
import { cashBalance } from './services/money';

interface Range {
  from: string;
  to: string;
  branchId?: string | null;
}

interface AccountBalance {
  id: string;
  code: string;
  name: string;
  type: string;
  system_key: string | null;
  dr: number;
  cr: number;
}

function balances(e: ShopEngine, from: string, to: string, branchId?: string | null): AccountBalance[] {
  return e.db.all<AccountBalance>(
    `SELECT a.id, a.code, a.name, a.type, a.system_key,
            coalesce(sum(d.debit_paise), 0) AS dr, coalesce(sum(d.credit_paise), 0) AS cr
     FROM accounts a
     LEFT JOIN account_daily d ON d.account_id = a.id AND d.business_date BETWEEN ? AND ? ${branchId ? 'AND d.branch_id = ?' : ''}
     WHERE a.deleted = 0
     GROUP BY a.id ORDER BY a.code`,
    branchId ? [from, to, branchId] : [from, to],
  );
}

const SALE_TYPES = `('tax_invoice','bill_of_supply','invoice_cum_bos','cash_memo')`;
const NOT_VOID = `NOT EXISTS (SELECT 1 FROM doc_events v WHERE v.doc_id = d.id AND v.event = 'void')`;

// ---------------- P&L ----------------

function pnlCore(e: ShopEngine, r: Range) {
  const rows = balances(e, r.from, r.to, r.branchId);
  const inc = (a: AccountBalance) => a.cr - a.dr;
  const exp = (a: AccountBalance) => a.dr - a.cr;
  const get = (k: string) => rows.find((a) => a.system_key === k);
  const sales = get('sales') ? inc(get('sales')!) : 0;
  const returns = get('sales_returns') ? -inc(get('sales_returns')!) : 0;
  const netSales = sales - returns;
  const otherIncome = rows
    .filter((a) => a.type === 'income' && a.system_key !== 'sales' && a.system_key !== 'sales_returns')
    .map((a) => ({ accountId: a.id, code: a.code, name: a.name, amountPaise: inc(a) }))
    .filter((x) => x.amountPaise !== 0);
  const cogs = get('cogs') ? exp(get('cogs')!) : 0;
  const grossProfit = netSales - cogs;
  const expenses = rows
    .filter((a) => a.type === 'expense' && a.system_key !== 'cogs')
    .map((a) => ({ accountId: a.id, code: a.code, name: a.name, systemKey: a.system_key, amountPaise: exp(a) }))
    .filter((x) => x.amountPaise !== 0);
  const totalOther = otherIncome.reduce((s, x) => s + x.amountPaise, 0);
  const totalExpenses = expenses.reduce((s, x) => s + x.amountPaise, 0);
  const netProfit = grossProfit + totalOther - totalExpenses;
  return {
    salesPaise: sales,
    returnsPaise: returns,
    netSalesPaise: netSales,
    cogsPaise: cogs,
    grossProfitPaise: grossProfit,
    grossMarginBp: netSales ? divRound(grossProfit * 10000, netSales) : 0,
    otherIncome,
    otherIncomePaise: totalOther,
    expenses,
    totalExpensesPaise: totalExpenses,
    netProfitPaise: netProfit,
    netMarginBp: netSales ? divRound(netProfit * 10000, netSales) : 0,
  };
}

export function profitAndLoss(e: ShopEngine, r: Range) {
  const current = pnlCore(e, r);
  const len = daysBetween(r.from, r.to) + 1;
  const prevTo = addDays(r.from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));
  const prev = pnlCore(e, { from: prevFrom, to: prevTo, branchId: r.branchId });
  const cashIn = e.db.get<{ inflow: number; outflow: number }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount_paise END), 0) AS inflow,
            coalesce(sum(CASE WHEN direction = 'out' THEN amount_paise END), 0) AS outflow
     FROM payments WHERE business_date BETWEEN ? AND ? ${r.branchId ? 'AND branch_id = ?' : ''}`,
    r.branchId ? [r.from, r.to, r.branchId] : [r.from, r.to],
  )!;
  return {
    ...r,
    ...current,
    previous: { from: prevFrom, to: prevTo, netSalesPaise: prev.netSalesPaise, grossProfitPaise: prev.grossProfitPaise, netProfitPaise: prev.netProfitPaise },
    cashFlow: { inPaise: cashIn.inflow, outPaise: cashIn.outflow, netPaise: cashIn.inflow - cashIn.outflow },
  };
}

// ---------------- Balance sheet / trial balance ----------------

export function balanceSheet(e: ShopEngine, r: { asOf: string; branchId?: string | null }) {
  const rows = balances(e, '0000-01-01', r.asOf, r.branchId);
  const line = (a: AccountBalance, sign: 1 | -1) => ({ accountId: a.id, code: a.code, name: a.name, systemKey: a.system_key, amountPaise: sign * (a.dr - a.cr) });
  const assets = rows.filter((a) => a.type === 'asset').map((a) => line(a, 1)).filter((x) => x.amountPaise !== 0);
  const liabilities = rows.filter((a) => a.type === 'liability').map((a) => line(a, -1)).filter((x) => x.amountPaise !== 0);
  const equity = rows.filter((a) => a.type === 'equity').map((a) => line(a, -1)).filter((x) => x.amountPaise !== 0);
  const income = rows.filter((a) => a.type === 'income').reduce((s, a) => s + (a.cr - a.dr), 0);
  const expense = rows.filter((a) => a.type === 'expense').reduce((s, a) => s + (a.dr - a.cr), 0);
  const profit = income - expense;
  const sum = (xs: { amountPaise: number }[]) => xs.reduce((s, x) => s + x.amountPaise, 0);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + profit;
  return {
    asOf: r.asOf,
    branchId: r.branchId ?? null,
    assets,
    liabilities,
    equity,
    profitToDatePaise: profit,
    totalAssetsPaise: totalAssets,
    totalLiabilitiesPaise: totalLiabilities,
    totalEquityPaise: totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

export function trialBalance(e: ShopEngine, r: { from?: string; to: string; branchId?: string | null }) {
  const rows = balances(e, r.from ?? '0000-01-01', r.to, r.branchId);
  const accounts = rows
    .map((a) => {
      const net = a.dr - a.cr;
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, debitPaise: a.dr, creditPaise: a.cr, balanceDebitPaise: net > 0 ? net : 0, balanceCreditPaise: net < 0 ? -net : 0 };
    })
    .filter((a) => a.debitPaise || a.creditPaise);
  const totalDebit = accounts.reduce((s, a) => s + a.debitPaise, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.creditPaise, 0);
  return { from: r.from ?? null, to: r.to, accounts, totalDebitPaise: totalDebit, totalCreditPaise: totalCredit, balanced: totalDebit === totalCredit };
}

// ---------------- Day book / ledgers ----------------

export function dayBook(e: ShopEngine, r: Range) {
  const entries = e.db.all(
    `SELECT * FROM journal_entries WHERE business_date BETWEEN ? AND ? ${r.branchId ? 'AND branch_id = ?' : ''} ORDER BY business_date, hlc`,
    r.branchId ? [r.from, r.to, r.branchId] : [r.from, r.to],
  );
  const lines = e.db.all(
    `SELECT l.*, a.name AS account_name, a.code AS account_code, p.name AS party_name
     FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id LEFT JOIN parties p ON p.id = l.party_id
     WHERE j.business_date BETWEEN ? AND ? ORDER BY a.code`,
    [r.from, r.to],
  );
  const byEntry = new Map<string, Row[]>();
  for (const l of lines) (byEntry.get(l.entry_id) ?? byEntry.set(l.entry_id, []).get(l.entry_id)!).push(l);
  return entries.map((en) => ({ ...en, lines: (byEntry.get(en.id) ?? []).sort((a, b) => b.debit_paise - a.debit_paise) }));
}

export function accountLedger(e: ShopEngine, r: { accountId: string; from: string; to: string; branchId?: string | null }) {
  const account = e.db.get(`SELECT * FROM accounts WHERE id = ?`, [r.accountId]);
  const bArgs = r.branchId ? [r.branchId] : [];
  const opening =
    e.db.get<{ b: number }>(
      `SELECT coalesce(sum(debit_paise - credit_paise), 0) AS b FROM journal_lines WHERE account_id = ? AND business_date < ? ${r.branchId ? 'AND branch_id = ?' : ''}`,
      [r.accountId, r.from, ...bArgs],
    )?.b ?? 0;
  const rows = e.db.all(
    `SELECT l.*, j.narration, j.source_type, j.source_id, p.name AS party_name FROM journal_lines l
     JOIN journal_entries j ON j.id = l.entry_id LEFT JOIN parties p ON p.id = l.party_id
     WHERE l.account_id = ? AND l.business_date BETWEEN ? AND ? ${r.branchId ? 'AND l.branch_id = ?' : ''}
     ORDER BY l.business_date, l.hlc`,
    [r.accountId, r.from, r.to, ...bArgs],
  );
  let bal = opening;
  const lines = rows.map((l) => {
    bal += l.debit_paise - l.credit_paise;
    return { ...l, balance_paise: bal };
  });
  return { account, from: r.from, to: r.to, openingPaise: opening, lines, closingPaise: bal };
}

/** Khata passbook. For customers a positive balance means they owe us; for suppliers, we owe them. */
export function partyStatement(e: ShopEngine, r: { partyId: string; from?: string; to?: string }) {
  const party = e.db.get(`SELECT * FROM parties WHERE id = ?`, [r.partyId]);
  const from = r.from ?? '0000-01-01';
  const to = r.to ?? '9999-12-31';
  const ar = e.acct('ar');
  const ap = e.acct('ap');
  const sign = party?.kind === 'supplier' ? -1 : 1;
  const opening =
    sign *
    (e.db.get<{ b: number }>(
      `SELECT coalesce(sum(debit_paise - credit_paise), 0) AS b FROM journal_lines WHERE party_id = ? AND account_id IN (?, ?) AND business_date < ?`,
      [r.partyId, ar, ap, from],
    )?.b ?? 0);
  const rows = e.db.all(
    `SELECT l.business_date, l.debit_paise, l.credit_paise, j.narration, j.source_type, j.source_id, l.hlc,
            s.doc_no AS sale_doc_no, pd.supplier_bill_no
     FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id
     LEFT JOIN sales_docs s ON s.id = j.source_id
     LEFT JOIN purchase_docs pd ON pd.id = j.source_id
     WHERE l.party_id = ? AND l.account_id IN (?, ?) AND l.business_date BETWEEN ? AND ?
     ORDER BY l.business_date, l.hlc`,
    [r.partyId, ar, ap, from, to],
  );
  let bal = opening;
  const entries = rows.map((x) => {
    const amount = sign * (x.debit_paise - x.credit_paise);
    bal += amount;
    return { ...x, amount_paise: amount, balance_paise: bal };
  });
  return { party, openingPaise: opening, entries, closingPaise: bal };
}

// ---------------- Stock ----------------

export function stockSummary(e: ShopEngine, r: { branchId?: string | null; q?: string; categoryId?: string; lowOnly?: boolean } = {}) {
  const branchId = r.branchId ?? e.branchId;
  const params: unknown[] = [branchId];
  let where = `p.deleted = 0 AND p.track_stock = 1`;
  if (r.q) {
    where += ` AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)`;
    params.push(`%${r.q}%`, r.q, r.q);
  }
  if (r.categoryId) {
    where += ` AND p.category_id = ?`;
    params.push(r.categoryId);
  }
  const rows = e.db.all<Row>(
    `SELECT p.id, p.name, p.unit, p.sku, p.barcode, p.price_paise, p.cost_paise, p.reorder_level_milli, p.category_id, c.name AS category_name,
            coalesce(s.qty_milli, 0) AS qty_milli, coalesce(s.value_paise, 0) AS value_paise, s.last_cost_paise
     FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.branch_id = ?
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${where} ORDER BY p.name`,
    params,
  ).map((p): Row => ({
    ...p,
    avg_cost_paise: p.qty_milli > 0 ? divRound(p.value_paise * 1000, p.qty_milli) : p.last_cost_paise || p.cost_paise || 0,
    retail_value_paise: p.qty_milli > 0 ? divRound(p.qty_milli * p.price_paise, 1000) : 0,
    low: p.qty_milli <= (p.reorder_level_milli ?? 0),
  }));
  const items = r.lowOnly ? rows.filter((p) => p.low) : rows;
  return {
    items,
    totalValuePaise: rows.reduce((s, p) => s + p.value_paise, 0),
    totalRetailPaise: rows.reduce((s, p) => s + p.retail_value_paise, 0),
    lowCount: rows.filter((p) => p.low).length,
  };
}

// ---------------- Sales analysis ----------------

export function salesSummary(e: ShopEngine, r: Range & { groupBy: 'product' | 'category' | 'day' | 'method' }) {
  const bArgs = r.branchId ? [r.branchId] : [];
  const bWhere = r.branchId ? 'AND d.branch_id = ?' : '';
  const sign = `CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END`;
  if (r.groupBy === 'method') {
    return e.db.all(
      `SELECT method, coalesce(sum(CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END), 0) AS amount_paise, count(*) AS count
       FROM payments d WHERE business_date BETWEEN ? AND ? AND ref_type IN ('sale', 'khata', 'credit_note', 'void') ${bWhere}
       GROUP BY method ORDER BY amount_paise DESC`,
      [r.from, r.to, ...bArgs],
    );
  }
  if (r.groupBy === 'day') {
    return e.db.all(
      `SELECT d.business_date AS day, sum(CASE WHEN d.doc_type <> 'credit_note' THEN 1 ELSE 0 END) AS bills,
              sum(${sign} * d.taxable_paise) AS net_paise, sum(${sign} * (d.total_paise - d.taxable_paise - d.round_off_paise)) AS tax_paise,
              sum(${sign} * d.total_paise) AS total_paise, sum(${sign} * d.cost_total_paise) AS cost_paise
       FROM sales_docs d WHERE d.business_date BETWEEN ? AND ? AND ${NOT_VOID} ${bWhere}
       GROUP BY d.business_date ORDER BY d.business_date`,
      [r.from, r.to, ...bArgs],
    ).map((x): Row => ({ ...x, profit_paise: x.net_paise - x.cost_paise }));
  }
  const key = r.groupBy === 'product' ? 'l.product_id' : `coalesce(p.category_id, '')`;
  const label = r.groupBy === 'product' ? 'l.name' : `coalesce(c.name, 'Uncategorised')`;
  return e.db.all(
    `SELECT ${key} AS key, ${label} AS label, sum(${sign} * l.qty_milli) AS qty_milli, sum(${sign} * l.taxable_paise) AS net_paise,
            sum(${sign} * l.line_total_paise) AS total_paise, sum(${sign} * l.cost_paise) AS cost_paise, count(DISTINCT d.id) AS bills
     FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE d.business_date BETWEEN ? AND ? AND ${NOT_VOID} ${bWhere}
     GROUP BY ${key} ORDER BY net_paise DESC`,
    [r.from, r.to, ...bArgs],
  ).map((x): Row => ({ ...x, profit_paise: x.net_paise - x.cost_paise, margin_bp: x.net_paise ? divRound((x.net_paise - x.cost_paise) * 10000, x.net_paise) : 0 }));
}

// ---------------- GST ----------------

export function gstSummary(e: ShopEngine, r: Range) {
  const business = e.business();
  const bArgs = r.branchId ? [r.branchId] : [];
  const bWhere = r.branchId ? 'AND d.branch_id = ?' : '';
  const sign = `CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END`;
  const taxDocs = `d.doc_type IN ('tax_invoice', 'invoice_cum_bos', 'credit_note')`;
  const outputByRate = e.db.all(
    `SELECT l.gst_rate_bp AS rate_bp, sum(${sign} * l.taxable_paise) AS taxable_paise, sum(${sign} * l.cgst_paise) AS cgst_paise,
            sum(${sign} * l.sgst_paise) AS sgst_paise, sum(${sign} * l.igst_paise) AS igst_paise, sum(${sign} * l.cess_paise) AS cess_paise
     FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     WHERE d.business_date BETWEEN ? AND ? AND ${taxDocs} AND ${NOT_VOID} ${bWhere}
     GROUP BY l.gst_rate_bp ORDER BY l.gst_rate_bp`,
    [r.from, r.to, ...bArgs],
  );
  const hsn = e.db.all(
    `SELECT coalesce(l.hsn, '') AS hsn, l.unit, l.gst_rate_bp AS rate_bp, sum(${sign} * l.qty_milli) AS qty_milli,
            sum(${sign} * l.taxable_paise) AS taxable_paise, sum(${sign} * (l.cgst_paise + l.sgst_paise + l.igst_paise + l.cess_paise)) AS tax_paise,
            sum(${sign} * l.line_total_paise) AS total_paise
     FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     WHERE d.business_date BETWEEN ? AND ? AND ${taxDocs} AND ${NOT_VOID} ${bWhere}
     GROUP BY coalesce(l.hsn, ''), l.unit, l.gst_rate_bp ORDER BY hsn`,
    [r.from, r.to, ...bArgs],
  );
  const b2b = e.db.all(
    `SELECT d.doc_no, d.doc_type, d.business_date, d.party_name, d.party_gstin, d.place_of_supply, d.taxable_paise,
            d.cgst_paise, d.sgst_paise, d.igst_paise, d.cess_paise, d.total_paise
     FROM sales_docs d WHERE d.business_date BETWEEN ? AND ? AND d.party_gstin IS NOT NULL AND ${taxDocs} AND ${NOT_VOID} ${bWhere}
     ORDER BY d.business_date, d.doc_no`,
    [r.from, r.to, ...bArgs],
  );
  const input = e.db.get(
    `SELECT coalesce(sum(d.cgst_paise), 0) AS cgst_paise, coalesce(sum(d.sgst_paise), 0) AS sgst_paise,
            coalesce(sum(d.igst_paise), 0) AS igst_paise, coalesce(sum(d.cess_paise), 0) AS cess_paise, coalesce(sum(d.taxable_paise), 0) AS taxable_paise
     FROM purchase_docs d WHERE d.business_date BETWEEN ? AND ? AND d.itc_eligible = 1 ${bWhere}`,
    [r.from, r.to, ...bArgs],
  )!;
  const docs = e.db.all(
    `SELECT d.doc_type, d.series, count(*) AS count, min(d.doc_no) AS first_no, max(d.doc_no) AS last_no,
            sum(CASE WHEN ${NOT_VOID} THEN 0 ELSE 1 END) AS cancelled
     FROM sales_docs d WHERE d.business_date BETWEEN ? AND ? ${bWhere} GROUP BY d.doc_type, d.series`,
    [r.from, r.to, ...bArgs],
  );
  const out = outputByRate.reduce(
    (s, x) => ({ cgst: s.cgst + x.cgst_paise, sgst: s.sgst + x.sgst_paise, igst: s.igst + x.igst_paise, cess: s.cess + x.cess_paise }),
    { cgst: 0, sgst: 0, igst: 0, cess: 0 },
  );
  const turnover =
    e.db.get<{ t: number }>(
      `SELECT coalesce(sum(${sign} * d.total_paise), 0) AS t FROM sales_docs d WHERE d.business_date BETWEEN ? AND ? AND ${NOT_VOID} ${bWhere}`,
      [r.from, r.to, ...bArgs],
    )?.t ?? 0;
  return {
    ...r,
    scheme: business.gst_scheme,
    outputByRate,
    hsn,
    b2b,
    input,
    docs,
    output: { cgstPaise: out.cgst, sgstPaise: out.sgst, igstPaise: out.igst, cessPaise: out.cess },
    netPayable: {
      cgstPaise: out.cgst - input.cgst_paise,
      sgstPaise: out.sgst - input.sgst_paise,
      igstPaise: out.igst - input.igst_paise,
      cessPaise: out.cess - input.cess_paise,
    },
    turnoverPaise: turnover,
    compositionTaxPaise: business.gst_scheme === 'composition' ? divRound(turnover * (business.composition_rate_bp ?? 100), 10000) : 0,
  };
}

// ---------------- Dashboard ----------------

export function dashboard(e: ShopEngine, r: { date?: string; branchId?: string | null } = {}) {
  const date = r.date ?? e.today();
  const branchId = r.branchId === undefined ? e.branchId : r.branchId;
  const bArgs = branchId ? [branchId] : [];
  const bWhere = branchId ? 'AND d.branch_id = ?' : '';
  const today = e.db.get(
    `SELECT coalesce(sum(CASE WHEN d.doc_type <> 'credit_note' THEN d.total_paise ELSE -d.total_paise END), 0) AS sales_paise,
            coalesce(sum(CASE WHEN d.doc_type <> 'credit_note' THEN 1 ELSE 0 END), 0) AS bills,
            coalesce(sum(CASE WHEN d.doc_type <> 'credit_note' THEN d.due_paise ELSE 0 END), 0) AS credit_paise
     FROM sales_docs d WHERE d.business_date = ? AND ${NOT_VOID} ${bWhere}`,
    [date, ...bArgs],
  )!;
  const p = pnlCore(e, { from: date, to: date, branchId });
  const methods = e.db.all(
    `SELECT method, sum(CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END) AS amount_paise
     FROM payments d WHERE business_date = ? AND ref_type IN ('sale', 'khata', 'credit_note', 'void') ${bWhere} GROUP BY method`,
    [date, ...bArgs],
  );
  const recv = e.db.get<{ r: number; p: number; n: number }>(
    `SELECT coalesce(sum(CASE WHEN receivable_paise > 0 THEN receivable_paise END), 0) AS r,
            coalesce(sum(CASE WHEN payable_paise > 0 THEN payable_paise END), 0) AS p,
            coalesce(sum(CASE WHEN receivable_paise > 0 THEN 1 END), 0) AS n
     FROM party_balances`,
  )!;
  const from = addDays(date, -13);
  const series = e.db.all(
    `SELECT d.business_date AS day,
            sum(CASE WHEN a.system_key = 'sales' THEN d.credit_paise - d.debit_paise WHEN a.system_key = 'sales_returns' THEN d.credit_paise - d.debit_paise ELSE 0 END) AS net_sales_paise,
            sum(CASE WHEN a.system_key = 'cogs' THEN d.debit_paise - d.credit_paise ELSE 0 END) AS cogs_paise
     FROM account_daily d JOIN accounts a ON a.id = d.account_id
     WHERE d.business_date BETWEEN ? AND ? ${branchId ? 'AND d.branch_id = ?' : ''}
     GROUP BY d.business_date ORDER BY d.business_date`,
    [from, date, ...bArgs],
  );
  const byDay = new Map(series.map((s) => [s.day, s]));
  const last14 = Array.from({ length: 14 }, (_, i) => {
    const day = addDays(from, i);
    const s = byDay.get(day);
    const net = s?.net_sales_paise ?? 0;
    const cogs = s?.cogs_paise ?? 0;
    return { day, netSalesPaise: net, grossProfitPaise: net - cogs };
  });
  const low = stockSummary(e, { branchId: branchId ?? undefined, lowOnly: true });
  const top = e.db.all(
    `SELECT l.name, sum(l.qty_milli) AS qty_milli, l.unit, sum(l.taxable_paise) AS net_paise
     FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
     WHERE d.business_date BETWEEN ? AND ? AND d.doc_type <> 'credit_note' AND ${NOT_VOID} ${bWhere}
     GROUP BY l.product_id ORDER BY net_paise DESC LIMIT 5`,
    [addDays(date, -6), date, ...bArgs],
  );
  const pending = e.db.get<{ n: number }>(`SELECT count(*) AS n FROM ops WHERE origin = 'local' AND seq IS NULL`)?.n ?? 0;
  const exceptions = e.db.get<{ n: number }>(`SELECT count(*) AS n FROM exceptions WHERE status = 'open'`)?.n ?? 0;
  return {
    date,
    branchId,
    salesPaise: today.sales_paise,
    bills: today.bills,
    creditGivenPaise: today.credit_paise,
    netSalesPaise: p.netSalesPaise,
    grossProfitPaise: p.grossProfitPaise,
    grossMarginBp: p.grossMarginBp,
    methods,
    cashInHandPaise: branchId ? cashBalance(e, branchId) : null,
    receivablePaise: recv.r,
    receivableCount: recv.n,
    payablePaise: recv.p,
    last14,
    lowStock: low.items.slice(0, 8),
    lowStockCount: low.lowCount,
    topItems: top,
    pendingOps: pending,
    openExceptions: exceptions,
    lastBackupAt: e.meta('last_backup_at') ? Number(e.meta('last_backup_at')) : null,
    lastSyncAt: e.meta('last_sync_at') ? Number(e.meta('last_sync_at')) : null,
  };
}
