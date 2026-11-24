import { parseRupees } from '@shopos/core';
import { Banknote, Calculator, Landmark, Plus, Receipt } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Modal, MoneyInput, PageHeader, Select, Stat, Table, Tabs } from '../components/ui';
import { fmtDate, fmtTime, inr, METHOD_LABEL, today } from '../lib/format';
import { useAct, useQ } from '../lib/hooks';

export default function Money() {
  const [tab, setTab] = useState<'expenses' | 'cash' | 'close'>('expenses');
  const { data: cash = 0 } = useQ('cashBalance', []);
  const { data: tb } = useQ('trialBalance', [{ to: '9999-12-31' }]);
  const bank = tb?.accounts.find((a) => a.code === '1010');
  const bankBal = bank ? bank.balanceDebitPaise - bank.balanceCreditPaise : 0;
  return (
    <div>
      <PageHeader title="Expenses & cash" sub="Money in and out that is not a sale or a purchase" />
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="Cash in drawer (this branch)" value={inr(cash)} icon={Banknote} tone="amber" />
        <Stat label="Bank / UPI (all branches)" value={inr(bankBal)} icon={Landmark} tone="blue" />
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'expenses', label: 'Expenses' }, { id: 'cash', label: 'Cash & bank' }, { id: 'close', label: 'Day close' }]} />
      {tab === 'expenses' && <Expenses />}
      {tab === 'cash' && <CashMoves />}
      {tab === 'close' && <DayClose expected={cash} />}
    </div>
  );
}

