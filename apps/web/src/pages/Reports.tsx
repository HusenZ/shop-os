import { Download, Info } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Card, CardTitle, Empty, Input, KeyValue, Loading, PageHeader, Select, Stat, Table, Tabs } from '../components/ui';
import { downloadBytes, fmtDate, inr, METHOD_LABEL, PERIODS, periodRange, pct, qty, toCsv, today, type PeriodKey } from '../lib/format';
import { useQ, useSession } from '../lib/hooks';

export function PeriodPicker({ value, onChange }: { value: { key: PeriodKey; from: string; to: string }; onChange: (v: { key: PeriodKey; from: string; to: string }) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        value={value.key}
        onChange={(e) => {
          const key = e.target.value as PeriodKey;
          onChange({ key, ...(key === 'custom' ? { from: value.from, to: value.to } : periodRange(key)) });
        }}
        className="w-auto"
        aria-label="Period"
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </Select>
      {value.key === 'custom' ? (
        <>
          <Input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-auto" aria-label="From" />
          <Input type="date" value={value.to} min={value.from} max={today()} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-auto" aria-label="To" />
        </>
      ) : null}
    </div>
  );
}

export function BranchPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: s } = useSession();
  if ((s?.branches.length ?? 0) < 2) return null;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-auto" aria-label="Branch">
      <option value="">All branches</option>
      {s!.branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}

export default function Reports() {
  const [tab, setTab] = useState<'pnl' | 'sales' | 'stock' | 'gst'>('pnl');
  const [period, setPeriod] = useState({ key: 'month' as PeriodKey, ...periodRange('month') });
  const [branch, setBranch] = useState('');
  const r = { from: period.from, to: period.to, branchId: branch || null };
  return (
    <div>
      <PageHeader title="Reports" sub={`${fmtDate(period.from)} – ${fmtDate(period.to)}`} actions={<><BranchPicker value={branch} onChange={setBranch} /><PeriodPicker value={period} onChange={setPeriod} /></>} />
      <Tabs value={tab} onChange={setTab} items={[{ id: 'pnl', label: 'Profit & loss' }, { id: 'sales', label: 'Sales' }, { id: 'stock', label: 'Stock value' }, { id: 'gst', label: 'GST' }]} />
      {tab === 'pnl' && <Pnl r={r} />}
      {tab === 'sales' && <SalesReport r={r} />}
      {tab === 'stock' && <StockValue branchId={branch || null} />}
      {tab === 'gst' && <Gst r={r} />}
    </div>
  );
}

type R = { from: string; to: string; branchId: string | null };

function change(cur: number, prev: number) {
  if (!prev) return undefined;
  const d = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
  return `${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}% vs previous period`;
}

