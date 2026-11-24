import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { divRound, formatINR, formatQty } from '../money';
import { Journal, methodAccount, reversalOf } from '../posting';
import { PAYMENT_METHODS } from '../seed';
import { gstinState, priceCart, type CartLineInput, type PricingContext } from '../tax';

export interface SaleLineInput {
  productId: string;
  qtyMilli: number;
  unitPricePaise?: number;
  discountPaise?: number;
}

export interface Tender {
  method: string;
  amountPaise: number;
}

export interface IssueSaleInput {
  lines: SaleLineInput[];
  billDiscountPaise?: number;
  partyId?: string | null;
  tenders: Tender[];
  date?: string;
  notes?: string;
  interState?: boolean;
  allowNegativeStock?: boolean;
  allowOverCreditLimit?: boolean;
}

export interface IssueSaleResult {
  docId: string;
  docNo: string;
  totalPaise: number;
  paidPaise: number;
  duePaise: number;
  changePaise: number;
  warnings: string[];
}

/** Pricing settings for a cart (shared by the POS preview and issueSale). */
export function pricingContext(business: Row, branch: Row, party: Row | null, opts: { interState?: boolean; billDiscountPaise?: number } = {}): PricingContext {
  const partyState = party?.state_code || gstinState(party?.gstin);
  const interState =
    opts.interState ?? Boolean(business.gst_scheme === 'regular' && partyState && branch.state_code && partyState !== branch.state_code);
  return {
    scheme: business.gst_scheme ?? 'none',
    priceMode: business.price_mode ?? 'inclusive',
    interState,
    roundOff: Boolean(business.round_off),
    billDiscountPaise: opts.billDiscountPaise ?? 0,
    buyerRegistered: Boolean(party?.gstin),
  };
}

export function cartLinesFor(e: ShopEngine, lines: SaleLineInput[]): { cart: CartLineInput[]; products: Map<string, Row> } {
  const products = new Map<string, Row>();
  const cart = lines.map((l) => {
    let p = products.get(l.productId);
    if (!p) {
      p = e.db.get(`SELECT * FROM products WHERE id = ? AND deleted = 0`, [l.productId]);
      if (!p) throw new ShopError('An item in the bill no longer exists', 'not_found');
      products.set(p.id, p);
    }
    if (!p.allow_decimal && l.qtyMilli % 1000 !== 0) throw new ShopError(`${p.name} is sold in whole ${p.unit}`);
    return {
      productId: p.id,
      name: p.name,
      hsn: p.hsn,
      unit: p.unit,
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise ?? p.price_paise ?? 0,
      discountPaise: l.discountPaise ?? 0,
      gstRateBp: p.gst_rate_bp ?? 0,
      cessRateBp: p.cess_rate_bp ?? 0,
    };
  });
  return { cart, products };
}

function salePriced(e: ShopEngine, input: Pick<IssueSaleInput, 'lines' | 'partyId' | 'billDiscountPaise' | 'interState'>) {
  const business = e.business();
  const branch = e.branch();
  const party = input.partyId ? e.db.get(`SELECT * FROM parties WHERE id = ? AND deleted = 0`, [input.partyId]) : null;
  if (input.partyId && !party) throw new ShopError('Customer not found', 'not_found');
  const { cart, products } = cartLinesFor(e, input.lines);
  const priced = priceCart(cart, pricingContext(business, branch, party ?? null, input));
  return { business, branch, party: party ?? null, priced, products };
}

/** Prices a cart without saving anything (used by the POS). */
export function previewSale(e: ShopEngine, input: Pick<IssueSaleInput, 'lines' | 'partyId' | 'billDiscountPaise' | 'interState'>) {
  return salePriced(e, input).priced;
}

