import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { Journal, methodAccount } from '../posting';
import { PAYMENT_METHODS } from '../seed';
import { gstinState, isValidGstin } from '../tax';

const PARTY_FIELDS = ['kind', 'name', 'phone', 'email', 'gstin', 'state_code', 'address', 'notes', 'tags', 'credit_limit_paise', 'credit_days', 'deleted'];

function pick(src: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

export function normalisePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
}

function cleanParty(e: ShopEngine, row: Row, id?: string): Row {
  if (row.name !== undefined && !String(row.name).trim()) throw new ShopError('Enter the name');
  if (row.name) row.name = String(row.name).trim();
  if (row.phone !== undefined) row.phone = normalisePhone(row.phone);
  if (row.gstin) {
    row.gstin = String(row.gstin).trim().toUpperCase();
    if (!isValidGstin(row.gstin)) throw new ShopError('Enter a valid 15-character GSTIN');
    row.state_code ??= gstinState(row.gstin);
  } else if (row.gstin === '') row.gstin = null;
  if (row.phone) {
    const dup = e.db.get<{ name: string }>(
      `SELECT name FROM parties WHERE phone = ? AND deleted = 0 AND merged_into_id IS NULL AND id <> ? AND kind = ?`,
      [row.phone, id ?? '', row.kind ?? 'customer'],
    );
    if (dup) throw new ShopError(`${dup.name} already has this phone number`, 'duplicate_phone');
  }
  return row;
}

export function createParty(e: ShopEngine, input: Row & { opening_balance_paise?: number }): string {
  const kind = input.kind ?? 'customer';
  if (!['customer', 'supplier', 'both'].includes(kind)) throw new ShopError('Invalid party type');
  const row = cleanParty(e, { ...pick(input, PARTY_FIELDS), kind });
  row.credit_limit_paise ??= 0;
  row.credit_days ??= 0;
  const id = uuidv7(e.now());
  e.db.tx(() => {
    e.patch('parties', id, { business_id: e.business().id, ...row }, { create: true });
    const opening = input.opening_balance_paise ?? 0;
    if (opening) setOpeningBalance(e, id, opening);
  });
  return id;
}

export function updateParty(e: ShopEngine, id: string, set: Row) {
  const current = e.db.get(`SELECT * FROM parties WHERE id = ?`, [id]);
  if (!current) throw new ShopError('Not found', 'not_found');
  const row = cleanParty(e, { kind: current.kind, ...pick(set, PARTY_FIELDS) }, id);
  e.patch('parties', id, row);
}

/** Old dues brought over from a paper khata (customer owes us, or we owe the supplier). */
export function setOpeningBalance(e: ShopEngine, partyId: string, amountPaise: number, date?: string) {
  const party = e.db.get(`SELECT * FROM parties WHERE id = ?`, [partyId]);
  if (!party) throw new ShopError('Not found', 'not_found');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new ShopError('Opening balance must be more than zero');
  const d = date ?? e.today();
  e.assertOpen(d);
  const id = uuidv7(e.now());
  const j = new Journal(e, d, `Opening balance: ${party.name}`, { type: 'opening_balance', id });
  if (party.kind === 'supplier') j.dr('opening', amountPaise).cr('ap', amountPaise, { party: partyId });
  else j.dr('ar', amountPaise, { party: partyId }).cr('opening', amountPaise);
  return e.fact('party.opening_balance', 'journal_entries', j.entryId, j.build());
}

function party(e: ShopEngine, id: string): Row {
  const p = e.db.get(`SELECT * FROM parties WHERE id = ? AND deleted = 0`, [id]);
  if (!p) throw new ShopError('Customer or supplier not found', 'not_found');
  return p;
}

function checkPayment(amountPaise: number, method: string) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new ShopError('Enter the amount');
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) throw new ShopError('Choose how it was paid');
}

/** Customer pays towards their khata. */
export function receivePayment(e: ShopEngine, input: { partyId: string; amountPaise: number; method: string; date?: string; reference?: string; note?: string }) {
  const p = party(e, input.partyId);
  checkPayment(input.amountPaise, input.method);
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const id = uuidv7(e.now());
    const j = new Journal(e, date, `Payment received from ${p.name}`, { type: 'receipt', id });
    j.dr(methodAccount(input.method), input.amountPaise).cr('ar', input.amountPaise, { party: p.id });
    e.fact('payment.received', 'payments', id, {
      payments: [{ id, direction: 'in', party_id: p.id, method: input.method, amount_paise: input.amountPaise, business_date: date, ref_type: 'khata', ref_id: p.id, reference: input.reference ?? null, note: input.note ?? null }],
      ...j.build(),
    });
    return id;
  });
}

/** We pay a supplier. */
export function paySupplier(e: ShopEngine, input: { partyId: string; amountPaise: number; method: string; date?: string; reference?: string; note?: string }) {
  const p = party(e, input.partyId);
  checkPayment(input.amountPaise, input.method);
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const id = uuidv7(e.now());
    const j = new Journal(e, date, `Payment to ${p.name}`, { type: 'supplier_payment', id });
    j.dr('ap', input.amountPaise, { party: p.id }).cr(methodAccount(input.method), input.amountPaise);
    e.fact('payment.made', 'payments', id, {
      payments: [{ id, direction: 'out', party_id: p.id, method: input.method, amount_paise: input.amountPaise, business_date: date, ref_type: 'supplier', ref_id: p.id, reference: input.reference ?? null, note: input.note ?? null }],
      ...j.build(),
    });
    return id;
  });
}
