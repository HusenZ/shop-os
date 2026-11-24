import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { divRound, lineAmount } from '../money';
import { Journal, methodAccount } from '../posting';
import { PAYMENT_METHODS } from '../seed';
import { gstinState } from '../tax';

export interface PurchaseInput {
  partyId: string;
  supplierBillNo?: string;
  date?: string;
  lines: { productId: string; qtyMilli: number; unitCostPaise: number; gstRateBp?: number }[];
  paid?: { method: string; amountPaise: number } | null;
  interState?: boolean;
  notes?: string;
}

/**
 * Purchase bill: stock in at cost, input tax credit for a regular GST shop
 * buying from a registered supplier, the rest owed to the supplier.
 */
export function recordPurchase(e: ShopEngine, input: PurchaseInput) {
  return e.db.tx(() => {
    const business = e.business();
    const branch = e.branch();
    const party = e.db.get(`SELECT * FROM parties WHERE id = ? AND deleted = 0`, [input.partyId]);
    if (!party) throw new ShopError('Choose the supplier');
    if (!input.lines.length) throw new ShopError('Add the items you bought');
    const date = input.date ?? e.today();
    e.assertOpen(date);
    const supplierRegistered = Boolean(party.gstin);
    const itc = business.gst_scheme === 'regular' && supplierRegistered;
    const supplierState = party.state_code || gstinState(party.gstin);
    const interState = input.interState ?? Boolean(supplierState && branch.state_code && supplierState !== branch.state_code);

    const docId = uuidv7(e.now());
    const lines: Row[] = [];
    const movements: Row[] = [];
    const tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, inventory: 0 };
    input.lines.forEach((l, i) => {
      const p = e.db.get(`SELECT * FROM products WHERE id = ?`, [l.productId]);
      if (!p) throw new ShopError('An item no longer exists');
      if (!Number.isInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new ShopError(`Quantity for ${p.name} must be more than zero`);
      if (!Number.isInteger(l.unitCostPaise) || l.unitCostPaise < 0) throw new ShopError(`Cost for ${p.name} is invalid`);
      const rate = supplierRegistered ? (l.gstRateBp ?? p.gst_rate_bp ?? 0) : 0;
      const taxable = lineAmount(l.unitCostPaise, l.qtyMilli);
      let cgst = 0, sgst = 0, igst = 0;
      if (rate) {
        if (interState) igst = divRound(taxable * rate, 10000);
        else cgst = sgst = divRound(taxable * rate, 20000);
      }
      const cess = supplierRegistered ? divRound(taxable * (p.cess_rate_bp ?? 0), 10000) : 0;
      const lineTotal = taxable + cgst + sgst + igst + cess;
      const invValue = itc ? taxable : lineTotal;
      tot.taxable += taxable; tot.cgst += cgst; tot.sgst += sgst; tot.igst += igst; tot.cess += cess; tot.total += lineTotal; tot.inventory += invValue;
      lines.push({
        doc_id: docId, line_no: i + 1, product_id: p.id, name: p.name, hsn: p.hsn, unit: p.unit, qty_milli: l.qtyMilli,
        unit_cost_paise: l.unitCostPaise, taxable_paise: taxable, gst_rate_bp: rate, cgst_paise: cgst, sgst_paise: sgst,
        igst_paise: igst, cess_paise: cess, line_total_paise: lineTotal, inventory_value_paise: invValue,
      });
      if (p.track_stock) {
        movements.push({
          product_id: p.id, qty_delta_milli: l.qtyMilli, value_paise: invValue, unit_cost_paise: divRound(invValue * 1000, l.qtyMilli),
          reason: 'purchase', source_type: 'purchase', source_id: docId, business_date: date,
        });
      }
    });
    const paid = input.paid?.amountPaise ?? 0;
    if (paid < 0 || paid > tot.total) throw new ShopError('Paid amount cannot be more than the bill');
    if (paid && !(PAYMENT_METHODS as readonly string[]).includes(input.paid!.method)) throw new ShopError('Choose how it was paid');
    const due = tot.total - paid;

    const j = new Journal(e, date, `Purchase from ${party.name}${input.supplierBillNo ? ` (bill ${input.supplierBillNo})` : ''}`, { type: 'purchase', id: docId });
    // Non-stock lines (services, consumables) go to inventory too unless tracked=0; keep it simple: expense via Shop supplies
    const stockValue = movements.reduce((s, m) => s + m.value_paise, 0);
    const nonStock = tot.inventory - stockValue;
    j.dr('inventory', stockValue);
    if (nonStock) j.dr({ id: shopSuppliesAccount(e) }, nonStock);
    if (itc) j.dr('input_cgst', tot.cgst).dr('input_sgst', tot.sgst).dr('input_igst', tot.igst).dr('input_cess', tot.cess);
    if (paid) j.cr(methodAccount(input.paid!.method), paid);
    if (due) j.cr('ap', due, { party: party.id });

    const payments = paid
      ? [{ direction: 'out', party_id: party.id, method: input.paid!.method, amount_paise: paid, business_date: date, ref_type: 'purchase', ref_id: docId }]
      : [];
    e.fact('purchase.recorded', 'purchase_docs', docId, {
      purchase_docs: [
        {
          id: docId, doc_type: 'purchase_bill', supplier_bill_no: input.supplierBillNo ?? null, business_date: date, party_id: party.id,
          party_name: party.name, itc_eligible: itc ? 1 : 0, taxable_paise: tot.taxable, cgst_paise: tot.cgst, sgst_paise: tot.sgst,
          igst_paise: tot.igst, cess_paise: tot.cess, total_paise: tot.total, paid_paise: paid, due_paise: due, original_doc_id: null,
          notes: input.notes ?? null,
        },
      ],
      purchase_lines: lines,
      stock_movements: movements,
      payments,
      ...j.build(),
    });
    return { docId, totalPaise: tot.total, duePaise: due };
  });
}

function shopSuppliesAccount(e: ShopEngine): string {
  const a = e.db.get<{ id: string }>(`SELECT id FROM accounts WHERE code = '6080'`);
  if (!a) throw new ShopError('Missing Shop supplies account');
  return a.id;
}
