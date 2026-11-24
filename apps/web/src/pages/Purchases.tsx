import { divRound, GST_RATES_BP, lineAmount, parseQty, parseRupees } from '@shopos/core';
import { ArrowLeft, Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PartyPicker, ProductSearch, type PickedProduct } from '../components/pickers';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, KeyValue, Loading, MoneyInput, PageHeader, Select, Table } from '../components/ui';
import { fmtDate, inr, qty, today } from '../lib/format';
import { useAct, useQ, useSession } from '../lib/hooks';

export default function Purchases() {
  const nav = useNavigate();
  const { data } = useQ('listPurchases', [{}]);
  return (
    <div>
      <PageHeader title="Purchases" sub="Stock bought from suppliers" actions={<Button variant="primary" icon={Plus} onClick={() => nav('/purchases/new')}>New purchase</Button>} />
      <Card>
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty icon={Truck} title="No purchases yet" text="Record supplier bills to update stock, cost and what you owe." />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Bill no.</th>
                <th>Items</th>
                <th className="text-right!">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => nav(`/purchases/${d.id}`)}>
                  <td className="text-stone-500">{fmtDate(d.business_date, true)}</td>
                  <td className="font-medium">{d.party_name}</td>
                  <td className="text-stone-500">{d.supplier_bill_no ?? '—'}</td>
                  <td className="text-stone-500">
                    {d.line_count}
                    {d.itc_eligible ? <Badge tone="green" className="ml-2">ITC</Badge> : null}
                  </td>
                  <td className="text-right tabular-nums">
                    {inr(d.total_paise)}
                    {d.due_paise ? <span className="block text-xs text-amber-700">due {inr(d.due_paise)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

interface PLine {
  p: PickedProduct;
  qty: string;
  cost: string;
  gst: number;
}

export function PurchaseNew() {
  const nav = useNavigate();
  const act = useAct();
  const { data: s } = useSession();
  const [partyId, setPartyId] = useState<string | null>(null);
  const { data: party } = useQ('getParty', [partyId ?? ''], { enabled: !!partyId });
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState<PLine[]>([]);
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('cash');

  const registered = !!party?.party.gstin;
  const itc = s?.business?.gst_scheme === 'regular' && registered;
  const inter = registered && party?.party.state_code && s?.branch?.state_code && party.party.state_code !== s.branch.state_code;
  const rows = lines.map((l) => {
    const q = parseQty(l.qty) ?? 0;
    const c = parseRupees(l.cost || '0') ?? 0;
    const taxable = lineAmount(c, q);
    const tax = registered ? (inter ? divRound(taxable * l.gst, 10000) : 2 * divRound(taxable * l.gst, 20000)) : 0;
    return { taxable, tax, total: taxable + tax, q, c };
  });
  const total = rows.reduce((t, r) => t + r.total, 0);
  const tax = rows.reduce((t, r) => t + r.tax, 0);
  const paidPaise = parseRupees(paid || '0') ?? 0;
  const valid = partyId && lines.length && rows.every((r) => r.q > 0) && paidPaise <= total;

  async function save() {
    const r = await act.run(
      'recordPurchase',
      [
        {
          partyId: partyId!,
          supplierBillNo: billNo || undefined,
          date,
          lines: lines.map((l, i) => ({ productId: l.p.id, qtyMilli: rows[i].q, unitCostPaise: rows[i].c, gstRateBp: l.gst })),
          paid: paidPaise ? { method, amountPaise: paidPaise } : null,
        },
      ],
      'Purchase saved · stock updated',
    );
    nav(`/purchases/${r.docId}`, { replace: true });
  }

  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <PageHeader title="New purchase" sub="Enter the supplier's bill. Costs are before GST." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Supplier" className="sm:col-span-3">
              <PartyPicker kind="supplier" value={partyId} onChange={setPartyId} />
            </Field>
            <Field label="Supplier bill no.">
              <Input value={billNo} onChange={(e) => setBillNo(e.target.value)} />
            </Field>
            <Field label="Bill date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} />
            </Field>
          </div>
          <ProductSearch onPick={(p) => setLines((ls) => [...ls, { p, qty: '1', cost: p.avg_cost_paise ? String(p.avg_cost_paise / 100) : String((p.cost_paise ?? 0) / 100), gst: p.gst_rate_bp ?? 0 }])} placeholder="Add item: search or scan" />
          {lines.length === 0 ? (
            <Empty icon={Truck} title="Add the items on the bill" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Cost / unit</th>
                  <th>GST</th>
                  <th className="text-right!">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="font-medium">
                      {l.p.name}
                      <span className="block text-xs text-stone-500">now {qty(l.p.stock_milli, l.p.unit)}</span>
                    </td>
                    <td>
                      <Input className="w-20" value={l.qty} inputMode="decimal" onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity" />
                    </td>
                    <td>
                      <MoneyInput className="w-28" value={l.cost} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, cost: e.target.value } : x)))} aria-label="Cost" />
                    </td>
                    <td>
                      <Select className="w-20" value={l.gst} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, gst: Number(e.target.value) } : x)))} disabled={!registered}>
                        {GST_RATES_BP.map((r) => (
                          <option key={r} value={r}>
                            {r / 100}%
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="text-right tabular-nums">{inr(rows[i].total)}</td>
                    <td>
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} aria-label="Remove" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card className="h-fit space-y-4">
          <CardTitle>Summary</CardTitle>
          <KeyValue
            items={[
              ['Taxable value', inr(total - tax)],
              [inter ? 'IGST' : 'CGST + SGST', inr(tax)],
              ['Bill total', <b key="t">{inr(total)}</b>],
            ]}
          />
          <p className="text-xs text-stone-500">
            {!partyId
              ? 'Choose a supplier.'
              : itc
                ? 'GST on this bill is claimed as input tax credit.'
                : registered
                  ? 'Your shop is not on regular GST, so the GST is added to stock cost.'
                  : 'Unregistered supplier: no GST on this bill.'}
          </p>
          <Field label="Paid now">
            <MoneyInput value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0 (all on credit)" />
          </Field>
          {paidPaise ? (
            <Field label="Paid by">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank</option>
              </Select>
            </Field>
          ) : null}
          <p className="text-sm">
            You'll owe the supplier <b>{inr(Math.max(0, total - paidPaise))}</b>
          </p>
          <Button variant="primary" className="w-full" disabled={!valid} loading={act.pending} onClick={save}>
            Save purchase
          </Button>
        </Card>
      </div>
    </div>
  );
}