export function issueSale(e: ShopEngine, input: IssueSaleInput): IssueSaleResult {
  return e.db.tx(() => {
    const date = input.date ?? e.today();
    e.assertOpen(date);
    const { branch, party, priced, products } = salePriced(e, input);
    const warnings: string[] = [];

    // --- tenders: UPI/card/bank first, then cash (cash may include change) ---
    for (const t of input.tenders) {
      if (!(PAYMENT_METHODS as readonly string[]).includes(t.method)) throw new ShopError(`Unknown payment method ${t.method}`);
      if (!Number.isInteger(t.amountPaise) || t.amountPaise < 0) throw new ShopError('Payment amounts must be positive');
    }
    let remaining = priced.totalPaise;
    const applied: { method: string; amount: number; tendered: number; change: number }[] = [];
    for (const t of input.tenders.filter((x) => x.method !== 'cash' && x.amountPaise > 0)) {
      if (t.amountPaise > remaining) throw new ShopError(`${t.method.toUpperCase()} amount is more than the bill`);
      applied.push({ method: t.method, amount: t.amountPaise, tendered: t.amountPaise, change: 0 });
      remaining -= t.amountPaise;
    }
    const cashTendered = input.tenders.filter((x) => x.method === 'cash').reduce((s, x) => s + x.amountPaise, 0);
    let change = 0;
    if (cashTendered > 0) {
      const cashApplied = Math.min(cashTendered, remaining);
      change = cashTendered - cashApplied;
      if (cashApplied > 0) applied.push({ method: 'cash', amount: cashApplied, tendered: cashTendered, change });
      remaining -= cashApplied;
    }
    const due = remaining;
    const paid = priced.totalPaise - due;
    if (due > 0 && !party) throw new ShopError('Choose a customer to sell on credit (khata)', 'needs_customer');
    if (due > 0 && party && party.credit_limit_paise > 0) {
      const bal = e.db.get<{ r: number }>(`SELECT receivable_paise AS r FROM party_balances WHERE party_id = ?`, [party.id])?.r ?? 0;
      if (bal + due > party.credit_limit_paise) {
        const msg = `${party.name} would owe ${formatINR(bal + due)}, over the limit of ${formatINR(party.credit_limit_paise)}`;
        if (!input.allowOverCreditLimit) throw new ShopError(msg, 'credit_limit');
        warnings.push(msg);
      }
    }

    // --- stock check ---
    const need = new Map<string, number>();
    for (const l of priced.lines) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qtyMilli);
    for (const [pid, qty] of need) {
      const p = products.get(pid)!;
      if (!p.track_stock) continue;
      const have = e.stockLevel(pid, branch.id).qty_milli;
      if (have < qty) {
        const msg = `Only ${formatQty(Math.max(0, have))} ${p.unit} of ${p.name} in stock`;
        if (branch.negative_stock === 'block' && !input.allowNegativeStock) throw new ShopError(msg, 'insufficient_stock');
        warnings.push(msg);
      }
    }

    // --- rows ---
    const { series, fy, seq, docNo } = e.nextDocNo('INV', date);
    const docId = uuidv7(e.now());
    const issued = new Map<string, number>();
    let costTotal = 0;
    const lines: Row[] = [];
    const movements: Row[] = [];
    priced.lines.forEach((l, i) => {
      const p = products.get(l.productId)!;
      let cost = 0;
      if (p.track_stock) {
        const before = issued.get(p.id) ?? 0;
        cost = e.issueCost(p.id, before + l.qtyMilli, branch.id) - (before ? e.issueCost(p.id, before, branch.id) : 0);
        issued.set(p.id, before + l.qtyMilli);
        movements.push({
          product_id: p.id, qty_delta_milli: -l.qtyMilli, value_paise: -cost, unit_cost_paise: divRound(cost * 1000, l.qtyMilli),
          reason: 'sale', source_type: 'sale', source_id: docId, business_date: date,
        });
      }
      costTotal += cost;
      lines.push({
        doc_id: docId, line_no: i + 1, product_id: p.id, name: l.name, hsn: l.hsn ?? null, unit: l.unit, qty_milli: l.qtyMilli,
        unit_price_paise: l.unitPricePaise, discount_paise: l.lineDiscountPaise + l.billDiscountPaise, taxable_paise: l.taxablePaise,
        gst_rate_bp: l.appliedRateBp, cgst_paise: l.cgstPaise, sgst_paise: l.sgstPaise, igst_paise: l.igstPaise, cess_paise: l.cessPaise,
        line_total_paise: l.lineTotalPaise, cost_paise: cost, original_line_id: null,
      });
    });
    const payments: Row[] = applied.map((a) => ({
      direction: 'in', party_id: party?.id ?? null, method: a.method, amount_paise: a.amount, tendered_paise: a.tendered,
      change_paise: a.change, business_date: date, ref_type: 'sale', ref_id: docId,
    }));

    // --- journal ---
    const j = new Journal(e, date, `Sale ${docNo}${party ? ` to ${party.name}` : ''}`, { type: 'sale', id: docId });
    for (const a of applied) j.dr(methodAccount(a.method), a.amount);
    if (due) j.dr('ar', due, { party: party!.id });
    j.cr('sales', priced.taxablePaise)
      .cr('output_cgst', priced.cgstPaise)
      .cr('output_sgst', priced.sgstPaise)
      .cr('output_igst', priced.igstPaise)
      .cr('output_cess', priced.cessPaise);
    if (priced.roundOffPaise > 0) j.cr('round_off', priced.roundOffPaise);
    else if (priced.roundOffPaise < 0) j.dr('round_off', -priced.roundOffPaise);
    if (costTotal) j.dr('cogs', costTotal).cr('inventory', costTotal);

    e.fact('sale.issued', 'sales_docs', docId, {
      sales_docs: [
        {
          id: docId, doc_type: priced.docType, series, fy, seq, doc_no: docNo, business_date: date,
          party_id: party?.id ?? null, party_name: party?.name ?? null, party_phone: party?.phone ?? null, party_gstin: party?.gstin ?? null,
          place_of_supply: party?.state_code || gstinState(party?.gstin) || branch.state_code, price_mode: e.business().price_mode,
          subtotal_paise: priced.subtotalPaise, discount_paise: priced.discountPaise, taxable_paise: priced.taxablePaise,
          cgst_paise: priced.cgstPaise, sgst_paise: priced.sgstPaise, igst_paise: priced.igstPaise, cess_paise: priced.cessPaise,
          round_off_paise: priced.roundOffPaise, total_paise: priced.totalPaise, paid_paise: paid, due_paise: due,
          cost_total_paise: costTotal, original_doc_id: null, notes: input.notes ?? null,
        },
      ],
      sales_lines: lines,
      stock_movements: movements,
      payments,
      ...j.build(),
    });
    return { docId, docNo, totalPaise: priced.totalPaise, paidPaise: paid, duePaise: due, changePaise: change, warnings };
  });
}

