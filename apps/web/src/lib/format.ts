import { addDays, formatINR, formatQty, fyRange, localDate } from '@shopos/core';

export { addDays, formatINR, formatQty, localDate };

export const inr = (p: number | null | undefined, whole = false) => formatINR(p ?? 0, { whole });
export const qty = (milli: number | null | undefined, unit?: string) => `${formatQty(milli ?? 0)}${unit ? ` ${unit}` : ''}`;
export const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toFixed(1).replace(/\.0$/, '')}%`;

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function fmtDate(d: string | null | undefined, short = false) {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  return (short ? shortFmt : dateFmt).format(new Date(y, m - 1, day));
}

export function fmtTime(ms: number | null | undefined) {
  return ms ? timeFmt.format(new Date(ms)) : '—';
}

export function ago(ms: number | null | undefined) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const today = () => localDate();

export type PeriodKey = 'today' | 'yesterday' | '7d' | 'month' | 'last_month' | 'fy' | 'custom';

export function periodRange(key: PeriodKey, custom?: { from: string; to: string }): { from: string; to: string } {
  const t = localDate();
  const [y, m] = t.split('-').map(Number);
  switch (key) {
    case 'today':
      return { from: t, to: t };
    case 'yesterday':
      return { from: addDays(t, -1), to: addDays(t, -1) };
    case '7d':
      return { from: addDays(t, -6), to: t };
    case 'month':
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: t };
    case 'last_month': {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastEnd = addDays(first, -1);
      return { from: `${lastEnd.slice(0, 7)}-01`, to: lastEnd };
    }
    case 'fy':
      return fyRange(t);
    default:
      return custom ?? { from: t, to: t };
  }
}

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'fy', label: 'This financial year' },
  { key: 'custom', label: 'Custom' },
];

export function downloadBytes(bytes: Uint8Array | string, name: string, type = 'application/octet-stream') {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string; money?: boolean }[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.money ? ((Number(r[c.key] ?? 0) / 100).toFixed(2)) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}

export const METHOD_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', khata: 'Khata' };

export const DOC_TITLE: Record<string, string> = {
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
  invoice_cum_bos: 'Invoice-cum-bill of supply',
  cash_memo: 'Cash memo',
  credit_note: 'Credit note',
};
