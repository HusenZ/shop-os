import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { Journal, methodAccount } from '../posting';
import { PAYMENT_METHODS } from '../seed';

export function recordExpense(e: ShopEngine, input: { accountId: string; amountPaise: number; method: string; date?: string; payee?: string; note?: string }) {
  const acc = e.db.get(`SELECT * FROM accounts WHERE id = ? AND deleted = 0`, [input.accountId]);
  if (!acc || acc.type !== 'expense') throw new ShopError('Choose an expense type');
  if (['cogs', 'stock_loss', 'cash_diff', 'round_off'].includes(acc.system_key)) throw new ShopError('That account is posted automatically');
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new ShopError('Enter the amount');
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new ShopError('Choose how it was paid');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const id = uuidv7(e.now());
    const j = new Journal(e, date, `${acc.name}${input.payee ? ` – ${input.payee}` : ''}`, { type: 'expense', id });
    j.dr({ id: acc.id }, input.amountPaise).cr(methodAccount(input.method), input.amountPaise);
    e.fact('expense.recorded', 'expenses', id, {
      expenses: [{ id, business_date: date, account_id: acc.id, method: input.method, amount_paise: input.amountPaise, payee: input.payee ?? null, note: input.note ?? null }],
      payments: [{ direction: 'out', party_id: null, method: input.method, amount_paise: input.amountPaise, business_date: date, ref_type: 'expense', ref_id: id }],
      ...j.build(),
    });
    return id;
  });
}

export function createExpenseAccount(e: ShopEngine, name: string): string {
  if (!name?.trim()) throw new ShopError('Enter a name');
  const max = e.db.get<{ c: string | null }>(`SELECT max(code) AS c FROM accounts WHERE code >= '6000' AND code < '7000'`)?.c ?? '6000';
  const id = uuidv7(e.now());
  e.patch('accounts', id, { business_id: e.business().id, code: String(Number(max) + 1), name: name.trim(), type: 'expense', system_key: null, is_system: 0 }, { create: true });
  return id;
}

export type MoneyMovementKind = 'capital_in' | 'drawings' | 'bank_deposit' | 'bank_withdrawal';

/** Owner capital, drawings and cash ↔ bank moves. */
export function recordMoneyMovement(e: ShopEngine, input: { kind: MoneyMovementKind; amountPaise: number; method?: string; date?: string; note?: string }) {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new ShopError('Enter the amount');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  const via = methodAccount(input.method ?? 'cash');
  const labels: Record<MoneyMovementKind, string> = {
    capital_in: 'Owner added money',
    drawings: 'Owner took money',
    bank_deposit: 'Cash deposited in bank',
    bank_withdrawal: 'Cash withdrawn from bank',
  };
  if (!labels[input.kind]) throw new ShopError('Choose the type');
  return e.db.tx(() => {
    const id = uuidv7(e.now());
    const j = new Journal(e, date, `${labels[input.kind]}${input.note ? ` – ${input.note}` : ''}`, { type: 'money', id });
    if (input.kind === 'capital_in') j.dr(via, input.amountPaise).cr('capital', input.amountPaise);
    if (input.kind === 'drawings') j.dr('drawings', input.amountPaise).cr(via, input.amountPaise);
    if (input.kind === 'bank_deposit') j.dr('bank', input.amountPaise).cr('cash', input.amountPaise);
    if (input.kind === 'bank_withdrawal') j.dr('cash', input.amountPaise).cr('bank', input.amountPaise);
    e.fact(`money.${input.kind}`, 'journal_entries', j.entryId, j.build());
    return j.entryId;
  });
}

export function cashBalance(e: ShopEngine, branchId?: string, upTo?: string): number {
  const r = e.db.get<{ b: number }>(
    `SELECT coalesce(sum(debit_paise - credit_paise), 0) AS b FROM account_daily WHERE account_id = ? AND branch_id = ? AND business_date <= ?`,
    [e.acct('cash'), branchId ?? e.requireBranchId(), upTo ?? '9999-12-31'],
  );
  return r?.b ?? 0;
}

/** End-of-day cash count. The difference is posted to Cash short / excess. */
export function closeDay(e: ShopEngine, input: { countedPaise: number; denominations?: Row; note?: string; date?: string }) {
  if (!Number.isInteger(input.countedPaise) || input.countedPaise < 0) throw new ShopError('Enter the cash counted');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const expected = cashBalance(e, undefined, date);
    const diff = input.countedPaise - expected;
    const id = uuidv7(e.now());
    const tables: Row = {
      cash_sessions: [{ id, business_date: date, expected_paise: expected, counted_paise: input.countedPaise, difference_paise: diff, denominations: JSON.stringify(input.denominations ?? {}), note: input.note ?? null }],
    };
    if (diff) {
      const j = new Journal(e, date, diff > 0 ? 'Cash excess at day close' : 'Cash short at day close', { type: 'day_close', id });
      if (diff > 0) j.dr('cash', diff).cr('cash_diff', diff);
      else j.dr('cash_diff', -diff).cr('cash', -diff);
      Object.assign(tables, j.build());
    }
    e.fact('day.closed', 'cash_sessions', id, tables);
    return { id, expectedPaise: expected, countedPaise: input.countedPaise, differencePaise: diff };
  });
}

/** Locks the books up to and including `date`. */
export function lockBooks(e: ShopEngine, date: string | null) {
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ShopError('Choose a date');
  if (date && date >= e.today()) throw new ShopError('You can only lock past dates');
  e.patch('businesses', e.business().id, { lock_date: date }, { type: date ? 'books.locked' : 'books.unlocked' });
}
