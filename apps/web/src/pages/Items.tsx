import { DECIMAL_UNITS, GST_RATES_BP, parseQty, parseRupees, UNITS } from '@shopos/core';
import { ArrowLeft, Package, Pencil, Plus, Search, Star, Tags, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, KeyValue, Loading, Modal, MoneyInput, PageHeader, Select, Table, Tabs, Toggle } from '../components/ui';
import { fmtTime, inr, pct, qty } from '../lib/format';
import { useAct, useDebounced, useQ } from '../lib/hooks';

export default function Items() {
  const [tab, setTab] = useState<'items' | 'categories'>('items');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const dq = useDebounced(q);
  const nav = useNavigate();
  const { data: cats = [] } = useQ('listCategories', []);
  const { data: items } = useQ('listProducts', [{ q: dq, categoryId: cat || null, includeInactive: true, limit: 1000 }]);

  return (
    <div>
      <PageHeader
        title="Items"
        sub={`${items?.length ?? 0} items · ${cats.length} categories`}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            Add item
          </Button>
        }
      />
      <Tabs value={tab} onChange={setTab} items={[{ id: 'items', label: 'Items' }, { id: 'categories', label: 'Categories' }]} />
      {tab === 'items' ? (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, barcode, SKU or HSN" className="pl-9" />
            </div>
            <Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-auto">
              <option value="">All categories</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          {!items ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty icon={Package} title="No items yet" text="Add the things you sell. You can set opening stock while adding." action={<Button variant="primary" onClick={() => setEditing({})}>Add item</Button>} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right!">Price</th>
                  <th className="text-right!">Avg cost</th>
                  <th className="text-right!">Margin</th>
                  <th className="text-right!">GST</th>
                  <th className="text-right!">Stock</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const margin = p.price_paise ? Math.round(((p.price_paise - p.avg_cost_paise * (1 + p.gst_rate_bp / 10000)) / p.price_paise) * 10000) : 0;
                  return (
                    <tr key={p.id} className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => nav(`/items/${p.id}`)}>
                      <td>
                        <span className="flex items-center gap-1.5 font-medium">
                          {p.favourite ? <Star className="size-3.5 fill-amber-400 text-amber-400" /> : null}
                          {p.name}
                          {!p.is_active ? <Badge>Inactive</Badge> : null}
                        </span>
                        <span className="text-xs text-stone-500">{[p.barcode, p.sku, p.hsn && `HSN ${p.hsn}`].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="text-stone-500">{p.category_name ?? '—'}</td>
                      <td className="text-right tabular-nums">{inr(p.price_paise)}</td>
                      <td className="text-right text-stone-500 tabular-nums">{inr(p.avg_cost_paise)}</td>
                      <td className="text-right tabular-nums">{p.avg_cost_paise ? pct(margin) : '—'}</td>
                      <td className="text-right text-stone-500">{pct(p.gst_rate_bp)}</td>
                      <td className="text-right tabular-nums">
                        {p.track_stock ? <Badge tone={p.stock_milli <= 0 ? 'red' : p.stock_milli <= p.reorder_level_milli ? 'amber' : 'neutral'}>{qty(p.stock_milli, p.unit)}</Badge> : <span className="text-stone-400">—</span>}
                      </td>
                      <td>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(p);
                          }}
                          className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                          aria-label={`Edit ${p.name}`}
                        >
                          <Pencil className="size-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Categories />
      )}
      <ProductEditor product={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

export function ProductEditor({ product, onClose }: { product: any | null; onClose: () => void }) {
  const act = useAct();
  const { data: cats = [] } = useQ('listCategories', []);
  const isNew = product && !product.id;
  const [f, setF] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!product) return;
    setF({
      name: product.name ?? '',
      category_id: product.category_id ?? '',
      unit: product.unit ?? 'pcs',
      price: product.price_paise != null ? String(product.price_paise / 100) : '',
      mrp: product.mrp_paise ? String(product.mrp_paise / 100) : '',
      cost: product.cost_paise ? String(product.cost_paise / 100) : '',
      gst: String(product.gst_rate_bp ?? 0),
      hsn: product.hsn ?? '',
      barcode: product.barcode ?? '',
      sku: product.sku ?? '',
      reorder: product.reorder_level_milli ? String(product.reorder_level_milli / 1000) : '',
      track: product.track_stock ?? 1,
      fav: product.favourite ?? 0,
      active: product.is_active ?? 1,
      opening: '',
    });
  }, [product]);
  if (!product) return null;
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const price = parseRupees(f.price || '');
  const valid = f.name?.trim() && price !== null;

  async function save() {
    const row: Record<string, any> = {
      name: f.name,
      category_id: f.category_id || null,
      unit: f.unit,
      allow_decimal: DECIMAL_UNITS.has(f.unit) ? 1 : 0,
      price_paise: price,
      mrp_paise: f.mrp ? parseRupees(f.mrp) : null,
      cost_paise: f.cost ? (parseRupees(f.cost) ?? 0) : 0,
      gst_rate_bp: Number(f.gst),
      hsn: f.hsn || null,
      barcode: f.barcode || null,
      sku: f.sku || null,
      reorder_level_milli: f.reorder ? (parseQty(f.reorder) ?? 0) : 0,
      track_stock: f.track ? 1 : 0,
      favourite: f.fav ? 1 : 0,
      is_active: f.active ? 1 : 0,
    };
    if (isNew) {
      if (f.opening) row.opening_qty_milli = parseQty(f.opening) ?? 0;
      await act.run('createProduct', [row as any], `${f.name} added`);
    } else await act.run('updateProduct', [product.id, row], 'Item updated');
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'Add item' : `Edit ${product.name}`}
      size="lg"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending} disabled={!valid}>
          Save
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Basmati rice 1 kg" />
        </Field>
        <Field label="Category">
          <Select value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">Uncategorised</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unit" hint={DECIMAL_UNITS.has(f.unit) ? 'Sold loose: decimals like 0.25 allowed' : undefined}>
          <Select value={f.unit} onChange={(e) => set('unit', e.target.value)}>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </Select>
        </Field>
        <Field label={`Selling price per ${f.unit}`}>
          <MoneyInput value={f.price} onChange={(e) => set('price', e.target.value)} />
        </Field>
        <Field label="MRP (optional)">
          <MoneyInput value={f.mrp} onChange={(e) => set('mrp', e.target.value)} />
        </Field>
        <Field label="Purchase cost" hint="Used for profit until you record purchases">
          <MoneyInput value={f.cost} onChange={(e) => set('cost', e.target.value)} />
        </Field>
        <Field label="GST rate">
          <Select value={f.gst} onChange={(e) => set('gst', e.target.value)}>
            {GST_RATES_BP.map((r) => (
              <option key={r} value={r}>
                {r / 100}%
              </option>
            ))}
          </Select>
        </Field>
        <Field label="HSN code">
          <Input value={f.hsn} onChange={(e) => set('hsn', e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Barcode">
          <Input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="Scan or type" />
        </Field>
        <Field label="SKU / short code">
          <Input value={f.sku} onChange={(e) => set('sku', e.target.value)} />
        </Field>
        <Field label={`Reorder when stock falls to (${f.unit})`}>
          <Input value={f.reorder} onChange={(e) => set('reorder', e.target.value)} inputMode="decimal" />
        </Field>
        {isNew && f.track ? (
          <Field label={`Opening stock (${f.unit})`} hint="Valued at the purchase cost">
            <Input value={f.opening} onChange={(e) => set('opening', e.target.value)} inputMode="decimal" />
          </Field>
        ) : null}
        <div className="space-y-3 sm:col-span-2">
          <Toggle checked={!!f.track} onChange={(v) => set('track', v)} label="Track stock" hint="Turn off for services or items you never count" />
          <Toggle checked={!!f.fav} onChange={(v) => set('fav', v)} label="Show first on the billing screen" />
          {!isNew ? <Toggle checked={!!f.active} onChange={(v) => set('active', v)} label="Active" hint="Inactive items are hidden from billing" /> : null}
        </div>
      </div>
    </Modal>
  );
}