function isVoided(e: ShopEngine, docId: string) {
  return !!e.db.get(`SELECT 1 FROM doc_events WHERE doc_id = ? AND event = 'void'`, [docId]);
}

export interface ReturnInput {
  docId: string;
  lines: { lineId: string; qtyMilli: number }[];
  refund: 'cash' | 'upi' | 'card' | 'bank' | 'khata';
  restock?: boolean;
  reason?: string;
  date?: string;
}

/** Sale return → credit note. Refund in cash/UPI or reduce the customer's khata. */
export function returnSale(e: ShopEngine, input: ReturnInput) {
  return e.db.tx(() => {
    const orig = e.db.get(`SELECT * FROM sales_docs WHERE id = ?`, [input.docId]);
    if (!orig || orig.doc_type === 'credit_note') throw new ShopError('Bill not found', 'not_found');
    if (isVoided(e, orig.id)) throw new ShopError('This bill was voided');
    const date = input.date ?? e.today();
    e.assertOpen(date);
    if (input.refund === 'khata' && !orig.party_id) throw new ShopError('This bill has no customer, so it cannot be adjusted in khata');
    const restock = input.restock !== false;
    const origLines = e.db.all(`SELECT * FROM sales_lines WHERE doc_id = ?`, [orig.id]);
    const byId = new Map(origLines.map((l) => [l.id, l]));
    const cnId = uuidv7(e.now());
    const lines: Row[] = [];
    const movements: Row[] = [];
    const tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, cost: 0 };
    input.lines.filter((x) => x.qtyMilli > 0).forEach((x, i) => {
      const ol = byId.get(x.lineId);
      if (!ol) throw new ShopError('Line not found on this bill');
      const already = e.db.get<{ q: number }>(`SELECT coalesce(sum(qty_milli), 0) AS q FROM sales_lines WHERE original_line_id = ?`, [ol.id])!.q;
      if (x.qtyMilli > ol.qty_milli - already) throw new ShopError(`Only ${formatQty(ol.qty_milli - already)} of ${ol.name} can be returned`);
      const part = (v: number) => divRound(v * x.qtyMilli, ol.qty_milli);
      const r = { taxable: part(ol.taxable_paise), cgst: part(ol.cgst_paise), sgst: part(ol.sgst_paise), igst: part(ol.igst_paise), cess: part(ol.cess_paise) };
      const lineTotal = r.taxable + r.cgst + r.sgst + r.igst + r.cess;
      const cost = restock ? part(ol.cost_paise) : 0;
      tot.taxable += r.taxable; tot.cgst += r.cgst; tot.sgst += r.sgst; tot.igst += r.igst; tot.cess += r.cess; tot.total += lineTotal; tot.cost += cost;
      lines.push({
        doc_id: cnId, line_no: i + 1, product_id: ol.product_id, name: ol.name, hsn: ol.hsn, unit: ol.unit, qty_milli: x.qtyMilli,
        unit_price_paise: ol.unit_price_paise, discount_paise: part(ol.discount_paise), taxable_paise: r.taxable, gst_rate_bp: ol.gst_rate_bp,
        cgst_paise: r.cgst, sgst_paise: r.sgst, igst_paise: r.igst, cess_paise: r.cess, line_total_paise: lineTotal, cost_paise: cost, original_line_id: ol.id,
      });
      if (restock && ol.cost_paise !== null) {
        const tracked = e.db.get<{ t: number }>(`SELECT track_stock AS t FROM products WHERE id = ?`, [ol.product_id])?.t;
        if (tracked) {
          movements.push({
            product_id: ol.product_id, qty_delta_milli: x.qtyMilli, value_paise: cost, unit_cost_paise: divRound(cost * 1000, x.qtyMilli),
            reason: 'sale_return', source_type: 'credit_note', source_id: cnId, business_date: date,
          });
        }
      }
    });
    if (!lines.length) throw new ShopError('Choose the items being returned');
    const { series, fy, seq, docNo } = e.nextDocNo('CN', date);
    const j = new Journal(e, date, `Credit note ${docNo} against ${orig.doc_no}`, { type: 'credit_note', id: cnId });
    j.dr('sales_returns', tot.taxable).dr('output_cgst', tot.cgst).dr('output_sgst', tot.sgst).dr('output_igst', tot.igst).dr('output_cess', tot.cess);
    if (input.refund === 'khata') j.cr('ar', tot.total, { party: orig.party_id });
    else j.cr(methodAccount(input.refund), tot.total);
    if (tot.cost) j.dr('inventory', tot.cost).cr('cogs', tot.cost);
    const payments =
      input.refund === 'khata'
        ? []
        : [{ direction: 'out', party_id: orig.party_id, method: input.refund, amount_paise: tot.total, business_date: date, ref_type: 'credit_note', ref_id: cnId }];
    e.fact('sale.returned', 'sales_docs', cnId, {
      sales_docs: [
        {
          id: cnId, doc_type: 'credit_note', series, fy, seq, doc_no: docNo, business_date: date, party_id: orig.party_id,
          party_name: orig.party_name, party_phone: orig.party_phone, party_gstin: orig.party_gstin, place_of_supply: orig.place_of_supply,
          price_mode: orig.price_mode, subtotal_paise: tot.total, discount_paise: 0, taxable_paise: tot.taxable, cgst_paise: tot.cgst,
          sgst_paise: tot.sgst, igst_paise: tot.igst, cess_paise: tot.cess, round_off_paise: 0, total_paise: tot.total,
          paid_paise: input.refund === 'khata' ? 0 : tot.total, due_paise: 0, cost_total_paise: tot.cost, original_doc_id: orig.id,
          notes: input.reason ?? null,
        },
      ],
      sales_lines: lines,
      stock_movements: movements,
      payments,
      ...j.build(),
    });
    return { creditNoteId: cnId, docNo, totalPaise: tot.total };
  });
}

