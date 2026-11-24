import type { ShopEngine } from './engine';

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Recomputes every derived table from the facts (in HLC order). */
export function rebuildDerived(e: ShopEngine) {
  e.db.tx(() => {
    e.db.run(`DELETE FROM stock_levels`);
    e.db.run(`DELETE FROM account_daily`);
    e.db.run(`DELETE FROM party_balances`);
    e.invalidateAccounts();
    e.project({
      stock_movements: e.db.all(`SELECT * FROM stock_movements ORDER BY hlc, id`),
      journal_lines: e.db.all(`SELECT * FROM journal_lines ORDER BY hlc, id`),
    });
  });
}

function compare(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) diffs.push(`${k}: ${v} vs ${b.get(k) ?? 'missing'}`);
  for (const [k, v] of b) if (!a.has(k)) diffs.push(`${k}: missing vs ${v}`);
  return diffs;
}

/** Integrity checks over the books, stock and the op chain. */
export function healthCheck(e: ShopEngine): { ok: boolean; checks: HealthCheck[] } {
  const checks: HealthCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const unbalanced = e.db.all(
    `SELECT entry_id, sum(debit_paise) - sum(credit_paise) AS diff FROM journal_lines GROUP BY entry_id HAVING diff <> 0 LIMIT 5`,
  );
  add('Every journal entry balances', unbalanced.length === 0, unbalanced.length ? `${unbalanced.length} unbalanced entries` : 'All entries balance');

  const totals = e.db.get<{ dr: number; cr: number }>(`SELECT coalesce(sum(debit_paise), 0) AS dr, coalesce(sum(credit_paise), 0) AS cr FROM journal_lines`)!;
  add('Trial balance tallies', totals.dr === totals.cr, `Debits ${totals.dr} · credits ${totals.cr}`);

  const stockFresh = new Map(
    e.db
      .all(`SELECT branch_id, product_id, sum(qty_delta_milli) AS q, sum(value_paise) AS v FROM stock_movements GROUP BY branch_id, product_id`)
      .filter((r) => r.q !== 0 || r.v !== 0)
      .map((r) => [`${r.branch_id}|${r.product_id}`, `${r.q}/${r.v}`]),
  );
  const stockCached = new Map(
    e.db
      .all(`SELECT branch_id, product_id, qty_milli AS q, value_paise AS v FROM stock_levels`)
      .filter((r) => r.q !== 0 || r.v !== 0)
      .map((r) => [`${r.branch_id}|${r.product_id}`, `${r.q}/${r.v}`]),
  );
  const sd = compare(stockFresh, stockCached);
  add('Stock levels match the stock ledger', sd.length === 0, sd.length ? sd.slice(0, 3).join('; ') : `${stockFresh.size} item balances checked`);

  const accFresh = new Map(
    e.db
      .all(`SELECT account_id, coalesce(branch_id, '') AS b, business_date AS d, sum(debit_paise) AS dr, sum(credit_paise) AS cr FROM journal_lines GROUP BY account_id, b, d`)
      .map((r) => [`${r.account_id}|${r.b}|${r.d}`, `${r.dr}/${r.cr}`]),
  );
  const accCached = new Map(
    e.db
      .all(`SELECT account_id, branch_id AS b, business_date AS d, debit_paise AS dr, credit_paise AS cr FROM account_daily`)
      .filter((r) => r.dr !== 0 || r.cr !== 0)
      .map((r) => [`${r.account_id}|${r.b}|${r.d}`, `${r.dr}/${r.cr}`]),
  );
  const ad = compare(accFresh, accCached);
  add('Daily account totals match the journal', ad.length === 0, ad.length ? ad.slice(0, 3).join('; ') : `${accFresh.size} day totals checked`);

  let ar = '';
  let ap = '';
  try {
    ar = e.acct('ar');
    ap = e.acct('ap');
  } catch {
    /* not set up */
  }
  if (ar) {
    const partyFresh = new Map(
      e.db
        .all(
          `SELECT party_id, sum(CASE WHEN account_id = ? THEN debit_paise - credit_paise ELSE 0 END) AS r,
                  sum(CASE WHEN account_id = ? THEN credit_paise - debit_paise ELSE 0 END) AS p
           FROM journal_lines WHERE party_id IS NOT NULL AND account_id IN (?, ?) GROUP BY party_id`,
          [ar, ap, ar, ap],
        )
        .filter((r) => r.r !== 0 || r.p !== 0)
        .map((r) => [r.party_id, `${r.r}/${r.p}`]),
    );
    const partyCached = new Map(
      e.db
        .all(`SELECT party_id, receivable_paise AS r, payable_paise AS p FROM party_balances`)
        .filter((r) => r.r !== 0 || r.p !== 0)
        .map((r) => [r.party_id, `${r.r}/${r.p}`]),
    );
    const pd = compare(partyFresh, partyCached);
    add('Khata balances match the ledger', pd.length === 0, pd.length ? pd.slice(0, 3).join('; ') : `${partyFresh.size} party balances checked`);

    const orphan = e.db.get<{ n: number }>(`SELECT count(*) AS n FROM journal_lines WHERE account_id IN (?, ?) AND party_id IS NULL`, [ar, ap])!.n;
    add('Receivable/payable control = sum of party ledgers', orphan === 0, orphan ? `${orphan} lines without a party` : 'Control accounts reconcile');

    const inv = e.acct('inventory');
    const invRows = e.db.all(
      `SELECT b.id, b.name,
              (SELECT coalesce(sum(debit_paise - credit_paise), 0) FROM journal_lines WHERE account_id = ? AND branch_id = b.id) AS books,
              (SELECT coalesce(sum(value_paise), 0) FROM stock_movements WHERE branch_id = b.id) AS stock
       FROM branches b`,
      [inv],
    );
    const bad = invRows.filter((r) => r.books !== r.stock);
    add(
      'Inventory account = stock valuation',
      bad.length === 0,
      bad.length ? bad.map((r) => `${r.name}: books ${r.books}, stock ${r.stock}`).join('; ') : `${invRows.length} branch(es) reconcile`,
    );
  }

  const chain = e.db.all<{ prev_hash: string | null; hash: string }>(`SELECT prev_hash, hash FROM ops WHERE origin = 'local' ORDER BY hlc`);
  let prev: string | null = null;
  let breaks = 0;
  for (const o of chain) {
    if (o.prev_hash !== prev) breaks++;
    prev = o.hash;
  }
  add('Audit log hash chain is intact', breaks === 0, breaks ? `${breaks} break(s) in this device's chain` : `${chain.length} local ops verified`);

  return { ok: checks.every((c) => c.ok), checks };
}
