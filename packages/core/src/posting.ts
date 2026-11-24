import type { Row } from './db';
import { ShopError, type ShopEngine } from './engine';
import { uuidv7 } from './ids';

interface Leg {
  account_id: string;
  party_id: string | null;
  branch_id: string | null;
  debit: number;
  credit: number;
}

/**
 * Builds one balanced journal entry. Accounts are given by system key
 * ("cash", "ar", …) or as `{ id }`. Zero legs are dropped; legs on the same
 * account/party/branch are merged.
 */
export class Journal {
  private legs: Leg[] = [];
  readonly entryId: string;

  constructor(
    private readonly e: ShopEngine,
    readonly date: string,
    readonly narration: string,
    readonly source: { type: string; id: string },
    readonly reversesId: string | null = null,
  ) {
    this.entryId = uuidv7(e.now());
  }

  private account(a: string | { id: string }): string {
    return typeof a === 'string' ? this.e.acct(a) : a.id;
  }

  dr(account: string | { id: string }, amount: number, opts: { party?: string | null; branch?: string | null } = {}) {
    return this.add(account, amount, 0, opts);
  }

  cr(account: string | { id: string }, amount: number, opts: { party?: string | null; branch?: string | null } = {}) {
    return this.add(account, 0, amount, opts);
  }

  /** Debit when amount > 0, credit when amount < 0. */
  signed(account: string | { id: string }, amount: number, opts: { party?: string | null; branch?: string | null } = {}) {
    return amount >= 0 ? this.dr(account, amount, opts) : this.cr(account, -amount, opts);
  }

  private add(account: string | { id: string }, debit: number, credit: number, opts: { party?: string | null; branch?: string | null }): Journal {
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) throw new ShopError('Journal amounts must be whole paise', 'bad_journal');
    if (debit < 0 || credit < 0) {
      return this.add(account, Math.max(0, -credit), Math.max(0, -debit), opts);
    }
    if (debit === 0 && credit === 0) return this;
    this.legs.push({ account_id: this.account(account), party_id: opts.party ?? null, branch_id: opts.branch ?? null, debit, credit });
    return this;
  }

  /** Rows for journal_entries and journal_lines. Throws if unbalanced. */
  build(): { journal_entries: Row[]; journal_lines: Row[] } {
    const merged = new Map<string, Leg>();
    for (const l of this.legs) {
      const k = `${l.account_id}|${l.party_id ?? ''}|${l.branch_id ?? ''}`;
      const m = merged.get(k);
      if (m) {
        m.debit += l.debit;
        m.credit += l.credit;
      } else merged.set(k, { ...l });
    }
    const lines: Row[] = [];
    let dr = 0;
    let cr = 0;
    for (const l of merged.values()) {
      const net = l.debit - l.credit;
      if (net === 0) continue;
      const debit = net > 0 ? net : 0;
      const credit = net < 0 ? -net : 0;
      dr += debit;
      cr += credit;
      lines.push({
        id: uuidv7(this.e.now()),
        entry_id: this.entryId,
        business_date: this.date,
        account_id: l.account_id,
        party_id: l.party_id,
        debit_paise: debit,
        credit_paise: credit,
        ...(l.branch_id ? { branch_id: l.branch_id } : {}),
      });
    }
    if (dr !== cr) throw new ShopError(`Unbalanced journal: debit ${dr} ≠ credit ${cr}`, 'unbalanced');
    if (lines.length === 0) return { journal_entries: [], journal_lines: [] };
    return {
      journal_entries: [
        {
          id: this.entryId,
          business_date: this.date,
          source_type: this.source.type,
          source_id: this.source.id,
          narration: this.narration,
          reverses_id: this.reversesId,
        },
      ],
      journal_lines: lines,
    };
  }
}

/** A journal that swaps every debit and credit of an existing entry. */
export function reversalOf(e: ShopEngine, entryId: string, date: string, narration: string, source: { type: string; id: string }) {
  const lines = e.db.all(`SELECT * FROM journal_lines WHERE entry_id = ?`, [entryId]);
  const j = new Journal(e, date, narration, source, entryId);
  for (const l of lines) {
    if (l.debit_paise) j.cr({ id: l.account_id }, l.debit_paise, { party: l.party_id, branch: l.branch_id });
    if (l.credit_paise) j.dr({ id: l.account_id }, l.credit_paise, { party: l.party_id, branch: l.branch_id });
  }
  return j;
}

/** Ledger account for a payment method. */
export function methodAccount(method: string): string {
  return method === 'cash' ? 'cash' : 'bank';
}