/** Cancels a bill: reversing journal, stock back, refund recorded. The number stays used. */
export function voidSale(e: ShopEngine, docId: string, reason: string) {
  return e.db.tx(() => {
    const doc = e.db.get(`SELECT * FROM sales_docs WHERE id = ?`, [docId]);
    if (!doc || doc.doc_type === 'credit_note') throw new ShopError('Bill not found', 'not_found');
    if (isVoided(e, docId)) throw new ShopError('This bill is already voided');
    if (e.db.get(`SELECT 1 FROM sales_docs WHERE original_doc_id = ?`, [docId])) throw new ShopError('This bill has returns; return the remaining items instead');
    if (!reason?.trim()) throw new ShopError('Give a reason for voiding');
    const lock = e.business().lock_date as string | null;
    const date = lock && doc.business_date <= lock ? e.today() : doc.business_date;
    e.assertOpen(date);
    const eventId = uuidv7(e.now());
    const entry = e.db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE source_id = ? AND source_type = 'sale'`, [docId]);
    const tables: Row = { doc_events: [{ id: eventId, doc_kind: 'sale', doc_id: docId, event: 'void', reason: reason.trim(), business_date: date }] };
    if (entry) Object.assign(tables, reversalOf(e, entry.id, date, `Void ${doc.doc_no}: ${reason.trim()}`, { type: 'void', id: eventId }).build());
    tables.stock_movements = e.db
      .all(`SELECT * FROM stock_movements WHERE source_id = ?`, [docId])
      .map((m) => ({
        product_id: m.product_id, branch_id: m.branch_id, qty_delta_milli: -m.qty_delta_milli, value_paise: -m.value_paise,
        unit_cost_paise: m.unit_cost_paise, reason: 'void', source_type: 'void', source_id: eventId, business_date: date,
      }));
    tables.payments = e.db
      .all(`SELECT * FROM payments WHERE ref_id = ? AND direction = 'in'`, [docId])
      .map((p) => ({ direction: 'out', party_id: p.party_id, method: p.method, amount_paise: p.amount_paise, business_date: date, ref_type: 'void', ref_id: docId }));
    e.fact('sale.voided', 'sales_docs', docId, tables, doc.branch_id);
    return { eventId };
  });
}

// ---------- held bills (device-local, never synced) ----------

export function holdBill(e: ShopEngine, label: string, cart: unknown) {
  const id = uuidv7(e.now());
  e.db.run(`INSERT INTO held_bills (id, label, cart, created_at) VALUES (?,?,?,?)`, [id, label || 'Held bill', JSON.stringify(cart), e.now()]);
  return id;
}

export function listHeldBills(e: ShopEngine) {
  return e.db.all(`SELECT * FROM held_bills ORDER BY created_at DESC`).map((r): Row => ({ ...r, cart: JSON.parse(r.cart) }));
}

export function deleteHeldBill(e: ShopEngine, id: string) {
  e.db.run(`DELETE FROM held_bills WHERE id = ?`, [id]);
}
