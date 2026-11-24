import { parseRupees } from '@shopos/core';
import { ArrowLeft, HandCoins, Pencil, Plus, Search, Send, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Table, Tabs } from '../components/ui';
import { fmtDate, inr, qty } from '../lib/format';
import { useAct, useDebounced, useQ, useSession } from '../lib/hooks';
import { reminderMessage, whatsappLink } from '../lib/share';

export default function Parties({ kind }: { kind: 'customer' | 'supplier' }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const dq = useDebounced(q);
  const { data: list } = useQ('listParties', [{ kind, q: dq }]);
  const label = kind === 'customer' ? 'Customers' : 'Suppliers';
  const totalBal = (list ?? []).reduce((s, p) => s + (kind === 'customer' ? Math.max(0, p.receivable_paise) : Math.max(0, p.payable_paise)), 0);
  return (
    <div>
      <PageHeader
        title={label}
        sub={`${list?.length ?? 0} ${label.toLowerCase()} · ${kind === 'customer' ? "you'll get" : "you'll give"} ${inr(totalBal)}`}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing({ kind })}>
            Add {kind}
          </Button>
        }
      />
      <Card>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or GSTIN" className="pl-9" />
        </div>
        {!list ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty icon={Users} title={`No ${label.toLowerCase()} yet`} text={kind === 'customer' ? 'Customers are added from the bill screen too.' : undefined} />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>{kind === 'customer' ? 'Last bill' : 'GSTIN'}</th>
                <th className="text-right!">{kind === 'customer' ? 'Owes you' : 'You owe'}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const bal = kind === 'customer' ? p.receivable_paise : p.payable_paise;
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => nav(`/parties/${p.id}`)}>
                    <td className="font-medium">
                      {p.name}
                      {p.tags ? <Badge className="ml-2">{p.tags}</Badge> : null}
                    </td>
                    <td className="text-stone-500">{p.phone ?? '—'}</td>
                    <td className="text-stone-500">{kind === 'customer' ? fmtDate(p.last_sale_date, true) : (p.gstin ?? '—')}</td>
                    <td className={`text-right font-medium tabular-nums ${bal > 0 ? 'text-amber-700 dark:text-amber-400' : bal < 0 ? 'text-emerald-700' : 'text-stone-400'}`}>
                      {bal < 0 ? `Advance ${inr(-bal)}` : inr(bal)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <PartyEditor party={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

export function PartyEditor({ party, onClose }: { party: any | null; onClose: () => void }) {
  const act = useAct();
  const isNew = party && !party.id;
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!party) return;
    setF({
      name: party.name ?? '',
      phone: party.phone ?? '',
      email: party.email ?? '',
      gstin: party.gstin ?? '',
      address: party.address ?? '',
      tags: party.tags ?? '',
      notes: party.notes ?? '',
      limit: party.credit_limit_paise ? String(party.credit_limit_paise / 100) : '',
      days: party.credit_days ? String(party.credit_days) : '',
      opening: '',
    });
  }, [party]);
  if (!party) return null;
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const kind = party.kind ?? 'customer';
  async function save() {
    const row: Record<string, any> = {
      name: f.name,
      phone: f.phone || null,
      email: f.email || null,
      gstin: f.gstin || null,
      address: f.address || null,
      tags: f.tags || null,
      notes: f.notes || null,
      credit_limit_paise: f.limit ? (parseRupees(f.limit) ?? 0) : 0,
      credit_days: f.days ? Number(f.days) : 0,
    };
    if (isNew) {
      if (f.opening) row.opening_balance_paise = parseRupees(f.opening) ?? 0;
      await act.run('createParty', [{ ...row, kind }], `${kind === 'customer' ? 'Customer' : 'Supplier'} added`);
    } else await act.run('updateParty', [party.id, row], 'Saved');
    onClose();
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? `Add ${kind}` : `Edit ${party.name}`}
      size="lg"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending} disabled={!f.name?.trim()}>
          Save
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Phone (for WhatsApp)">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" />
        </Field>
        <Field label="GSTIN" hint="For B2B tax invoices">
          <Input value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} />
        </Field>
        <Field label="Email">
          <Input value={f.email} onChange={(e) => set('email', e.target.value)} type="email" />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        {kind === 'customer' ? (
          <>
            <Field label="Credit limit" hint="Billing warns when khata would cross this (0 = no limit)">
              <MoneyInput value={f.limit} onChange={(e) => set('limit', e.target.value)} />
            </Field>
            <Field label="Credit days">
              <Input value={f.days} onChange={(e) => set('days', e.target.value)} inputMode="numeric" />
            </Field>
          </>
        ) : null}
        <Field label="Tags">
          <Input value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="regular, wholesale…" />
        </Field>
        {isNew ? (
          <Field label={kind === 'customer' ? 'Old dues (from paper khata)' : 'Amount you already owe them'}>
            <MoneyInput value={f.opening} onChange={(e) => set('opening', e.target.value)} />
          </Field>
        ) : null}
        <Field label="Notes" className="sm:col-span-2">
          <Input value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function PaymentDialog({ party, open, onClose }: { party: any; open: boolean; onClose: () => void }) {
  const act = useAct();
  const supplier = party.kind === 'supplier';
  const bal = supplier ? party.payable_paise : party.receivable_paise;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setAmount(bal > 0 ? String(bal / 100) : '');
  }, [open, bal]);
  const paise = parseRupees(amount || '0') ?? 0;
  async function save() {
    const args = { partyId: party.id, amountPaise: paise, method, note };
    if (supplier) await act.run('paySupplier', [args], 'Payment recorded');
    else await act.run('receivePayment', [args], 'Payment received');
    onClose();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={supplier ? `Pay ${party.name}` : `Receive from ${party.name}`}
      size="sm"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending} disabled={paise <= 0}>
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-stone-500">
          {supplier ? 'You owe' : 'Balance due'}: <b>{inr(bal)}</b>
        </p>
        <Field label="Amount">
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Paid by">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="bank">Bank transfer</option>
            <option value="card">Card</option>
          </Select>
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function PartyDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data: s } = useSession();
  const { data } = useQ('getParty', [id]);
  const { data: st } = useQ('partyStatement', [{ partyId: id }]);
  const [tab, setTab] = useState<'statement' | 'bills'>('statement');
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  if (!data || !st) return <Loading />;
  const p = data.party;
  const supplier = p.kind === 'supplier';
  const bal = supplier ? p.payable_paise : p.receivable_paise;
  const remind = () => window.open(whatsappLink(p.phone, reminderMessage({ shop: s?.business?.name ?? 'our shop', name: p.name, due: bal, upiId: s?.branch?.upi_id })), '_blank', 'noopener');

  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <PageHeader
        title={p.name}
        sub={[p.phone, p.gstin, p.address].filter(Boolean).join(' · ') || (supplier ? 'Supplier' : 'Customer')}
        actions={
          <>
            <Button icon={Pencil} onClick={() => setEdit(true)}>
              Edit
            </Button>
            {!supplier && bal > 0 && p.phone ? (
              <Button icon={Send} onClick={remind}>
                Remind
              </Button>
            ) : null}
            <Button variant="primary" icon={HandCoins} onClick={() => setPay(true)}>
              {supplier ? 'Pay' : 'Receive payment'}
            </Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={supplier ? 'You owe' : 'Owes you'} value={inr(bal)} tone={bal > 0 ? 'amber' : 'green'} sub={p.credit_limit_paise ? `Limit ${inr(p.credit_limit_paise, true)}` : undefined} />
        {supplier ? (
          <Stat label="Purchases" value={data.purchases.length} sub="Last 50 shown below" />
        ) : (
          <>
            <Stat label="Total bought" value={inr(data.stats.total_paise, true)} sub={`${data.stats.bills} bills`} />
            <Stat label="Average bill" value={inr(data.stats.avg_bill_paise, true)} />
            <Stat label="Last visit" value={fmtDate(data.stats.last_visit, true)} sub={data.stats.first_visit ? `Customer since ${fmtDate(data.stats.first_visit, true)}` : undefined} />
          </>
        )}
      </div>
      {data.favourites.length ? (
        <p className="mb-4 text-sm text-stone-500">Usually buys: {data.favourites.map((f: any) => `${f.name} (${qty(f.qty_milli, f.unit)})`).join(', ')}</p>
      ) : null}
      <Tabs value={tab} onChange={setTab} items={[{ id: 'statement', label: 'Khata passbook' }, { id: 'bills', label: supplier ? 'Purchases' : 'Bills' }]} />
      {tab === 'statement' ? (
        <Card>
          <CardTitle sub={supplier ? 'Positive balance = you owe them' : 'Positive balance = they owe you'}>Statement</CardTitle>
          {st.entries.length === 0 ? (
            <Empty title="No entries yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Details</th>
                  <th className="text-right!">{supplier ? 'Bill' : 'Gave'}</th>
                  <th className="text-right!">{supplier ? 'Paid' : 'Got'}</th>
                  <th className="text-right!">Balance</th>
                </tr>
              </thead>
              <tbody>
                {st.entries.map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="text-stone-500">{fmtDate(e.business_date, true)}</td>
                    <td>
                      {e.source_type === 'sale' || e.source_type === 'credit_note' ? (
                        <Link to={`/sales/${e.source_id}`} className="hover:underline">
                          {e.narration}
                        </Link>
                      ) : e.source_type === 'purchase' ? (
                        <Link to={`/purchases/${e.source_id}`} className="hover:underline">
                          {e.narration}
                        </Link>
                      ) : (
                        e.narration
                      )}
                    </td>
                    <td className="text-right text-amber-700 tabular-nums dark:text-amber-400">{e.amount_paise > 0 ? inr(e.amount_paise) : ''}</td>
                    <td className="text-right text-emerald-700 tabular-nums dark:text-emerald-400">{e.amount_paise < 0 ? inr(-e.amount_paise) : ''}</td>
                    <td className="text-right font-medium tabular-nums">{inr(e.balance_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Card>
          {(supplier ? data.purchases : data.sales).length === 0 ? (
            <Empty title="Nothing yet" />
          ) : (
            <Table>
              <tbody>
                {(supplier ? data.purchases : data.sales).map((d: any) => (
                  <tr key={d.id} className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => nav(supplier ? `/purchases/${d.id}` : `/sales/${d.id}`)}>
                    <td className="font-mono text-xs">{d.doc_no ?? d.supplier_bill_no ?? '—'}</td>
                    <td className="text-stone-500">{fmtDate(d.business_date, true)}</td>
                    <td>{d.voided ? <Badge tone="red">Void</Badge> : d.due_paise > 0 ? <Badge tone="amber">Due {inr(d.due_paise, true)}</Badge> : null}</td>
                    <td className="text-right tabular-nums">{inr(d.total_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      <PaymentDialog party={p} open={pay} onClose={() => setPay(false)} />
      <PartyEditor party={edit ? p : null} onClose={() => setEdit(false)} />
    </div>
  );
}
