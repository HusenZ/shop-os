import { addDays } from '@shopos/core';
import { CheckCircle2, Lock, Unlock, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Loading, PageHeader, Select, Table, Tabs } from '../components/ui';
import { fmtDate, inr, periodRange, today, type PeriodKey } from '../lib/format';
import { useAct, useQ, useSession } from '../lib/hooks';
import { BranchPicker, PeriodPicker } from './Reports';

export default function Books() {
  const [tab, setTab] = useState<'tb' | 'bs' | 'daybook' | 'ledger' | 'lock' | 'coa'>('tb');
  const [period, setPeriod] = useState({ key: 'month' as PeriodKey, ...periodRange('month') });
  const [branch, setBranch] = useState('');
  return (
    <div>
      <PageHeader
        title="Books"
        sub="Double-entry accounts — for you and your accountant"
        actions={
          <>
            <BranchPicker value={branch} onChange={setBranch} />
            {tab === 'daybook' || tab === 'ledger' ? <PeriodPicker value={period} onChange={setPeriod} /> : null}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'tb', label: 'Trial balance' },
          { id: 'bs', label: 'Balance sheet' },
          { id: 'daybook', label: 'Day book' },
          { id: 'ledger', label: 'Ledger' },
          { id: 'lock', label: 'Lock period' },
          { id: 'coa', label: 'Chart of accounts' },
        ]}
      />
      {tab === 'tb' && <TrialBalance branchId={branch || null} />}
      {tab === 'bs' && <BalanceSheet branchId={branch || null} />}
      {tab === 'daybook' && <DayBook from={period.from} to={period.to} branchId={branch || null} />}
      {tab === 'ledger' && <Ledger from={period.from} to={period.to} branchId={branch || null} />}
      {tab === 'lock' && <LockPeriod />}
      {tab === 'coa' && <Chart />}
    </div>
  );
}

function Balanced({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge tone="green">
      <CheckCircle2 className="size-3.5" /> Balanced
    </Badge>
  ) : (
    <Badge tone="red">
      <XCircle className="size-3.5" /> Not balanced
    </Badge>
  );
}

