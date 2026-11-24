import { parseQty, parseRupees } from '@shopos/core';
import { keepPreviousData } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { CheckCircle2, Minus, Pause, Plus, Printer, Search, Send, ShoppingCart, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CameraScanner, PartyPicker, ScanButton } from '../components/pickers';
import { Badge, Button, Field, Input, Modal, MoneyInput, Segmented, clsx } from '../components/ui';
import { fmtDate, inr, qty } from '../lib/format';
import { useAct, useDebounced, useHotkey, useQ, useSession } from '../lib/hooks';
import { call } from '../lib/rpc';
import { billMessage, upiLink, whatsappLink } from '../lib/share';

interface Line {
  productId: string;
  name: string;
  unit: string;
  allowDecimal: boolean;
  qtyMilli: number;
  unitPricePaise: number;
  discountPaise: number;
  stockMilli: number;
  track: boolean;
}

interface Cart {
  lines: Line[];
  partyId: string | null;
  billDiscount: string;
}

const EMPTY: Cart = { lines: [], partyId: null, billDiscount: '' };

export default function Pos() {
  const { data: s } = useSession();
  const [cart, setCart] = useState<Cart>(EMPTY);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [pay, setPay] = useState(false);
  const [scan, setScan] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [done, setDone] = useState<null | { docId: string; docNo: string; totalPaise: number; changePaise: number; duePaise: number }>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q, 80);
  const act = useAct();

  const { data: cats = [] } = useQ('listCategories', []);
  const { data: products = [] } = useQ('listProducts', [{ q: dq, categoryId: cat, limit: 120 }], { placeholderData: keepPreviousData });
  const { data: held = [] } = useQ('listHeldBills', []);

  const billDiscountPaise = parseRupees(cart.billDiscount || '0') ?? 0;
  const previewArgs = { lines: cart.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise })), partyId: cart.partyId, billDiscountPaise };
  const preview = useQ('previewSale', [previewArgs], { enabled: cart.lines.length > 0, placeholderData: keepPreviousData, retry: false });
  const priced = cart.lines.length ? preview.data : undefined;

  const add = useCallback((p: any, qtyMilli?: number) => {
    setCart((c) => {
      const i = c.lines.findIndex((l) => l.productId === p.id);
      const step = qtyMilli ?? 1000;
      if (i >= 0) {
        const lines = [...c.lines];
        lines[i] = { ...lines[i], qtyMilli: lines[i].qtyMilli + step };
        return { ...c, lines };
      }
      return {
        ...c,
        lines: [
          ...c.lines,
          {
            productId: p.id, name: p.name, unit: p.unit, allowDecimal: !!p.allow_decimal, qtyMilli: step, unitPricePaise: p.price_paise ?? 0,
            discountPaise: 0, stockMilli: p.stock_milli ?? 0, track: !!p.track_stock,
          },
        ],
      };
    });
  }, []);

  async function submitSearch() {
    const code = q.trim();
    if (!code) return;
    const exact = await call('findProductByCode', code);
    if (exact) {
      const full = (await call('listProducts', { q: exact.name, limit: 5 })).find((p) => p.id === exact.id) ?? exact;
      add(full);
      setQ('');
      return;
    }
    const fresh = await call('listProducts', { q: code, categoryId: cat, limit: 1 });
    if (fresh.length) {
      add(fresh[0]);
      setQ('');
    } else toast.error(`No item matches “${code}”`);
  }

  const onScan = useCallback(async (code: string) => {
    const exact = await call('findProductByCode', code);
    if (!exact) return toast.error(`No item with barcode ${code}`);
    const full = (await call('listProducts', { q: exact.name, limit: 5 })).find((p) => p.id === exact.id) ?? exact;
    add(full);
    toast.success(`Added ${exact.name}`);
  }, [add]);

  function setLine(i: number, patch: Partial<Line>) {
    setCart((c) => ({ ...c, lines: c.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));
  }
  function bump(i: number, dir: 1 | -1) {
    const l = cart.lines[i];
    const step = l.allowDecimal && l.qtyMilli < 1000 ? 250 : 1000;
    const next = l.qtyMilli + dir * step;
    if (next <= 0) setCart((c) => ({ ...c, lines: c.lines.filter((_, k) => k !== i) }));
    else setLine(i, { qtyMilli: next });
  }

  async function hold() {
    if (!cart.lines.length) return;
    await act.run('holdBill', [`${cart.lines.length} item(s) · ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`, cart], 'Bill held');
    setCart(EMPTY);
  }
  async function resume(h: any) {
    if (cart.lines.length) await hold();
    setCart(h.cart as Cart);
    await act.run('deleteHeldBill', [h.id]);
  }

  useHotkey('F2', (e) => {
    e.preventDefault();
    search.current?.focus();
  });
  useHotkey('F9', (e) => {
    e.preventDefault();
    if (cart.lines.length && priced) setPay(true);
  }, [cart.lines.length, priced]);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const itemCount = cart.lines.length;
  const cartPanel = (
    <CartPanel
      cart={cart}
      setCart={setCart}
      priced={priced}
      error={cart.lines.length ? (preview.error as Error | null)?.message : undefined}
      onBump={bump}
      onEdit={setEdit}
      onPay={() => {
        setSheet(false);
        setPay(true);
      }}
      onHold={hold}
    />
  );

  return (
    <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-5 xl:grid-cols-[1fr_420px]">
      <div className="min-w-0">
        <div className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <Input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
              placeholder="Search or scan barcode (F2) — Enter adds"
              className="h-11 pl-9 text-base"
              aria-label="Search items"
            />
          </div>
          <ScanButton onClick={() => setScan(true)} className="h-11" />
          {held.length ? (
            <HeldMenu held={held} onResume={resume} />
          ) : null}
        </div>
        <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
          <Chip active={!cat} onClick={() => setCat(null)}>
            All
          </Chip>
          {cats.map((c) => (
            <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {products.map((p) => {
            const inCart = cart.lines.find((l) => l.productId === p.id);
            const low = p.track_stock && p.stock_milli <= 0;
            return (
              <button
                key={p.id}
                onClick={() => add(p)}
                className={clsx(
                  'relative flex min-h-24 flex-col justify-between rounded-xl border bg-white p-3 text-left transition active:scale-[0.98] dark:bg-stone-900',
                  inCart ? 'border-brand-600 ring-2 ring-brand-600/20' : 'border-stone-200 hover:border-stone-300 dark:border-stone-800',
                )}
              >
                <span className="line-clamp-2 text-sm leading-snug font-medium">{p.name}</span>
                <span className="mt-2 flex items-end justify-between gap-1">
                  <span className="font-semibold tabular-nums">{inr(p.price_paise)}</span>
                  {p.track_stock ? (
                    <span className={clsx('text-xs tabular-nums', low ? 'text-rose-600' : 'text-stone-500')}>{qty(p.stock_milli, p.unit)}</span>
                  ) : null}
                </span>
                {inCart ? (
                  <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">{qty(inCart.qtyMilli)}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {products.length === 0 ? <p className="py-10 text-center text-sm text-stone-500">No items found. Add items in Items.</p> : null}
      </div>

      <aside className="hidden lg:block">
        <div className="sticky top-20">{cartPanel}</div>
      </aside>

      <div className="fixed inset-x-0 bottom-16 z-20 px-3 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <button
          onClick={() => setSheet(true)}
          disabled={!itemCount}
          className="flex h-14 w-full items-center justify-between rounded-2xl bg-brand-700 px-5 text-white shadow-lg disabled:bg-stone-400"
        >
          <span className="flex items-center gap-2 text-sm">
            <ShoppingCart className="size-5" /> {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
          <span className="text-lg font-semibold tabular-nums">{inr(priced?.totalPaise ?? 0)}</span>
        </button>
      </div>
      <Modal open={sheet} onClose={() => setSheet(false)} title="Bill">
        {cartPanel}
      </Modal>

      <LineEditor
        line={edit !== null ? cart.lines[edit] : null}
        onClose={() => setEdit(null)}
        onSave={(patch) => {
          if (edit !== null) setLine(edit, patch);
          setEdit(null);
        }}
        onRemove={() => {
          setCart((c) => ({ ...c, lines: c.lines.filter((_, k) => k !== edit) }));
          setEdit(null);
        }}
      />
      {priced ? (
        <PayDialog
          open={pay}
          onClose={() => setPay(false)}
          totalPaise={priced.totalPaise}
          cart={cart}
          billDiscountPaise={billDiscountPaise}
          upiId={s?.branch?.upi_id}
          upiName={s?.branch?.upi_name || s?.business?.name}
          onDone={(r) => {
            setPay(false);
            setDone(r);
            setCart(EMPTY);
            if (r.warnings.length) r.warnings.forEach((w) => toast.warning(w));
          }}
        />
      ) : null}
      <DoneDialog done={done} onClose={() => setDone(null)} />
      <CameraScanner open={scan} onClose={() => setScan(false)} onCode={onScan} />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'h-8 shrink-0 rounded-full border px-3 text-sm whitespace-nowrap transition',
        active ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900' : 'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300',
      )}
    >
      {children}
    </button>
  );
}

function HeldMenu({ held, onResume }: { held: any[]; onResume: (h: any) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={Pause} className="h-11" onClick={() => setOpen(true)}>
        {held.length}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Held bills" size="sm">
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {held.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2 py-2">
              <span className="text-sm">{h.label}</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onResume(h);
                  setOpen(false);
                }}
              >
                Resume
              </Button>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}

function CartPanel({
  cart,
  setCart,
  priced,
  error,
  onBump,
  onEdit,
  onPay,
  onHold,
}: {
  cart: Cart;
  setCart: React.Dispatch<React.SetStateAction<Cart>>;
  priced: any;
  error?: string;
  onBump: (i: number, d: 1 | -1) => void;
  onEdit: (i: number) => void;
  onPay: () => void;
  onHold: () => void;
}) {
  const tax = priced ? priced.cgstPaise + priced.sgstPaise + priced.igstPaise + priced.cessPaise : 0;
  return (
    <div className="flex flex-col rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div className="border-b border-stone-100 p-3 dark:border-stone-800">
        <PartyPicker kind="customer" value={cart.partyId} onChange={(id) => setCart((c) => ({ ...c, partyId: id }))} />
      </div>
      <div className="max-h-[45dvh] min-h-32 overflow-y-auto">
        {cart.lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-stone-500">Tap items or scan a barcode to start the bill.</p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {cart.lines.map((l, i) => {
              const pl = priced?.lines?.[i];
              const short = l.track && l.qtyMilli > l.stockMilli;
              return (
                <li key={l.productId} className="flex items-center gap-2 px-3 py-2.5">
                  <button onClick={() => onEdit(i)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="text-xs text-stone-500 tabular-nums">
                      {inr(l.unitPricePaise)} / {l.unit}
                      {l.discountPaise ? ` · −${inr(l.discountPaise)}` : ''}
                      {short ? <span className="ml-1 text-rose-600">· only {qty(l.stockMilli)} left</span> : null}
                    </p>
                  </button>
                  <div className="flex items-center rounded-lg border border-stone-200 dark:border-stone-700">
                    <button onClick={() => onBump(i, -1)} className="p-1.5 text-stone-600" aria-label="Less">
                      <Minus className="size-4" />
                    </button>
                    <button onClick={() => onEdit(i)} className="min-w-9 text-center text-sm font-medium tabular-nums">
                      {qty(l.qtyMilli)}
                    </button>
                    <button onClick={() => onBump(i, 1)} className="p-1.5 text-stone-600" aria-label="More">
                      <Plus className="size-4" />
                    </button>
                  </div>
                  <span className="w-20 text-right text-sm font-medium tabular-nums">{inr(pl?.lineTotalPaise ?? 0)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="space-y-1.5 border-t border-stone-100 p-3 text-sm dark:border-stone-800">
        <div className="flex items-center justify-between gap-2">
          <span className="text-stone-500">Bill discount</span>
          <MoneyInput value={cart.billDiscount} onChange={(e) => setCart((c) => ({ ...c, billDiscount: e.target.value }))} placeholder="0" className="w-28" />
        </div>
        {priced ? (
          <>
            <Row label="Items total" value={inr(priced.subtotalPaise)} />
            {priced.discountPaise ? <Row label="Discount" value={`−${inr(priced.discountPaise)}`} /> : null}
            {tax ? <Row label={`GST${priced.igstPaise ? ' (IGST)' : ' (CGST + SGST)'}`} value={inr(tax)} muted /> : null}
            {priced.roundOffPaise ? <Row label="Round off" value={inr(priced.roundOffPaise)} muted /> : null}
          </>
        ) : null}
        {error ? <p className="text-rose-600">{error}</p> : null}
        <div className="flex items-baseline justify-between pt-1">
          <span className="font-medium">Total</span>
          <span className="text-2xl font-semibold tabular-nums">{inr(priced?.totalPaise ?? 0)}</span>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-2 pt-1">
          <Button icon={Pause} onClick={onHold} disabled={!cart.lines.length} aria-label="Hold bill" />
          <Button variant="primary" size="lg" onClick={onPay} disabled={!priced || !!error}>
            Pay (F9)
          </Button>
        </div>
        {cart.lines.length ? (
          <button onClick={() => setCart(EMPTY)} className="w-full pt-1 text-center text-xs text-stone-500 hover:text-rose-600">
            Clear bill
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={clsx('flex justify-between', muted && 'text-stone-500')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function LineEditor({ line, onClose, onSave, onRemove }: { line: Line | null; onClose: () => void; onSave: (p: Partial<Line>) => void; onRemove: () => void }) {
  const [q, setQ] = useState('');
  const [price, setPrice] = useState('');
  const [disc, setDisc] = useState('');
  useEffect(() => {
    if (line) {
      setQ(String(line.qtyMilli / 1000));
      setPrice(String(line.unitPricePaise / 100));
      setDisc(line.discountPaise ? String(line.discountPaise / 100) : '');
    }
  }, [line]);
  if (!line) return null;
  const qtyMilli = parseQty(q);
  const pricePaise = parseRupees(price);
  const discPaise = disc ? parseRupees(disc) : 0;
  const valid = qtyMilli && qtyMilli > 0 && (line.allowDecimal || qtyMilli % 1000 === 0) && pricePaise !== null && discPaise !== null;
  return (
    <Modal
      open
      onClose={onClose}
      title={line.name}
      size="sm"
      footer={
        <>
          <Button variant="ghost" icon={Trash2} onClick={onRemove} className="mr-auto text-rose-600">
            Remove
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave({ qtyMilli: qtyMilli!, unitPricePaise: pricePaise!, discountPaise: discPaise! })}>
            Update
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={`Quantity (${line.unit})`} hint={line.allowDecimal ? 'Decimals allowed, e.g. 0.25' : 'Whole numbers only'}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} inputMode="decimal" onKeyDown={(e) => e.key === 'Enter' && valid && onSave({ qtyMilli: qtyMilli!, unitPricePaise: pricePaise!, discountPaise: discPaise! })} />
        </Field>
        <Field label={`Price per ${line.unit}`}>
          <MoneyInput value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Discount on this line">
          <MoneyInput value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" />
        </Field>
      </div>
    </Modal>
  );
}

type PayMode = 'cash' | 'upi' | 'card' | 'khata' | 'split';

function PayDialog({
  open,
  onClose,
  totalPaise,
  cart,
  billDiscountPaise,
  upiId,
  upiName,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  totalPaise: number;
  cart: Cart;
  billDiscountPaise: number;
  upiId?: string | null;
  upiName?: string;
  onDone: (r: { docId: string; docNo: string; totalPaise: number; changePaise: number; duePaise: number; warnings: string[] }) => void;
}) {
  const [mode, setMode] = useState<PayMode>('cash');
  const [tendered, setTendered] = useState('');
  const [split, setSplit] = useState({ cash: '', upi: '', card: '' });
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOver, setConfirmOver] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTendered((totalPaise / 100).toString());
      setSplit({ cash: '', upi: '', card: '' });
      setConfirmOver(null);
    }
  }, [open, totalPaise]);
  useEffect(() => {
    if (open && mode === 'upi' && upiId) QRCode.toDataURL(upiLink(upiId, upiName ?? 'Shop', totalPaise, 'ShopOS bill'), { margin: 1, width: 220 }).then(setQr);
  }, [open, mode, upiId, upiName, totalPaise]);

  const tenderedPaise = parseRupees(tendered || '0') ?? 0;
  const splitPaise = { cash: parseRupees(split.cash || '0') ?? 0, upi: parseRupees(split.upi || '0') ?? 0, card: parseRupees(split.card || '0') ?? 0 };
  const splitPaid = splitPaise.cash + splitPaise.upi + splitPaise.card;
  const notes = useMemo(() => {
    const r = Math.ceil(totalPaise / 100);
    const set = new Set([r, Math.ceil(r / 50) * 50, Math.ceil(r / 100) * 100, Math.ceil(r / 500) * 500, Math.ceil(r / 2000) * 2000]);
    return [...set].slice(0, 4);
  }, [totalPaise]);

  function tenders() {
    switch (mode) {
      case 'cash':
        return [{ method: 'cash', amountPaise: Math.max(tenderedPaise, 0) }];
      case 'upi':
        return [{ method: 'upi', amountPaise: totalPaise }];
      case 'card':
        return [{ method: 'card', amountPaise: totalPaise }];
      case 'khata':
        return [];
      case 'split':
        return (['upi', 'card', 'cash'] as const).filter((m) => splitPaise[m] > 0).map((m) => ({ method: m, amountPaise: splitPaise[m] }));
    }
  }

  async function submit(allowOver = false) {
    setBusy(true);
    try {
      const r = await call('issueSale', {
        lines: cart.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise })),
        partyId: cart.partyId,
        billDiscountPaise,
        tenders: tenders(),
        allowOverCreditLimit: allowOver,
      });
      onDone(r);
    } catch (err: any) {
      if (err.code === 'credit_limit') setConfirmOver(err.message);
      else toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const cashShort = mode === 'cash' && tenderedPaise < totalPaise;
  const needsCustomer = (mode === 'khata' || (mode === 'split' && splitPaid < totalPaise) || cashShort) && !cart.partyId;
  const due = mode === 'khata' ? totalPaise : mode === 'split' ? Math.max(0, totalPaise - splitPaid) : mode === 'cash' ? Math.max(0, totalPaise - tenderedPaise) : 0;

  return (
    <Modal open={open} onClose={onClose} title="Payment" size="md">
      <div className="mb-4 text-center">
        <p className="text-sm text-stone-500">Amount to collect</p>
        <p className="text-4xl font-semibold tabular-nums">{inr(totalPaise)}</p>
      </div>
      <div className="mb-4 flex justify-center">
        <Segmented
          value={mode}
          onChange={setMode}
          items={[
            { id: 'cash', label: 'Cash' },
            { id: 'upi', label: 'UPI' },
            { id: 'card', label: 'Card' },
            { id: 'khata', label: 'Khata' },
            { id: 'split', label: 'Split' },
          ]}
        />
      </div>
      {mode === 'cash' && (
        <div className="space-y-3">
          <Field label="Cash received">
            <MoneyInput value={tendered} onChange={(e) => setTendered(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !needsCustomer && submit()} className="text-lg" />
          </Field>
          <div className="flex flex-wrap gap-2">
            {notes.map((n) => (
              <Button key={n} size="sm" onClick={() => setTendered(String(n))}>
                ₹{n.toLocaleString('en-IN')}
              </Button>
            ))}
          </div>
          {tenderedPaise >= totalPaise ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-center text-lg font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              Return change: {inr(tenderedPaise - totalPaise)}
            </p>
          ) : (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-center text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
              {inr(totalPaise - tenderedPaise)} will go on the customer's khata
            </p>
          )}
        </div>
      )}
      {mode === 'upi' && (
        <div className="text-center">
          {upiId ? (
            <>
              {qr ? <img src={qr} alt="UPI QR code" className="mx-auto size-52 rounded-lg bg-white p-2" /> : null}
              <p className="mt-2 text-sm text-stone-500">
                Ask the customer to scan and pay {inr(totalPaise)} to <b>{upiId}</b>. Check your UPI app, then confirm.
              </p>
            </>
          ) : (
            <p className="text-sm text-stone-500">Add your UPI ID in Settings to show a pay QR here.</p>
          )}
        </div>
      )}
      {mode === 'card' && <p className="text-center text-sm text-stone-500">Take the card payment on your card machine, then confirm.</p>}
      {mode === 'khata' && <p className="text-center text-sm text-stone-500">The full amount goes on the customer's khata (credit).</p>}
      {mode === 'split' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(['cash', 'upi', 'card'] as const).map((m) => (
            <Field key={m} label={m.toUpperCase()}>
              <MoneyInput value={split[m]} onChange={(e) => setSplit((x) => ({ ...x, [m]: e.target.value }))} placeholder="0" />
            </Field>
          ))}
          <p className="text-sm text-stone-500 sm:col-span-3">
            Paid {inr(splitPaid)}
            {splitPaid < totalPaise ? ` · ${inr(totalPaise - splitPaid)} on khata` : splitPaid > totalPaise ? ' · change from cash' : ''}
          </p>
        </div>
      )}
      {needsCustomer ? <p className="mt-3 text-center text-sm text-rose-600">Choose a customer on the bill to give credit ({inr(due)}).</p> : null}
      {confirmOver ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {confirmOver}.{' '}
          <button className="font-semibold underline" onClick={() => submit(true)}>
            Sell anyway
          </button>
        </div>
      ) : null}
      <Button variant="primary" size="lg" className="mt-5 w-full" loading={busy} disabled={needsCustomer} onClick={() => submit()}>
        <CheckCircle2 className="size-5" /> Complete bill
      </Button>
    </Modal>
  );
}

function DoneDialog({ done, onClose }: { done: null | { docId: string; docNo: string; totalPaise: number; changePaise: number; duePaise: number }; onClose: () => void }) {
  const nav = useNavigate();
  const { data: sale } = useQ('getSale', [done?.docId ?? ''], { enabled: !!done });
  useHotkey('Enter', () => done && onClose(), [done]);
  if (!done) return null;
  const phone = sale?.doc.party_phone;
  const share = () => {
    if (!sale) return;
    const text = billMessage({
      shop: sale.business?.name ?? 'Shop',
      docNo: sale.doc.doc_no,
      date: fmtDate(sale.doc.business_date),
      total: sale.doc.total_paise,
      due: sale.doc.due_paise,
      lines: sale.lines.map((l) => ({ name: l.name, qty: qty(l.qty_milli, l.unit), amount: l.line_total_paise })),
    });
    window.open(whatsappLink(phone, text), '_blank', 'noopener');
  };
  return (
    <Modal open onClose={onClose} title="Bill saved" size="sm">
      <div className="text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <p className="mt-2 font-mono text-sm text-stone-500">{done.docNo}</p>
        <p className="text-3xl font-semibold tabular-nums">{inr(done.totalPaise)}</p>
        {done.changePaise ? <p className="mt-2 text-lg font-semibold text-emerald-700">Give change {inr(done.changePaise)}</p> : null}
        {done.duePaise ? <Badge tone="amber" className="mt-2">{inr(done.duePaise)} on khata</Badge> : null}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button icon={Printer} onClick={() => nav(`/sales/${done.docId}?print=1`)}>
          Print
        </Button>
        <Button icon={Send} onClick={share}>
          WhatsApp
        </Button>
        <Button variant="primary" className="col-span-2" onClick={onClose}>
          Next bill (Enter)
        </Button>
      </div>
    </Modal>
  );
}