function Categories() {
  const act = useAct();
  const { data: cats = [] } = useQ('listCategories', []);
  const [name, setName] = useState('');
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  return (
    <Card>
      <form
        className="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await act.run('createCategory', [{ name }], 'Category added');
          setName('');
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category name" />
        <Button type="submit" variant="primary" icon={Plus} disabled={!name.trim()}>
          Add
        </Button>
      </form>
      {cats.length === 0 ? (
        <Empty icon={Tags} title="No categories" />
      ) : (
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2.5">
              <span className="flex items-center gap-2 text-sm">
                <span className="size-3 rounded-full" style={{ background: c.color ?? '#999' }} />
                {c.name}
                <span className="text-stone-400">· {c.product_count} items</span>
              </span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRename({ id: c.id, name: c.name })} aria-label="Rename" />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash2}
                  onClick={() => confirm(`Delete category “${c.name}”? Its items become uncategorised.`) && act.run('updateCategory', [c.id, { deleted: 1 }], 'Category deleted')}
                  aria-label="Delete"
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!rename}
        onClose={() => setRename(null)}
        title="Rename category"
        size="sm"
        footer={
          <Button
            variant="primary"
            onClick={async () => {
              await act.run('updateCategory', [rename!.id, { name: rename!.name }], 'Renamed');
              setRename(null);
            }}
          >
            Save
          </Button>
        }
      >
        <Input value={rename?.name ?? ''} onChange={(e) => setRename((r) => (r ? { ...r, name: e.target.value } : r))} />
      </Modal>
    </Card>
  );
}