function Pnl({ r }: { r: R }) {
  const { data: p } = useQ('profitAndLoss', [r]);
  if (!p) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={inr(p.netSalesPaise, true)} sub={change(p.netSalesPaise, p.previous.netSalesPaise)} tone="brand" />
        <Stat label="Gross profit" value={inr(p.grossProfitPaise, true)} sub={`Margin ${pct(p.grossMarginBp)}`} tone="green" />
        <Stat label="Expenses" value={inr(p.totalExpensesPaise, true)} tone="amber" />
        <Stat label="Net profit" value={inr(p.netProfitPaise, true)} sub={change(p.netProfitPaise, p.previous.netProfitPaise) ?? `Net margin ${pct(p.netMarginBp)}`} tone={p.netProfitPaise >= 0 ? 'green' : 'red'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardTitle sub="From the double-entry books (GST is not income)">Profit &amp; loss statement</CardTitle>
          <table className="w-full text-sm">
            <tbody className="[&_td]:py-1.5">
              <tr>
                <td>Sales</td>
                <td className="text-right tabular-nums">{inr(p.salesPaise)}</td>
              </tr>
              {p.returnsPaise ? (
                <tr>
                  <td className="pl-4 text-stone-500">Less: sales returns</td>
                  <td className="text-right text-stone-500 tabular-nums">−{inr(p.returnsPaise)}</td>
                </tr>
              ) : null}
              <tr className="border-t border-stone-200 font-medium dark:border-stone-700">
                <td>Net sales</td>
                <td className="text-right tabular-nums">{inr(p.netSalesPaise)}</td>
              </tr>
              <tr>
                <td className="pl-4 text-stone-500">Less: cost of goods sold</td>
                <td className="text-right text-stone-500 tabular-nums">−{inr(p.cogsPaise)}</td>
              </tr>
              <tr className="border-t border-stone-200 font-semibold dark:border-stone-700">
                <td>Gross profit</td>
                <td className="text-right tabular-nums">{inr(p.grossProfitPaise)}</td>
              </tr>
              {p.otherIncome.map((x) => (
                <tr key={x.accountId}>
                  <td className="pl-4 text-stone-500">Add: {x.name}</td>
                  <td className="text-right text-stone-500 tabular-nums">{inr(x.amountPaise)}</td>
                </tr>
              ))}
              {p.expenses.map((x) => (
                <tr key={x.accountId}>
                  <td className="pl-4 text-stone-500">{x.amountPaise >= 0 ? 'Less' : 'Add'}: {x.name}</td>
                  <td className="text-right text-stone-500 tabular-nums">{x.amountPaise >= 0 ? '−' : '+'}{inr(Math.abs(x.amountPaise))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-stone-300 text-base font-semibold dark:border-stone-600">
                <td>Net profit</td>
                <td className={`text-right tabular-nums ${p.netProfitPaise < 0 ? 'text-rose-600' : ''}`}>{inr(p.netProfitPaise)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <Card className="h-fit">
          <CardTitle>
            <span className="inline-flex items-center gap-1.5">
              <Info className="size-4 text-brand-700" /> Why profit ≠ cash in hand
            </span>
          </CardTitle>
          <KeyValue
            items={[
              ['Money received', inr(p.cashFlow.inPaise)],
              ['Money paid out', inr(p.cashFlow.outPaise)],
              ['Net cash flow', inr(p.cashFlow.netPaise)],
              ['Net profit', inr(p.netProfitPaise)],
            ]}
          />
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-stone-600 dark:text-stone-400">
            <li>Credit (khata) sales count as sales today but cash comes later.</li>
            <li>Stock you buy is not an expense — it becomes cost only when sold.</li>
            <li>GST collected belongs to the government, so it is not in sales.</li>
            <li>Owner drawings and capital move cash but are not profit or loss.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function SalesReport({ r }: { r: R }) {
  const [by, setBy] = useState<'day' | 'product' | 'category' | 'method'>('day');
  const { data = [] } = useQ('salesSummary', [{ ...r, groupBy: by }]);
  const rows = data as any[];
  function exportCsv() {
    const cols =
      by === 'method'
        ? [{ key: 'method', label: 'Method' }, { key: 'amount_paise', label: 'Amount', money: true }]
        : by === 'day'
          ? [{ key: 'day', label: 'Date' }, { key: 'bills', label: 'Bills' }, { key: 'net_paise', label: 'Net sales', money: true }, { key: 'tax_paise', label: 'GST', money: true }, { key: 'profit_paise', label: 'Gross profit', money: true }]
          : [{ key: 'label', label: by === 'product' ? 'Item' : 'Category' }, { key: 'net_paise', label: 'Net sales', money: true }, { key: 'cost_paise', label: 'Cost', money: true }, { key: 'profit_paise', label: 'Profit', money: true }];
    downloadBytes(toCsv(rows, cols), `sales-by-${by}-${r.from}-${r.to}.csv`, 'text/csv');
  }
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs className="mb-0" value={by} onChange={setBy} items={[{ id: 'day', label: 'By day' }, { id: 'product', label: 'By item' }, { id: 'category', label: 'By category' }, { id: 'method', label: 'By payment' }]} />
        <Button size="sm" icon={Download} onClick={exportCsv} disabled={!rows.length}>
          CSV
        </Button>
      </div>
      {rows.length === 0 ? (
        <Empty title="No sales in this period" />
      ) : by === 'day' ? (
        <>
          <div className="mb-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows.map((x) => ({ day: fmtDate(x.day, true), net: x.net_paise / 100, profit: x.profit_paise / 100 }))} margin={{ left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#a8a29e" tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: any, n: any) => [inr(Math.round(v * 100)), n === 'net' ? 'Net sales' : 'Gross profit']} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="net" fill="#16766c" radius={[4, 4, 0, 0]} />
                <Bar dataKey="profit" fill="#d97706" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="text-right!">Bills</th>
                <th className="text-right!">Net sales</th>
                <th className="text-right!">GST</th>
                <th className="text-right!">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.day}>
                  <td>{fmtDate(x.day)}</td>
                  <td className="text-right tabular-nums">{x.bills}</td>
                  <td className="text-right tabular-nums">{inr(x.net_paise)}</td>
                  <td className="text-right text-stone-500 tabular-nums">{inr(x.tax_paise)}</td>
                  <td className="text-right tabular-nums">{inr(x.profit_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : by === 'method' ? (
        <Table>
          <tbody>
            {rows.map((x) => (
              <tr key={x.method}>
                <td>{METHOD_LABEL[x.method] ?? x.method}</td>
                <td className="text-right tabular-nums">{inr(x.amount_paise)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{by === 'product' ? 'Item' : 'Category'}</th>
              {by === 'product' ? <th className="text-right!">Qty</th> : <th className="text-right!">Bills</th>}
              <th className="text-right!">Net sales</th>
              <th className="text-right!">Cost</th>
              <th className="text-right!">Profit</th>
              <th className="text-right!">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key}>
                <td>{x.label}</td>
                <td className="text-right tabular-nums">{by === 'product' ? qty(x.qty_milli) : x.bills}</td>
                <td className="text-right tabular-nums">{inr(x.net_paise)}</td>
                <td className="text-right text-stone-500 tabular-nums">{inr(x.cost_paise)}</td>
                <td className="text-right tabular-nums">{inr(x.profit_paise)}</td>
                <td className="text-right tabular-nums">{pct(x.margin_bp)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function StockValue({ branchId }: { branchId: string | null }) {
  const { data: s } = useSession();
  const { data } = useQ('stockSummary', [{ branchId: branchId ?? s?.branch?.id }]);
  if (!data) return <Loading />;
  return (
    <Card>
      <CardTitle sub={`At weighted average cost · ${data.items.length} items`}>Inventory valuation</CardTitle>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="At cost" value={inr(data.totalValuePaise, true)} />
        <Stat label="At selling price" value={inr(data.totalRetailPaise, true)} />
      </div>
      <Table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="text-right!">Qty</th>
            <th className="text-right!">Avg cost</th>
            <th className="text-right!">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td className="text-right tabular-nums">{qty(p.qty_milli, p.unit)}</td>
              <td className="text-right tabular-nums">{inr(p.avg_cost_paise)}</td>
              <td className="text-right tabular-nums">{inr(p.value_paise)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Gst({ r }: { r: R }) {
  const { data: g } = useQ('gstSummary', [r]);
  if (!g) return <Loading />;
  if (g.scheme === 'none')
    return (
      <Card>
        <Empty title="This shop is not registered for GST" text="Bills are cash memos without tax. Change the GST scheme in Settings if you register." />
      </Card>
    );
  const exportHsn = () =>
    downloadBytes(
      toCsv(g.hsn.map((h: any) => ({ ...h, qty: (h.qty_milli / 1000).toString(), rate: h.rate_bp / 100 })), [
        { key: 'hsn', label: 'HSN' }, { key: 'unit', label: 'UQC' }, { key: 'qty', label: 'Total quantity' }, { key: 'rate', label: 'Rate %' },
        { key: 'taxable_paise', label: 'Taxable value', money: true }, { key: 'tax_paise', label: 'Tax amount', money: true }, { key: 'total_paise', label: 'Total value', money: true },
      ]),
      `hsn-summary-${r.from}-${r.to}.csv`,
      'text/csv',
    );
  const exportB2b = () =>
    downloadBytes(
      toCsv(g.b2b, [
        { key: 'party_gstin', label: 'GSTIN of recipient' }, { key: 'party_name', label: 'Receiver name' }, { key: 'doc_no', label: 'Invoice number' },
        { key: 'business_date', label: 'Invoice date' }, { key: 'total_paise', label: 'Invoice value', money: true }, { key: 'place_of_supply', label: 'Place of supply' },
        { key: 'taxable_paise', label: 'Taxable value', money: true }, { key: 'igst_paise', label: 'IGST', money: true }, { key: 'cgst_paise', label: 'CGST', money: true }, { key: 'sgst_paise', label: 'SGST', money: true },
      ]),
      `b2b-${r.from}-${r.to}.csv`,
      'text/csv',
    );
  if (g.scheme === 'composition')
    return (
      <Card>
        <CardTitle sub="Composition scheme: no tax collected on bills">Composition summary</CardTitle>
        <KeyValue items={[['Turnover in period', inr(g.turnoverPaise)], ['Composition tax due (estimate)', inr(g.compositionTaxPaise)]]} />
      </Card>
    );
  const sumOut = g.output.cgstPaise + g.output.sgstPaise + g.output.igstPaise + g.output.cessPaise;
  const sumIn = g.input.cgst_paise + g.input.sgst_paise + g.input.igst_paise + g.input.cess_paise;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Output GST (on sales)" value={inr(sumOut, true)} />
        <Stat label="Input tax credit (on purchases)" value={inr(sumIn, true)} />
        <Stat label="Net GST payable (estimate)" value={inr(sumOut - sumIn, true)} tone={sumOut - sumIn > 0 ? 'amber' : 'green'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Output tax by rate</CardTitle>
          <Table>
            <thead>
              <tr>
                <th>Rate</th>
                <th className="text-right!">Taxable</th>
                <th className="text-right!">CGST</th>
                <th className="text-right!">SGST</th>
                <th className="text-right!">IGST</th>
              </tr>
            </thead>
            <tbody>
              {g.outputByRate.map((x: any) => (
                <tr key={x.rate_bp}>
                  <td>{x.rate_bp / 100}%</td>
                  <td className="text-right tabular-nums">{inr(x.taxable_paise)}</td>
                  <td className="text-right tabular-nums">{inr(x.cgst_paise)}</td>
                  <td className="text-right tabular-nums">{inr(x.sgst_paise)}</td>
                  <td className="text-right tabular-nums">{inr(x.igst_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle>Net payable by head</CardTitle>
          <KeyValue
            items={[
              ['CGST', inr(g.netPayable.cgstPaise)],
              ['SGST', inr(g.netPayable.sgstPaise)],
              ['IGST', inr(g.netPayable.igstPaise)],
              ['Cess', inr(g.netPayable.cessPaise)],
            ]}
          />
          <p className="mt-2 text-xs text-stone-500">An estimate for your accountant. Cross-utilisation rules and the GST portal decide the final figure.</p>
          <p className="mt-4 mb-1 text-sm font-medium">Documents issued</p>
          {g.docs.map((d: any) => (
            <p key={`${d.doc_type}${d.series}`} className="text-xs text-stone-600 dark:text-stone-300">
              {d.doc_type.replace(/_/g, ' ')} · series {d.series}: {d.first_no} → {d.last_no} ({d.count}, {d.cancelled} cancelled)
            </p>
          ))}
        </Card>
      </div>
      <Card>
        <CardTitle action={<div className="flex gap-2"><Button size="sm" icon={Download} onClick={exportHsn}>HSN CSV</Button><Button size="sm" icon={Download} onClick={exportB2b} disabled={!g.b2b.length}>B2B CSV</Button></div>}>
          HSN summary
        </CardTitle>
        {g.hsn.length === 0 ? (
          <Empty title="No taxable sales in this period" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>HSN</th>
                <th>Rate</th>
                <th className="text-right!">Qty</th>
                <th className="text-right!">Taxable</th>
                <th className="text-right!">Tax</th>
              </tr>
            </thead>
            <tbody>
              {g.hsn.map((h: any, i: number) => (
                <tr key={i}>
                  <td>{h.hsn || '—'}</td>
                  <td>{h.rate_bp / 100}%</td>
                  <td className="text-right tabular-nums">{qty(h.qty_milli, h.unit)}</td>
                  <td className="text-right tabular-nums">{inr(h.taxable_paise)}</td>
                  <td className="text-right tabular-nums">{inr(h.tax_paise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

