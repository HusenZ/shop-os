import { describe, expect, it } from 'vitest';
import { addDays, ShopError } from '../src';
import { newShop } from './helpers';

/** Scenario with hand-checked numbers (regular GST shop in Maharashtra, prices inclusive of 18%). */
async function scenario() {
  const ctx = await newShop();
  const { api } = ctx;
  const productId = api.createProduct({ name: 'Floor cleaner', price_paise: 11800, cost_paise: 7000, gst_rate_bp: 1800, hsn: '3402', opening_qty_milli: 10_000 });
  const customerId = api.createParty({ kind: 'customer', name: 'Ramesh', phone: '55500 10001' });
  const supplierId = api.createParty({ kind: 'supplier', name: 'Ganesh Traders', gstin: '27AAAPG1234C1Z5' });
  return { ...ctx, productId, customerId, supplierId };
}

describe('sales, khata, purchases and the books', () => {
  it('posts a cash sale with GST, change and cost of goods', async () => {
    const { api, e, productId } = await scenario();
    const sale = api.issueSale({ lines: [{ productId, qtyMilli: 2000 }], tenders: [{ method: 'cash', amountPaise: 50000 }] });
    expect(sale).toMatchObject({ totalPaise: 23600, paidPaise: 23600, duePaise: 0, changePaise: 26400 });
    expect(sale.docNo).toMatch(/^INV-A\d{4}-00001$/);
    const { doc, lines, journal } = api.getSale(sale.docId);
    expect(doc).toMatchObject({ doc_type: 'tax_invoice', taxable_paise: 20000, cgst_paise: 1800, sgst_paise: 1800, cost_total_paise: 14000 });
    expect(lines[0]).toMatchObject({ qty_milli: 2000, cost_paise: 14000 });
    const byAcct = Object.fromEntries(journal.map((l) => [l.account_name, l.debit_paise - l.credit_paise]));
    expect(byAcct).toEqual({ 'Cash in hand': 23600, Sales: -20000, 'Output CGST': -1800, 'Output SGST': -1800, 'Cost of goods sold': 14000, Inventory: -14000 });
    expect(e.stockLevel(productId)).toMatchObject({ qty_milli: 8000, value_paise: 56000 });
  });

  it('runs a full day and the books still tally', async () => {
    const { api, e, productId, customerId, supplierId } = await scenario();
    const cash = api.issueSale({ lines: [{ productId, qtyMilli: 2000 }], tenders: [{ method: 'cash', amountPaise: 23600 }] });
    const credit = api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], partyId: customerId, tenders: [] });
    expect(credit.duePaise).toBe(11800);
    api.receivePayment({ partyId: customerId, amountPaise: 5000, method: 'upi' });
    expect(api.getParty(customerId).party.receivable_paise).toBe(6800);

    // Purchase 5 @ ₹60 + 18% GST from a registered supplier → input tax credit
    const pur = api.recordPurchase({ partyId: supplierId, supplierBillNo: 'GT-1', lines: [{ productId, qtyMilli: 5000, unitCostPaise: 6000 }] });
    expect(pur).toMatchObject({ totalPaise: 35400, duePaise: 35400 });
    expect(api.getParty(supplierId).party.payable_paise).toBe(35400);
    expect(e.stockLevel(productId)).toMatchObject({ qty_milli: 12000, value_paise: 70000 - 21000 + 30000 });

    // Return 1 from the cash bill (restock, refund cash) and void the credit bill
    const cashLines = api.getSale(cash.docId).lines;
    const cn = api.returnSale({ docId: cash.docId, lines: [{ lineId: cashLines[0].id, qtyMilli: 1000 }], refund: 'cash', restock: true });
    expect(cn.totalPaise).toBe(11800);
    expect(cn.docNo).toMatch(/^CN-A\d{4}-00001$/);
    expect(() => api.voidSale(cash.docId, 'mistake')).toThrow(/returns/);
    api.voidSale(credit.docId, 'Customer cancelled');
    expect(api.getSale(credit.docId).voided).toBe(true);
    expect(api.getParty(customerId).party.receivable_paise).toBe(-5000); // the ₹50 paid is now an advance

    const rent = api.listAccounts({ type: 'expense' }).find((a) => a.code === '6000')!;
    api.recordExpense({ accountId: rent.id, amountPaise: 1000, method: 'cash' });
    api.adjustStock({ productId, qtyDeltaMilli: -1000, reason: 'adjust_damage' });

    const today = e.today();
    const pnl = api.profitAndLoss({ from: today, to: today });
    expect(pnl.netSalesPaise).toBe(10000); // 20000 + 10000 sold − 10000 voided − 10000 returned... (void reverses sales; return books sales_returns)
    expect(pnl.cogsPaise).toBe(7000); // 14000 + 7000 − 7000 (void) − 7000 (restocked return)
    expect(pnl.grossProfitPaise).toBe(3000);
    const loss = pnl.expenses.find((x) => x.systemKey === 'stock_loss')!.amountPaise;
    expect(pnl.netProfitPaise).toBe(3000 - 1000 - loss);

    const tb = api.trialBalance({ to: today });
    expect(tb.balanced).toBe(true);
    const bs = api.balanceSheet({ asOf: today });
    expect(bs.balanced).toBe(true);
    const health = api.healthCheck();
    expect(health.checks.filter((c) => !c.ok)).toEqual([]);

    const gst = api.gstSummary({ from: today, to: today });
    expect(gst.output.cgstPaise).toBe(1800 - 900); // voided bill excluded, credit note subtracts
    expect(gst.input.cgst_paise).toBe(2700);
    expect(gst.netPayable.cgstPaise).toBe(900 - 2700);
  });

  it('enforces credit limits, stock policy and customer rules', async () => {
    const { api, e, productId, customerId } = await scenario();
    expect(() => api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], tenders: [] })).toThrow(/customer/);
    api.updateParty(customerId, { credit_limit_paise: 10000 });
    expect(() => api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], partyId: customerId, tenders: [] })).toThrow(ShopError);
    const ok = api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], partyId: customerId, tenders: [], allowOverCreditLimit: true });
    expect(ok.warnings[0]).toMatch(/over the limit/);

    api.updateBranch(e.branchId!, { negative_stock: 'block' });
    expect(() => api.issueSale({ lines: [{ productId, qtyMilli: 50_000 }], tenders: [{ method: 'cash', amountPaise: 10_000_000 }] })).toThrow(/in stock/);
    api.updateBranch(e.branchId!, { negative_stock: 'warn' });
    const neg = api.issueSale({ lines: [{ productId, qtyMilli: 50_000 }], tenders: [{ method: 'cash', amountPaise: 10_000_000 }] });
    expect(neg.warnings.join()).toMatch(/in stock/);
    expect(() => api.createParty({ kind: 'customer', name: 'Dup', phone: '5550010001' })).toThrow(/already has this phone/);
    expect(() => api.issueSale({ lines: [{ productId, qtyMilli: 1500 }], tenders: [] })).toThrow(/whole/);
  });

  it('locks past periods', async () => {
    const { api, e, productId } = await scenario();
    const yesterday = addDays(e.today(), -1);
    api.lockBooks(yesterday);
    expect(() => api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 11800 }], date: yesterday })).toThrow(/locked/);
    expect(() => api.lockBooks(e.today())).toThrow(/past/);
    api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 11800 }] });
  });

  it('keeps facts and the audit log immutable', async () => {
    const { api, db } = await scenario();
    expect(() => db.run(`UPDATE sales_docs SET total_paise = 1`)).not.toThrow(); // no rows yet
    api.issueSale({ lines: [{ productId: api.listProducts()[0].id, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 11800 }] });
    expect(() => db.run(`UPDATE sales_docs SET total_paise = 1`)).toThrow(/immutable/);
    expect(() => db.run(`DELETE FROM journal_lines`)).toThrow(/immutable/);
    expect(() => db.run(`UPDATE ops SET payload = '{}'`)).toThrow(/immutable/);
    const ops = api.listOps({ limit: 5 });
    expect(ops[0].type).toBe('sale.issued');
    expect(ops[0].payload.tables.journal_lines.length).toBeGreaterThan(0);
  });

  it('records money moves and day close', async () => {
    const { api, productId } = await scenario();
    api.recordMoneyMovement({ kind: 'capital_in', amountPaise: 100000, method: 'cash' });
    api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 11800 }] });
    api.recordMoneyMovement({ kind: 'bank_deposit', amountPaise: 50000 });
    expect(api.cashBalance()).toBe(100000 + 11800 - 50000);
    const close = api.closeDay({ countedPaise: 61000 });
    expect(close).toMatchObject({ expectedPaise: 61800, differencePaise: -800 });
    expect(api.cashBalance()).toBe(61000);
    expect(api.balanceSheet({ asOf: '9999-12-31' }).balanced).toBe(true);
  });

  it('supports non-GST and composition shops', async () => {
    const none = await newShop({ gstScheme: 'none', gstin: undefined });
    const p1 = none.api.createProduct({ name: 'Pen', price_paise: 1000, gst_rate_bp: 1800, opening_qty_milli: 5000, cost_paise: 600 });
    const s1 = none.api.issueSale({ lines: [{ productId: p1, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 1000 }] });
    expect(none.api.getSale(s1.docId).doc).toMatchObject({ doc_type: 'cash_memo', cgst_paise: 0, taxable_paise: 1000 });

    const comp = await newShop({ gstScheme: 'composition' });
    const p2 = comp.api.createProduct({ name: 'Pen', price_paise: 1000, gst_rate_bp: 1800, opening_qty_milli: 5000, cost_paise: 600 });
    const s2 = comp.api.issueSale({ lines: [{ productId: p2, qtyMilli: 3000 }], tenders: [{ method: 'upi', amountPaise: 3000 }] });
    expect(comp.api.getSale(s2.docId).doc.doc_type).toBe('bill_of_supply');
    const gst = comp.api.gstSummary({ from: comp.e.today(), to: comp.e.today() });
    expect(gst.compositionTaxPaise).toBe(30); // 1% of ₹30 turnover
  });

  it('transfers stock between branches at cost', async () => {
    const { api, e, productId } = await scenario();
    const main = e.branchId!;
    const b2 = api.createBranch({ name: 'Station Road' });
    api.transferStock({ toBranchId: b2, lines: [{ productId, qtyMilli: 4000 }] });
    expect(e.stockLevel(productId, main)).toMatchObject({ qty_milli: 6000, value_paise: 42000 });
    expect(e.stockLevel(productId, b2)).toMatchObject({ qty_milli: 4000, value_paise: 28000 });
    api.selectBranch(b2);
    api.issueSale({ lines: [{ productId, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 11800 }] });
    expect(api.profitAndLoss({ from: e.today(), to: e.today(), branchId: b2 }).grossProfitPaise).toBe(3000);
    expect(api.profitAndLoss({ from: e.today(), to: e.today(), branchId: main }).netSalesPaise).toBe(0);
    expect(api.healthCheck().ok).toBe(true);
  });

  it('seeds a consistent demo shop', async () => {
    const { api, e } = await newShop();
    api.seedDemoData();
    const dash = api.dashboard();
    expect(dash.last14.some((d) => d.netSalesPaise > 0)).toBe(true);
    expect(api.listSales().length).toBeGreaterThan(30);
    expect(api.listParties({ withBalance: true }).length).toBeGreaterThan(0);
    expect(api.balanceSheet({ asOf: e.today() }).balanced).toBe(true);
    expect(api.trialBalance({ to: e.today() }).balanced).toBe(true);
    const health = api.healthCheck();
    expect(health.checks.filter((c) => !c.ok)).toEqual([]);
    api.rebuildDerived();
    expect(api.healthCheck().ok).toBe(true);
    // the demo never oversells and looks like a healthy shop
    expect(e.db.get<{ n: number }>(`SELECT count(*) AS n FROM stock_levels WHERE qty_milli < 0`)!.n).toBe(0);
    const pnl = api.profitAndLoss({ from: '2000-01-01', to: e.today() });
    expect(pnl.netProfitPaise).toBeGreaterThan(0);
    expect(pnl.grossMarginBp).toBeGreaterThan(1500);
  });
});
