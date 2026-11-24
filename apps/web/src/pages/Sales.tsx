import { parseQty } from '@shopos/core';
import { ArrowLeft, Ban, Printer, ReceiptIndianRupee, RotateCcw, Search, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Receipt } from '../components/Receipt';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Table, Textarea, Toggle } from '../components/ui';
import { DOC_TITLE, fmtDate, inr, PERIODS, periodRange, qty, type PeriodKey } from '../lib/format';
import { useAct, useDebounced, useQ, useSession } from '../lib/hooks';
import { billMessage, whatsappLink } from '../lib/share';

export default function Sales() {
  const nav = useNavigate();
  const [period, setPeriod] = useState<PeriodKey>('7d');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const range = periodRange(period === 'custom' ? '7d' : period);
  const { data: sales } = useQ('listSales', [{ ...range, q: dq }]);
  const total = (sales ?? []).filter((s) => !s.voided).reduce((t, s) => t + (s.doc_type === 'credit_note' ? -s.total_paise : s.total_paise), 0);
  return (
    <div>
      <PageHeader title="Sales" sub={`${sales?.length ?? 0} documents · ${inr(total)} net`} actions={<Button variant="primary" onClick={() => nav('/pos')}>New bill</Button>} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bill no., customer or phone" className="pl-9" />
          </div>
          <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="w-auto">
            {PERIODS.filter((p) => p.key !== 'custom').map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        {!sales ? (
          <Loading />
        ) : sales.length === 0 ? (
          <Empty icon={ReceiptIndianRupee} title="No bills in this period" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Bill</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Paid by</th>
                <th className="text-right!">Total</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => nav(`/sales/${s.id}`)}>
                  <td>
                    <span className="font-mono text-xs">{s.doc_no}</span>
                    <div className="mt-0.5 flex gap-1">
                      {s.voided ? <Badge tone="red">Void</Badge> : null}
                      {s.doc_type === 'credit_note' ? <Badge tone="amber">Credit note</Badge> : null}
                      {s.due_paise > 0 && !s.voided ? <Badge tone="blue">Khata {inr(s.due_paise, true)}</Badge> : null}
                    </div>
                  </td>
                  <td className="text-stone-500">{fmtDate(s.business_date, true)}</td>
                  <td>{s.party_name ?? <span className="text-stone-400">Walk-in</span>}</td>
                  <td className="text-stone-500 uppercase">{s.methods ?? (s.due_paise ? 'khata' : '—')}</td>
                  <td className={`text-right font-medium tabular-nums ${s.voided ? 'text-stone-400 line-through' : ''}`}>
                    {s.doc_type === 'credit_note' ? '−' : ''}
                    {inr(s.total_paise)}
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

export function SaleDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data: s } = useSession();
  const { data: sale } = useQ('getSale', [id]);
  const [width, setWidth] = useState<string>(s?.branch?.receipt_width || '80mm');
  const [ret, setRet] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [printed, setPrinted] = useState(false);

  useEffect(() => {
    if (sale && params.get('print') === '1' && !printed) {
      setPrinted(true);
      setTimeout(() => window.print(), 300);
    }
  }, [sale, params, printed]);

  if (!sale) return <Loading />;
  const { doc, lines } = sale;
  const isCN = doc.doc_type === 'credit_note';
  const canReturn = !isCN && !sale.voided && lines.some((l: any) => l.qty_milli > l.returned_milli);
  const canVoid = !isCN && !sale.voided && sale.creditNotes.length === 0;

  function share() {
    const text = billMessage({
      shop: sale!.business?.name ?? 'Shop',
      docNo: doc.doc_no,
      date: fmtDate(doc.business_date),
      total: doc.total_paise,
      due: doc.due_paise,
      lines: lines.map((l: any) => ({ name: l.name, qty: qty(l.qty_milli, l.unit), amount: l.line_total_paise })),
    });
    window.open(whatsappLink(doc.party_phone, text), '_blank', 'noopener');
  }

  return (
    <div>
      <div className="no-print">
        <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ArrowLeft className="size-4" /> Back
        </button>
        <PageHeader
          title={`${DOC_TITLE[doc.doc_type] ?? 'Bill'} ${doc.doc_no}`}
          sub={`${fmtDate(doc.business_date)}${doc.party_name ? ` · ${doc.party_name}` : ''}`}
          actions={
            <>
              <Button icon={Printer} onClick={() => window.print()}>
                Print
              </Button>
              <Button icon={Send} onClick={share}>
                WhatsApp
              </Button>
              {canReturn ? (
                <Button icon={RotateCcw} onClick={() => setRet(true)}>
                  Return
                </Button>
              ) : null}
              {canVoid ? (
                <Button icon={Ban} variant="danger" onClick={() => setVoidOpen(true)}>
                  Void
                </Button>
              ) : null}
            </>
          }
        />
        {sale.voided ? (
          <p className="mb-4 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
            Voided: {sale.events.find((e: any) => e.event === 'void')?.reason}. The number stays used; the books show a reversal.
          </p>
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div>
          <div className="no-print mb-2 flex justify-end">
            <Segmented value={width} onChange={setWidth} items={[{ id: '58mm', label: '58 mm' }, { id: '80mm', label: '80 mm' }, { id: 'A4', label: 'A4' }]} />
          </div>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-stone-200/40 py-6 dark:border-stone-800 dark:bg-stone-900">
            <Receipt sale={sale} width={width} />
          </div>
        </div>
        <div className="no-print space-y-4">
          {sale.creditNotes.length ? (
            <Card>
              <CardTitle>Returns</CardTitle>
              {sale.creditNotes.map((c: any) => (
                <Link key={c.id} to={`/sales/${c.id}`} className="flex justify-between py-1 text-sm hover:underline">
                  <span className="font-mono text-xs">{c.doc_no}</span>
                  <span>−{inr(c.total_paise)}</span>
                </Link>
              ))}
            </Card>
          ) : null}
          {sale.original ? (
            <Card>
              <CardTitle>Original bill</CardTitle>
              <Link to={`/sales/${sale.original.id}`} className="font-mono text-sm text-brand-700 hover:underline">
                {sale.original.doc_no}
              </Link>
            </Card>
          ) : null}
          <Card>
            <CardTitle sub="Double-entry posting for this document">Accounting</CardTitle>
            <table className="w-full text-sm">
              <tbody>
                {sale.journal.map((j: any) => (
                  <tr key={j.id} className="border-t border-stone-100 dark:border-stone-800">
                    <td className="py-1.5">{j.account_name}</td>
                    <td className="py-1.5 text-right tabular-nums">{j.debit_paise ? inr(j.debit_paise) : ''}</td>
                    <td className="py-1.5 text-right text-stone-500 tabular-nums">{j.credit_paise ? inr(j.credit_paise) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-stone-500">Left: debit · right: credit. Every document balances.</p>
          </Card>
        </div>
      </div>
      <ReturnDialog open={ret} onClose={() => setRet(false)} sale={sale} />
      <VoidDialog open={voidOpen} onClose={() => setVoidOpen(false)} docId={doc.id} docNo={doc.doc_no} />
    </div>
  );
}

function ReturnDialog({ open, onClose, sale }: { open: boolean; onClose: () => void; sale: any }) {
  const act = useAct();
  const nav = useNavigate();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [refund, setRefund] = useState<'cash' | 'upi' | 'khata'>(sale.doc.party_id ? 'khata' : 'cash');
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const lines = sale.lines.filter((l: any) => l.qty_milli > l.returned_milli);
  async function save() {
    const payload = lines
      .map((l: any) => ({ lineId: l.id, qtyMilli: parseQty(qtys[l.id] || '0') ?? 0 }))
      .filter((x: any) => x.qtyMilli > 0);
    const r = await act.run('returnSale', [{ docId: sale.doc.id, lines: payload, refund, restock, reason }], 'Credit note created');
    onClose();
    nav(`/sales/${r.creditNoteId}`);
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Return items"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending}>
          Create credit note
        </Button>
      }
    >
      <div className="space-y-3">
        {lines.map((l: any) => (
          <div key={l.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{l.name}</p>
              <p className="text-xs text-stone-500">
                Sold {qty(l.qty_milli, l.unit)}
                {l.returned_milli ? ` · returned ${qty(l.returned_milli)}` : ''}
              </p>
            </div>
            <Input
              className="w-24"
              inputMode="decimal"
              placeholder="0"
              value={qtys[l.id] ?? ''}
              onChange={(e) => setQtys((x) => ({ ...x, [l.id]: e.target.value }))}
              aria-label={`Return quantity for ${l.name}`}
            />
          </div>
        ))}
        <Field label="Refund">
          <Select value={refund} onChange={(e) => setRefund(e.target.value as any)}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            {sale.doc.party_id ? <option value="khata">Reduce customer's khata</option> : null}
          </Select>
        </Field>
        <Toggle checked={restock} onChange={setRestock} label="Put the items back in stock" hint="Turn off for damaged goods" />
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. size issue" />
        </Field>
      </div>
    </Modal>
  );
}

function VoidDialog({ open, onClose, docId, docNo }: { open: boolean; onClose: () => void; docId: string; docNo: string }) {
  const act = useAct();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Void ${docNo}?`}
      size="sm"
      footer={
        <Button
          variant="danger"
          loading={act.pending}
          disabled={!reason.trim()}
          onClick={async () => {
            await act.run('voidSale', [docId, reason], 'Bill voided');
            onClose();
          }}
        >
          Void bill
        </Button>
      }
    >
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-300">
        The bill stays on record and its number stays used. Stock comes back, payments are marked refunded, and the books get a reversing entry.
      </p>
      <Field label="Reason">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
    </Modal>
  );
}
