import clsx from 'clsx';
import { Loader2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export { clsx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm disabled:bg-brand-700/50',
  secondary: 'bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 dark:bg-stone-800 dark:text-stone-100 dark:border-stone-700 dark:hover:bg-stone-700',
  ghost: 'text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
};
const SIZES = { sm: 'h-8 px-2.5 text-sm gap-1.5', md: 'h-10 px-3.5 text-sm gap-2', lg: 'h-12 px-5 text-base gap-2' };

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" aria-hidden /> : null}
      {children}
    </button>
  );
}

const fieldBase =
  'w-full rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:disabled:bg-stone-800';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input {...rest} className={clsx(fieldBase, 'h-10', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx(fieldBase, 'py-2', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx(fieldBase, 'h-10 pr-8', className)}>
      {children}
    </select>
  );
}

/** Rupee amount typed as text (parsed to paise by the caller with parseRupees). */
export function MoneyInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={clsx('relative', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-stone-500">₹</span>
      <Input inputMode="decimal" autoComplete="off" {...rest} className="pl-7 tabular-nums" />
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      <span className="text-sm font-medium text-stone-700 dark:text-stone-300">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-stone-500 dark:text-stone-400">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition', checked ? 'bg-brand-700' : 'bg-stone-300 dark:bg-stone-600')}
      >
        <span className={clsx('absolute top-0.5 size-5 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      <span>
        <span className="block text-sm font-medium text-stone-800 dark:text-stone-200">{label}</span>
        {hint ? <span className="block text-xs text-stone-500">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Card({ className, children, padded = true }: { className?: string; children: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx('rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900', padded && 'p-4 sm:p-5', className)}>
      {children}
    </section>
  );
}

export function CardTitle({ children, action, sub }: { children: ReactNode; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{children}</h2>
        {sub ? <p className="text-sm text-stone-500 dark:text-stone-400">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-stone-900 sm:text-2xl dark:text-stone-50">{title}</h1>
        {sub ? <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

type Tone = 'neutral' | 'brand' | 'green' | 'red' | 'amber' | 'blue';
const TONES: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  brand: 'bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  red: 'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

export function Stat({ label, value, sub, icon: Icon, tone = 'neutral' }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon; tone?: Tone }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm text-stone-500 dark:text-stone-400">{label}</p>
        {Icon ? (
          <span className={clsx('rounded-lg p-1.5', TONES[tone])}>
            <Icon className="size-4" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className="mt-2 truncate text-2xl font-semibold tabular-nums tracking-tight text-stone-900 dark:text-stone-50">{value}</p>
      {sub ? <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{sub}</p> : null}
    </Card>
  );
}

export function Empty({ icon: Icon, title, text, action }: { icon?: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      {Icon ? <Icon className="size-10 text-stone-300 dark:text-stone-600" aria-hidden /> : null}
      <p className="font-medium text-stone-800 dark:text-stone-200">{title}</p>
      {text ? <p className="max-w-sm text-sm text-stone-500">{text}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-stone-500">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function Tabs<T extends string>({ items, value, onChange, className }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx('-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1', className)} role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={clsx(
            'h-9 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition',
            value === it.id ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'text-stone-600 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('-mx-4 overflow-x-auto sm:mx-0', className)}>
      <table className="w-full min-w-max border-collapse text-sm [&_td]:border-t [&_td]:border-stone-100 [&_td]:px-3 [&_td]:py-2.5 dark:[&_td]:border-stone-800 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:tracking-wide [&_th]:text-stone-500 [&_th]:uppercase">
        {children}
      </table>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea')?.focus(), 30);
    return () => {
      window.removeEventListener('keydown', h);
      clearTimeout(t);
    };
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-stone-950/50 backdrop-blur-[1px]" onClick={onClose} />
      <div ref={ref} className={clsx('relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-stone-900', widths[size])}>
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3.5 dark:border-stone-800">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-stone-100 px-5 py-3 dark:border-stone-800">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Segmented<T extends string>({ items, value, onChange }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5 dark:border-stone-700 dark:bg-stone-900">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={clsx('h-8 rounded-md px-3 text-sm font-medium transition', value === it.id ? 'bg-brand-700 text-white' : 'text-stone-600 hover:text-stone-900 dark:text-stone-300')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Money({ paise, className, colored }: { paise: number | null | undefined; className?: string; colored?: boolean }) {
  const v = paise ?? 0;
  return (
    <span className={clsx('tabular-nums', colored && (v < 0 ? 'text-rose-600' : v > 0 ? 'text-emerald-700 dark:text-emerald-400' : ''), className)}>
      {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(v / 100)}
    </span>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-stone-100 text-sm dark:divide-stone-800">
      {items.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-4 py-2">
          <dt className="text-stone-500">{k}</dt>
          <dd className="text-right font-medium text-stone-900 dark:text-stone-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
