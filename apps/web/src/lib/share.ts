import { formatINR } from '@shopos/core';

/** UPI deep link (NPCI format). Generated offline; any UPI app can scan it. */
export function upiLink(upiId: string, payee: string, amountPaise: number, note?: string) {
  const params = new URLSearchParams({ pa: upiId, pn: payee, am: (amountPaise / 100).toFixed(2), cu: 'INR' });
  if (note) params.set('tn', note.slice(0, 60));
  return `upi://pay?${params.toString()}`;
}

/** wa.me link. Indian 10-digit numbers get the 91 country code. */
export function whatsappLink(phone: string | null | undefined, text: string) {
  const digits = (phone ?? '').replace(/\D/g, '');
  const to = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export function billMessage(o: { shop: string; docNo: string; date: string; total: number; due: number; lines: { name: string; qty: string; amount: number }[] }) {
  const items = o.lines.map((l) => `• ${l.name} × ${l.qty} = ${formatINR(l.amount)}`).join('\n');
  return [
    `*${o.shop}*`,
    `Bill ${o.docNo} · ${o.date}`,
    items,
    `*Total: ${formatINR(o.total)}*`,
    o.due > 0 ? `Balance due: ${formatINR(o.due)}` : 'Paid in full. Thank you!',
  ].join('\n');
}

export function reminderMessage(o: { shop: string; name: string; due: number; upiId?: string | null }) {
  const lines = [`Namaste ${o.name}, this is a friendly reminder from ${o.shop}.`, `Your balance due is *${formatINR(o.due)}*.`];
  if (o.upiId) lines.push(`Pay by UPI to ${o.upiId}: ${upiLink(o.upiId, o.shop, o.due, 'Khata payment')}`);
  lines.push('Thank you!');
  return lines.join('\n');
}