const REASON: Record<string, string> = {
  opening: 'Opening stock', sale: 'Sold', sale_return: 'Returned by customer', purchase: 'Purchased', transfer_in: 'Transfer in',
  transfer_out: 'Transfer out', adjust_damage: 'Damaged', adjust_expiry: 'Expired', adjust_loss: 'Lost / theft',
  adjust_self_use: 'Self use', count_correction: 'Count correction', void: 'Bill voided',
};
export const reasonLabel = (r: string) => REASON[r] ?? r;

export function ItemDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data } = useQ('getProduct', [id]);
  const [edit, setEdit] = useState(false);
  if (!data) return <Loading />;
  const p = data.product;
  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <PageHeader title={p.name} sub={p.category_name ?? 'Uncategorised'} actions={<Button icon={Pencil} onClick={() => setEdit(true)}>Edit</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>Details</CardTitle>
          <KeyValue
            items={[
              ['Selling price', inr(p.price_paise)],
              ['MRP', p.mrp_paise ? inr(p.mrp_paise) : '—'],
              ['Average cost', inr(data.avgCostPaise)],
              ['GST', pct(p.gst_rate_bp)],
              ['HSN', p.hsn ?? '—'],
              ['Barcode', p.barcode ?? '—'],
              ['Stock here', p.track_stock ? qty(data.stockMilli, p.unit) : 'Not tracked'],
              ['Sold (all time)', `${qty(data.sold?.qty_milli, p.unit)} · ${inr(data.sold?.net_paise)}`],
              ['Profit (all time)', inr((data.sold?.net_paise ?? 0) - (data.sold?.cost_paise ?? 0))],
            ]}
          />
          {data.levels.length > 1 ? (
            <div className="mt-4">
              <p className="mb-1 text-sm font-medium">By branch</p>
              {data.levels.map((l: any) => (
                <p key={l.branch_id} className="flex justify-between text-sm">
                  <span>{l.branch_name}</span>
                  <span className="tabular-nums">{qty(l.qty_milli, p.unit)}</span>
                </p>
              ))}
            </div>
          ) : null}
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle action={<Link to="/stock" className="text-sm text-brand-700 hover:underline">Adjust stock</Link>}>Stock movements</CardTitle>
          {data.movements.length === 0 ? (
            <Empty title="No movements yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Branch</th>
                  <th className="text-right!">Qty</th>
                  <th className="text-right!">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((m: any) => (
                  <tr key={m.id}>
                    <td className="text-stone-500">{fmtTime(m.created_at)}</td>
                    <td>
                      {reasonLabel(m.reason)}
                      {m.note ? <span className="text-stone-500"> · {m.note}</span> : null}
                    </td>
                    <td className="text-stone-500">{m.branch_name}</td>
                    <td className={`text-right tabular-nums ${m.qty_delta_milli < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                      {m.qty_delta_milli > 0 ? '+' : ''}
                      {qty(m.qty_delta_milli)}
                    </td>
                    <td className="text-right text-stone-500 tabular-nums">{inr(m.value_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <ProductEditor product={edit ? p : null} onClose={() => setEdit(false)} />
    </div>
  );
}
