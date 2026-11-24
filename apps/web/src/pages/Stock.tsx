import { ADJUST_REASONS, parseQty, parseRupees } from '@shopos/core';
import { ArrowLeftRight, Boxes, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ProductSearch, type PickedProduct } from '../components/pickers';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Table, Tabs, Toggle } from '../components/ui';
import { fmtTime, inr, qty } from '../lib/format';
import { useAct, useDebounced, useQ, useSession } from '../lib/hooks';
import { reasonLabel } from './Items';

export default function Stock() {
  const { data: s } = useSession();
  const [tab, setTab] = useState<'levels' | 'movements' | 'transfer'>('levels');
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [adjust, setAdjust] = useState<any | null>(null);
  const dq = useDebounced(q);
  const { data } = useQ('stockSummary', [{ q: dq, lowOnly: low }]);
  const multi = (s?.branches.length ?? 0) > 1;

  return (
    <div>
      <PageHeader title="Stock" sub={`${s?.branch?.name} · weighted average cost`} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Stock value at cost" value={inr(data?.totalValuePaise ?? 0, true)} icon={Boxes} tone="brand" />
        <Stat label="At selling price" value={inr(data?.totalRetailPaise ?? 0, true)} sub={data ? `Potential margin ${inr(data.totalRetailPaise - data.totalValuePaise, true)}` : undefined} />
        <Stat label="Running low" value={data?.lowCount ?? 0} sub="At or below reorder level" tone="amber" />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'levels', label: 'Stock levels' },
          { id: 'movements', label: 'Movements' },
          ...(multi ? [{ id: 'transfer' as const, label: 'Transfer' }] : []),
        ]}
      />
      {tab === 'levels' && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" className="pl-9" />
            </div>
            <Toggle checked={low} onChange={setLow} label="Only low stock" />
          </div>
          {!data ? (
            <Loading />
          ) : data.items.length === 0 ? (
            <Empty icon={Boxes} title={low ? 'Nothing is running low' : 'No stocked items'} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right!">In stock</th>
                  <th className="text-right!">Avg cost</th>
                  <th className="text-right!">Value</th>
                  <th className="text-right!">Reorder at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/items/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <span className="block text-xs text-stone-500">{p.category_name}</span>
                    </td>
                    <td className="text-right">
                      <Badge tone={p.qty_milli <= 0 ? 'red' : p.low ? 'amber' : 'neutral'}>{qty(p.qty_milli, p.unit)}</Badge>
                    </td>
                    <td className="text-right text-stone-500 tabular-nums">{inr(p.avg_cost_paise)}</td>
                    <td className="text-right tabular-nums">{inr(p.value_paise)}</td>
                    <td className="text-right text-stone-500 tabular-nums">{qty(p.reorder_level_milli)}</td>
                    <td>
                      <Button size="sm" icon={SlidersHorizontal} onClick={() => setAdjust(p)}>
                        Adjust
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {tab === 'movements' && <Movements />}
      {tab === 'transfer' && <Transfer />}
      <AdjustDialog product={adjust} onClose={() => setAdjust(null)} />
    </div>
  );
}

function Movements() {
  const { data = [] } = useQ('listMovements', [{ limit: 300 }]);
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>When</th>
            <th>Item</th>
            <th>What</th>
            <th className="text-right!">Qty</th>
            <th className="text-right!">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.id}>
              <td className="text-stone-500">{fmtTime(m.created_at)}</td>
              <td>{m.product_name}</td>
              <td className="text-stone-600 dark:text-stone-300">{reasonLabel(m.reason)}</td>
              <td className={`text-right tabular-nums ${m.qty_delta_milli < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                {m.qty_delta_milli > 0 ? '+' : ''}
                {qty(m.qty_delta_milli, m.unit)}
              </td>
              <td className="text-right text-stone-500 tabular-nums">{inr(m.value_paise)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function AdjustDialog({ product, onClose }: { product: any | null; onClose: () => void }) {
  const act = useAct();
  const [mode, setMode] = useState<'out' | 'in' | 'set' | 'opening'>('out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<string>('adjust_damage');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  if (!product) return null;
  const n = parseQty(amount || '0') ?? 0;
  const delta = mode === 'out' ? -n : mode === 'in' ? n : mode === 'set' ? n - product.qty_milli : n;

  async function save() {
    if (mode === 'opening') {
      await act.run('setOpeningStock', [{ productId: product.id, qtyMilli: n, unitCostPaise: parseRupees(cost || '0') ?? 0 }], 'Stock added');
    } else {
      await act.run('adjustStock', [{ productId: product.id, qtyDeltaMilli: delta, reason: mode === 'set' ? 'count_correction' : mode === 'in' ? 'count_correction' : reason, note }], 'Stock adjusted');
    }
    setAmount('');
    setNote('');
    onClose();
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust ${product.name}`}
      size="sm"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending} disabled={!delta}>
          Save
        </Button>
      }
    >
      <p className="mb-3 text-sm text-stone-500">In stock: {qty(product.qty_milli, product.unit)}</p>
      <div className="space-y-3">
        <Field label="Change">
          <Select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="out">Remove (damaged, expired, lost…)</option>
            <option value="set">Set counted quantity</option>
            <option value="in">Found extra</option>
            <option value="opening">Add opening stock at cost</option>
          </Select>
        </Field>
        <Field label={mode === 'set' ? `Counted quantity (${product.unit})` : `Quantity (${product.unit})`}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </Field>
        {mode === 'out' ? (
          <Field label="Reason">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {ADJUST_REASONS.filter((r) => r.id !== 'count_correction').map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {mode === 'opening' ? (
          <Field label="Cost per unit">
            <MoneyInput value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
        ) : (
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {mode === 'set' && amount ? <p className="text-sm text-stone-500">Change: {delta > 0 ? '+' : ''}{qty(delta, product.unit)}</p> : null}
        <p className="text-xs text-stone-500">Write-offs are valued at average cost and show in P&amp;L as stock loss.</p>
      </div>
    </Modal>
  );
}

function Transfer() {
  const act = useAct();
  const { data: s } = useSession();
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<{ p: PickedProduct; qty: string }[]>([]);
  const others = s?.branches.filter((b) => b.id !== s.branch?.id) ?? [];
  async function save() {
    await act.run('transferStock', [{ toBranchId: to, lines: lines.map((l) => ({ productId: l.p.id, qtyMilli: parseQty(l.qty) ?? 0 })) }], 'Stock transferred');
    setLines([]);
  }
  return (
    <Card className="space-y-4">
      <p className="text-sm text-stone-500">Move stock from {s?.branch?.name} to another branch at average cost. Both branches update at once.</p>
      <Field label="Send to">
        <Select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose branch</option>
          {others.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <ProductSearch onPick={(p) => setLines((ls) => (ls.some((l) => l.p.id === p.id) ? ls : [...ls, { p, qty: '1' }]))} />
      {lines.length ? (
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {lines.map((l, i) => (
            <li key={l.p.id} className="flex items-center gap-2 py-2">
              <span className="flex-1 text-sm">
                {l.p.name} <span className="text-stone-500">· have {qty(l.p.stock_milli, l.p.unit)}</span>
              </span>
              <Input className="w-24" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))} inputMode="decimal" />
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} aria-label="Remove" />
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={ArrowLeftRight} title="Add items to transfer" />
      )}
      <Button variant="primary" icon={Plus} disabled={!to || !lines.length} loading={act.pending} onClick={save}>
        Transfer stock
      </Button>
    </Card>
  );
}
