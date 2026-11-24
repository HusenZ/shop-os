import { Camera, Plus, Search, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inr, qty } from '../lib/format';
import { useAct, useDebounced, useQ } from '../lib/hooks';
import { Button, Field, Input, Modal, clsx } from './ui';

/** Search-as-you-type party picker with inline "add new". */
export function PartyPicker({
  kind,
  value,
  onChange,
  placeholder,
}: {
  kind: 'customer' | 'supplier';
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const dq = useDebounced(q, 120);
  const { data: list = [] } = useQ('listParties', [{ kind, q: dq, limit: 8 }], { enabled: open });
  const { data: selected } = useQ('getParty', [value ?? ''], { enabled: !!value });

  if (value && selected) {
    const p = selected.party;
    const bal = kind === 'customer' ? p.receivable_paise : p.payable_paise;
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-600/40 bg-brand-50 px-3 py-2 dark:bg-brand-900/20">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{p.name}</p>
          <p className="truncate text-xs text-stone-500">
            {p.phone ?? 'No phone'}
            {bal ? ` · ${kind === 'customer' ? 'owes' : 'you owe'} ${inr(bal)}` : ''}
            {p.credit_limit_paise ? ` · limit ${inr(p.credit_limit_paise, true)}` : ''}
          </p>
        </div>
        <button onClick={() => onChange(null)} className="rounded p-1 text-stone-500 hover:bg-white dark:hover:bg-stone-800" aria-label="Remove">
          <X className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? (kind === 'customer' ? 'Customer name or phone (optional)' : 'Supplier')}
        className="pl-9"
      />
      {open ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
          {list.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(p.id);
                setQ('');
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800"
            >
              <span className="truncate">
                {p.name} <span className="text-stone-500">{p.phone}</span>
              </span>
              {kind === 'customer' && p.receivable_paise ? <span className="text-xs text-amber-700">{inr(p.receivable_paise)}</span> : null}
            </button>
          ))}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setAdding(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 border-t border-stone-100 px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800"
          >
            <Plus className="size-4" /> Add {kind} {q ? `“${q}”` : ''}
          </button>
        </div>
      ) : null}
      <QuickParty
        open={adding}
        kind={kind}
        initial={q}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          onChange(id);
          setQ('');
          setAdding(false);
        }}
      />
    </div>
  );
}

function QuickParty({ open, kind, initial, onClose, onCreated }: { open: boolean; kind: string; initial: string; onClose: () => void; onCreated: (id: string) => void }) {
  const act = useAct();
  const isPhone = /^\d[\d\s]{5,}$/.test(initial.trim());
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
  useEffect(() => {
    if (open) {
      setName(isPhone ? '' : initial);
      setPhone(isPhone ? initial : '');
      setGstin('');
    }
  }, [open, initial, isPhone]);
  async function save() {
    const id = await act.run('createParty', [{ kind, name, phone, gstin: gstin || undefined }], `${kind === 'customer' ? 'Customer' : 'Supplier'} added`);
    onCreated(id);
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New ${kind}`}
      size="sm"
      footer={
        <Button variant="primary" onClick={save} loading={act.pending} disabled={!name.trim()}>
          Add
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label="GSTIN (for B2B bills)">
          <Input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} />
        </Field>
      </div>
    </Modal>
  );
}

export interface PickedProduct {
  id: string;
  name: string;
  unit: string;
  price_paise: number;
  cost_paise: number;
  gst_rate_bp: number;
  allow_decimal: number;
  track_stock: number;
  stock_milli: number;
  avg_cost_paise: number;
}

/** Search box that adds a product (used by purchases and transfers). */
export function ProductSearch({ onPick, placeholder }: { onPick: (p: PickedProduct) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 100);
  const { data: list = [] } = useQ('listProducts', [{ q: dq, limit: 10 }], { enabled: open && dq.length > 0 });
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) {
            onPick(list[0] as PickedProduct);
            setQ('');
          }
        }}
        placeholder={placeholder ?? 'Search item name or scan barcode'}
        className="pl-9"
      />
      {open && list.length ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
          {list.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(p as PickedProduct);
                setQ('');
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800"
            >
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-xs text-stone-500">
                {p.track_stock ? qty(p.stock_milli, p.unit) : ''} · {inr(p.price_paise)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Camera barcode scanning with the browser's BarcodeDetector (Chrome/Edge on Android, desktop Chrome). */
export function CameraScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const BD = (window as any).BarcodeDetector;
    if (!BD) {
      setError('Camera scanning is not supported in this browser. Use a USB scanner or type the code.');
      return;
    }
    const detector = new BD({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          video.current.play();
        }
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue) {
              onCode(codes[0].rawValue);
              onClose();
            }
          } catch {
            /* frame not ready */
          }
        }, 300);
      })
      .catch(() => setError('Camera permission was denied.'));
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, onClose, onCode]);
  return (
    <Modal open={open} onClose={onClose} title="Scan barcode" size="sm">
      {error ? <p className="text-sm text-stone-600">{error}</p> : <video ref={video} className="aspect-[4/3] w-full rounded-lg bg-black object-cover" muted playsInline />}
    </Modal>
  );
}

export function ScanButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Button icon={Camera} onClick={onClick} className={clsx(className)} aria-label="Scan with camera">
      <span className="hidden sm:inline">Scan</span>
    </Button>
  );
}