function TrialBalance({ branchId }: { branchId: string | null }) {
  const [asOf, setAsOf] = useState(today());
  const { data } = useQ('trialBalance', [{ to: asOf, branchId }]);
  if (!data) return <Loading />;
  const dr = data.accounts.reduce((t, a) => t + a.balanceDebitPaise, 0);
  const cr = data.accounts.reduce((t, a) => t + a.balanceCreditPaise, 0);
  return (
    <Card>
      <CardTitle action={<Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-auto" aria-label="As of" />} sub={`As of ${fmtDate(asOf)}`}>
        Trial balance <Balanced ok={data.balanced && dr === cr} />
      </CardTitle>
      <Table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Account</th>
            <th>Type</th>
            <th className="text-right!">Debit</th>
            <th className="text-right!">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.accountId}>
              <td className="font-mono text-xs text-stone-500">{a.code}</td>
              <td>{a.name}</td>
              <td className="text-stone-500 capitalize">{a.type}</td>
              <td className="text-right tabular-nums">{a.balanceDebitPaise ? inr(a.balanceDebitPaise) : ''}</td>
              <td className="text-right tabular-nums">{a.balanceCreditPaise ? inr(a.balanceCreditPaise) : ''}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td />
            <td>Total</td>
            <td />
            <td className="text-right tabular-nums">{inr(dr)}</td>
            <td className="text-right tabular-nums">{inr(cr)}</td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

function BalanceSheet({ branchId }: { branchId: string | null }) {
  const [asOf, setAsOf] = useState(today());
  const { data } = useQ('balanceSheet', [{ asOf, branchId }]);
  if (!data) return <Loading />;
  const Section = ({ title, rows, total, extra }: { title: string; rows: any[]; total: number; extra?: [string, number] }) => (
    <div>
      <p className="mb-1 text-sm font-semibold">{title}</p>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId}>
              <td className="py-1 text-stone-600 dark:text-stone-300">{r.name}</td>
              <td className="py-1 text-right tabular-nums">{inr(r.amountPaise)}</td>
            </tr>
          ))}
          {extra ? (
            <tr>
              <td className="py-1 text-stone-600 dark:text-stone-300">{extra[0]}</td>
              <td className="py-1 text-right tabular-nums">{inr(extra[1])}</td>
            </tr>
          ) : null}
          <tr className="border-t border-stone-200 font-semibold dark:border-stone-700">
            <td className="py-1.5">Total {title.toLowerCase()}</td>
            <td className="py-1.5 text-right tabular-nums">{inr(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <Card>
      <CardTitle action={<Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-auto" aria-label="As of" />} sub={`As of ${fmtDate(asOf)}`}>
        Balance sheet <Balanced ok={data.balanced} />
      </CardTitle>
      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Assets" rows={data.assets} total={data.totalAssetsPaise} />
        <div className="space-y-5">
          <Section title="Liabilities" rows={data.liabilities} total={data.totalLiabilitiesPaise} />
          <Section title="Equity" rows={data.equity} total={data.totalEquityPaise} extra={['Profit to date (not yet closed)', data.profitToDatePaise]} />
          <p className="flex justify-between border-t-2 border-stone-300 pt-2 text-sm font-semibold dark:border-stone-600">
            <span>Liabilities + equity</span>
            <span className="tabular-nums">{inr(data.totalLiabilitiesPaise + data.totalEquityPaise)}</span>
          </p>
        </div>
      </div>
    </Card>
  );
}

function sourceLink(t: string, id: string) {
  if (t === 'sale' || t === 'credit_note') return `/sales/${id}`;
  if (t === 'purchase') return `/purchases/${id}`;
  return null;
}

function DayBook({ from, to, branchId }: { from: string; to: string; branchId: string | null }) {
  const { data } = useQ('dayBook', [{ from, to, branchId }]);
  if (!data) return <Loading />;
  return (
    <Card>
      <CardTitle sub={`${data.length} entries`}>Day book</CardTitle>
      {data.length === 0 ? (
        <Empty title="No entries in this period" />
      ) : (
        <div className="space-y-3">
          {data.map((en: any) => {
            const link = sourceLink(en.source_type, en.source_id);
            return (
              <div key={en.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-sm">
                  <span className="font-medium">{link ? <Link to={link} className="hover:underline">{en.narration}</Link> : en.narration}</span>
                  <span className="text-stone-500">{fmtDate(en.business_date, true)}</span>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {en.lines.map((l: any) => (
                      <tr key={l.id}>
                        <td className={`py-0.5 ${l.credit_paise ? 'pl-6' : ''}`}>
                          {l.account_name}
                          {l.party_name ? <span className="text-stone-500"> · {l.party_name}</span> : null}
                        </td>
                        <td className="w-28 py-0.5 text-right tabular-nums">{l.debit_paise ? inr(l.debit_paise) : ''}</td>
                        <td className="w-28 py-0.5 text-right text-stone-500 tabular-nums">{l.credit_paise ? inr(l.credit_paise) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Ledger({ from, to, branchId }: { from: string; to: string; branchId: string | null }) {
  const { data: accounts = [] } = useQ('listAccounts', [{}]);
  const [acc, setAcc] = useState('');
  const accountId = acc || accounts.find((a) => a.system_key === 'cash')?.id || '';
  const { data } = useQ('accountLedger', [{ accountId, from, to, branchId }], { enabled: !!accountId });
  return (
    <Card>
      <div className="mb-3 max-w-sm">
        <Field label="Account">
          <Select value={accountId} onChange={(e) => setAcc(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Details</th>
              <th className="text-right!">Debit</th>
              <th className="text-right!">Credit</th>
              <th className="text-right!">Balance (Dr)</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-stone-500">
              <td>{fmtDate(addDays(from, -1), true)}</td>
              <td>Opening balance</td>
              <td />
              <td />
              <td className="text-right tabular-nums">{inr(data.openingPaise)}</td>
            </tr>
            {data.lines.map((l: any) => (
              <tr key={l.id}>
                <td className="text-stone-500">{fmtDate(l.business_date, true)}</td>
                <td>
                  {l.narration}
                  {l.party_name ? <span className="text-stone-500"> · {l.party_name}</span> : null}
                </td>
                <td className="text-right tabular-nums">{l.debit_paise ? inr(l.debit_paise) : ''}</td>
                <td className="text-right tabular-nums">{l.credit_paise ? inr(l.credit_paise) : ''}</td>
                <td className="text-right tabular-nums">{inr(l.balance_paise)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td />
              <td>Closing balance</td>
              <td />
              <td />
              <td className="text-right tabular-nums">{inr(data.closingPaise)}</td>
            </tr>
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function LockPeriod() {
  const { data: s } = useSession();
  const act = useAct();
  const current = s?.business?.lock_date as string | null;
  const [date, setDate] = useState(addDays(today(), -1));
  return (
    <Card className="max-w-lg space-y-4">
      <CardTitle sub="After locking, nothing dated on or before this day can be added or changed. Corrections go into the open period.">Lock the books</CardTitle>
      <p className="text-sm">
        {current ? (
          <>
            Books are locked up to <b>{fmtDate(current)}</b>.
          </>
        ) : (
          'No period is locked.'
        )}
      </p>
      <Field label="Lock everything up to and including">
        <Input type="date" value={date} max={addDays(today(), -1)} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" icon={Lock} onClick={() => act.run('lockBooks', [date], `Books locked up to ${fmtDate(date)}`)}>
          Lock
        </Button>
        {current ? (
          <Button icon={Unlock} onClick={() => act.run('lockBooks', [null], 'Books unlocked')}>
            Unlock
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-stone-500">If another device syncs an entry for a locked day, it appears in Audit → Exceptions for review.</p>
    </Card>
  );
}

function Chart() {
  const { data = [] } = useQ('listAccounts', [{}]);
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Account</th>
            <th>Type</th>
            <th>Posted by</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id}>
              <td className="font-mono text-xs">{a.code}</td>
              <td>{a.name}</td>
              <td className="text-stone-500 capitalize">{a.type}</td>
              <td>{a.system_key ? <Badge tone="brand">Automatic</Badge> : <Badge>Expenses</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