function Expenses() {
  const act = useAct();
  const { data: list = [] } = useQ('listExpenses', [{}]);
  const { data: accounts = [] } = useQ('listAccounts', [{ type: 'expense' }]);
  const choices = accounts.filter((a) => !['cogs', 'stock_loss', 'cash_diff', 'round_off'].includes(a.system_key));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ accountId: '', amount: '', method: 'cash', date: today(), payee: '', note: '' });
  const [newCat, setNewCat] = useState('');
  const month = list.filter((x) => x.business_date.slice(0, 7) === today().slice(0, 7)).reduce((t, x) => t + x.amount_paise, 0);
  async function save() {
    let accountId = f.accountId;
    if (accountId === '__new') accountId = await act.run('createExpenseAccount', [newCat]);
    await act.run('recordExpense', [{ accountId, amountPaise: parseRupees(f.amount) ?? 0, method: f.method, date: f.date, payee: f.payee, note: f.note }], 'Expense saved');
    setOpen(false);
    setF({ ...f, amount: '', payee: '', note: '' });
  }
  return (
    <Card>
      <CardTitle sub={`This month: ${inr(month)}`} action={<Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>Add expense</Button>}>
        Expenses
      </CardTitle>
      {list.length === 0 ? (
        <Empty icon={Receipt} title="No expenses yet" text="Rent, salaries, electricity… they reduce your net profit." />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Paid to</th>
              <th>By</th>
              <th className="text-right!">Amount</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td className="text-stone-500">{fmtDate(x.business_date, true)}</td>
                <td>{x.account_name}</td>
                <td className="text-stone-500">{x.payee ?? '—'}</td>
                <td>
                  <Badge>{METHOD_LABEL[x.method] ?? x.method}</Badge>
                </td>
                <td className="text-right tabular-nums">{inr(x.amount_paise)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add expense"
        footer={
          <Button variant="primary" onClick={save} loading={act.pending} disabled={!f.accountId || !(parseRupees(f.amount) ?? 0) || (f.accountId === '__new' && !newCat.trim())}>
            Save
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" className="sm:col-span-2">
            <Select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
              <option value="">Choose…</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              <option value="__new">+ New expense type</option>
            </Select>
          </Field>
          {f.accountId === '__new' ? (
            <Field label="New type name" className="sm:col-span-2">
              <Input value={newCat} onChange={(e) => setNewCat(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Amount">
            <MoneyInput value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <Field label="Paid by">
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank">Bank</option>
              <option value="card">Card</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Paid to">
            <Input value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} />
          </Field>
          <Field label="Note" className="sm:col-span-2">
            <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

const MOVES = [
  { id: 'capital_in', label: 'Owner added money to the shop', needsMethod: true },
  { id: 'drawings', label: 'Owner took money for personal use', needsMethod: true },
  { id: 'bank_deposit', label: 'Deposited cash in bank', needsMethod: false },
  { id: 'bank_withdrawal', label: 'Withdrew cash from bank', needsMethod: false },
] as const;

function CashMoves() {
  const act = useAct();
  const { data: list = [] } = useQ('listMoneyEntries', []);
  const [kind, setKind] = useState<(typeof MOVES)[number]['id']>('bank_deposit');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const move = MOVES.find((m) => m.id === kind)!;
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card className="h-fit space-y-3">
        <CardTitle>Record money movement</CardTitle>
        <Field label="What happened">
          <Select value={kind} onChange={(e) => setKind(e.target.value as any)}>
            {MOVES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount">
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {move.needsMethod ? (
          <Field label="Cash or bank">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank / UPI</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button
          variant="primary"
          className="w-full"
          loading={act.pending}
          disabled={!(parseRupees(amount) ?? 0)}
          onClick={async () => {
            await act.run('recordMoneyMovement', [{ kind, amountPaise: parseRupees(amount) ?? 0, method, note }], 'Saved');
            setAmount('');
            setNote('');
          }}
        >
          Save
        </Button>
      </Card>
      <Card>
        <CardTitle>Recent</CardTitle>
        {list.length === 0 ? (
          <Empty title="Nothing yet" />
        ) : (
          <Table>
            <tbody>
              {list.map((x) => (
                <tr key={x.id}>
                  <td className="text-stone-500">{fmtDate(x.business_date, true)}</td>
                  <td>{x.narration}</td>
                  <td className="text-right tabular-nums">{inr(x.amount_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1];

function DayClose({ expected }: { expected: number }) {
  const act = useAct();
  const { data: sessions = [] } = useQ('listCashSessions', []);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [direct, setDirect] = useState('');
  const counted = useMemo(() => {
    const byNotes = NOTES.reduce((t, n) => t + n * 100 * (Number(counts[n]) || 0), 0);
    return direct ? (parseRupees(direct) ?? 0) : byNotes;
  }, [counts, direct]);
  const diff = counted - expected;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <Card className="space-y-4">
        <CardTitle sub="Count the drawer at closing time">Close the day</CardTitle>
        <div className="grid grid-cols-3 gap-2">
          {NOTES.map((n) => (
            <Field key={n} label={`₹${n} ×`}>
              <Input inputMode="numeric" value={counts[n] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [n]: e.target.value.replace(/\D/g, '') }))} />
            </Field>
          ))}
        </div>
        <Field label="Or enter the total counted">
          <MoneyInput value={direct} onChange={(e) => setDirect(e.target.value)} />
        </Field>
        <div className="rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
          <p className="flex justify-between">
            <span>Expected in drawer</span> <b className="tabular-nums">{inr(expected)}</b>
          </p>
          <p className="flex justify-between">
            <span>Counted</span> <b className="tabular-nums">{inr(counted)}</b>
          </p>
          <p className={`flex justify-between ${diff < 0 ? 'text-rose-600' : diff > 0 ? 'text-emerald-700' : ''}`}>
            <span>{diff < 0 ? 'Short' : diff > 0 ? 'Excess' : 'Difference'}</span> <b className="tabular-nums">{inr(Math.abs(diff))}</b>
          </p>
        </div>
        <Button
          variant="primary"
          icon={Calculator}
          className="w-full"
          loading={act.pending}
          onClick={async () => {
            await act.run('closeDay', [{ countedPaise: counted, denominations: counts }], diff ? `Day closed · ${diff < 0 ? 'short' : 'excess'} ${inr(Math.abs(diff))} posted` : 'Day closed · cash matches');
            setCounts({});
            setDirect('');
          }}
        >
          Close day
        </Button>
      </Card>
      <Card>
        <CardTitle>Previous closes</CardTitle>
        {sessions.length === 0 ? (
          <Empty title="No day closes yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th className="text-right!">Expected</th>
                <th className="text-right!">Counted</th>
                <th className="text-right!">Diff</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((x) => (
                <tr key={x.id}>
                  <td className="text-stone-500">{fmtTime(x.created_at)}</td>
                  <td className="text-right tabular-nums">{inr(x.expected_paise)}</td>
                  <td className="text-right tabular-nums">{inr(x.counted_paise)}</td>
                  <td className={`text-right tabular-nums ${x.difference_paise < 0 ? 'text-rose-600' : x.difference_paise > 0 ? 'text-emerald-700' : 'text-stone-400'}`}>{inr(x.difference_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
