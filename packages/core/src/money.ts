/**
 * Money is always integer paise. Quantities are integer thousandths of a unit
 * (qty_milli). Rates are basis points (18% = 1800). No floats in the ledger.
 */

/** Integer division rounded half away from zero. */
export function divRound(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  const sign = Math.sign(a) * Math.sign(b);
  const A = Math.abs(a);
  const B = Math.abs(b);
  return sign * Math.floor((2 * A + B) / (2 * B));
}

/** Splits `total` across `weights` exactly (largest-remainder method). */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (total < 0) return allocate(-total, weights).map((v) => -v);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w, i) => {
    const num = T * BigInt(w);
    return { i, q: num / S, r: num % S };
  });
  const out = parts.map((p) => Number(p.q));
  let rem = total - out.reduce((s, v) => s + v, 0);
  const order = [...parts].sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; rem > 0; k = (k + 1) % order.length, rem--) out[order[k].i]++;
  return out;
}

/** Line amount for a quantity: unit price × qty_milli / 1000, rounded. */
export function lineAmount(unitPaise: number, qtyMilli: number): number {
  return divRound(unitPaise * qtyMilli, 1000);
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatINR(paise: number, opts: { whole?: boolean } = {}): string {
  const value = paise / 100;
  return opts.whole ? inr0.format(Math.round(value)) : inr.format(value);
}

/** "1,234.50" or "₹ 12" → paise, without floating point. Returns null when invalid. */
export function parseRupees(input: string | number): number | null {
  const s = String(input).replace(/[₹,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '-' || s === '.') return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -paise : paise;
}

/** "1.25" → 1250 milli. Returns null when invalid. */
export function parseQty(input: string | number): number | null {
  const s = String(input).replace(/[,\s]/g, '');
  if (!/^\d*(\.\d{0,3})?$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole || '0') * 1000 + Number(frac.padEnd(3, '0'));
}

export function formatQty(milli: number): string {
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const frac = abs % 1000;
  const fracStr = frac ? '.' + String(frac).padStart(3, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole.toLocaleString('en-IN')}${fracStr}`;
}

export function formatRate(bp: number): string {
  return `${bp / 100}%`;
}

/** Local calendar date (YYYY-MM-DD) for a timestamp. */
export function localDate(ms: number = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

/** Financial-year label, e.g. 2026-11-24 with April start → "2627". */
export function fyLabel(date: string, fyStartMonth = 4): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= fyStartMonth ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

export function fyRange(date: string, fyStartMonth = 4): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const start = m >= fyStartMonth ? y : y - 1;
  const from = `${start}-${String(fyStartMonth).padStart(2, '0')}-01`;
  const to = addDays(`${start + 1}-${String(fyStartMonth).padStart(2, '0')}-01`, -1);
  return { from, to };
}