export function PurchaseDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data } = useQ('getPurchase', [id]);
  if (!data) return <Loading />;
  const d = data.doc;
  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <PageHeader title={`Purchase from ${d.party_name}`} sub={`${fmtDate(d.business_date)}${d.supplier_bill_no ? ` · bill ${d.supplier_bill_no}` : ''}`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <Table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right!">Qty</th>
                <th className="text-right!">Cost</th>
                <th className="text-right!">GST</th>
                <th className="text-right!">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="text-right tabular-nums">{qty(l.qty_milli, l.unit)}</td>
                  <td className="text-right tabular-nums">{inr(l.unit_cost_paise)}</td>
                  <td className="text-right text-stone-500">{l.gst_rate_bp / 100}%</td>
                  <td className="text-right tabular-nums">{inr(l.line_total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card className="h-fit">
          <KeyValue
            items={[
              ['Taxable', inr(d.taxable_paise)],
              ['GST', inr(d.cgst_paise + d.sgst_paise + d.igst_paise + d.cess_paise)],
              ['Total', inr(d.total_paise)],
              ['Paid', inr(d.paid_paise)],
              ['Due', inr(d.due_paise)],
              ['Input tax credit', d.itc_eligible ? 'Yes' : 'No'],
            ]}
          />
          <p className="mt-4 mb-1 text-sm font-medium">Accounting</p>
          {data.journal.map((j: any) => (
            <p key={j.id} className="flex justify-between text-xs text-stone-600 dark:text-stone-300">
              <span>{j.account_name}</span>
              <span className="tabular-nums">{j.debit_paise ? `Dr ${inr(j.debit_paise)}` : `Cr ${inr(j.credit_paise)}`}</span>
            </p>
          ))}
        </Card>
      </div>
    </div>
  );
}
