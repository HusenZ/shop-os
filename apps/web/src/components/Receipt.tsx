import { INDIAN_STATES } from '@shopos/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { DOC_TITLE, fmtDate, inr, METHOD_LABEL, qty } from '../lib/format';
import { upiLink } from '../lib/share';
import { clsx } from './ui';

/** Printable bill: thermal (58/80 mm) or A4. Shows the GST fields the document type needs. */
export function Receipt({ sale, width = '80mm' }: { sale: any; width?: string }) {
  const { doc, lines, payments, business, branch, voided, original } = sale;
  const thermal = width !== 'A4';
  const [qr, setQr] = useState('');
  const showQr = doc.due_paise > 0 && branch?.upi_id && doc.doc_type !== 'credit_note';
  useEffect(() => {
    if (showQr) QRCode.toDataURL(upiLink(branch.upi_id, branch.upi_name || business.name, doc.due_paise, doc.doc_no), { margin: 1, width: 160 }).then(setQr);
  }, [showQr, branch, business, doc]);
  const taxed = doc.cgst_paise || doc.sgst_paise || doc.igst_paise || doc.cess_paise;
  const title = DOC_TITLE[doc.doc_type] ?? 'Bill';
  const pay = (payments as any[]).filter((p) => p.direction === 'in');

  return (
    <div
      className={clsx(
        'print-area mx-auto bg-white text-[13px] leading-snug text-black shadow-sm',
        thermal ? 'w-thermal max-w-[340px] p-4 font-mono text-[12px]' : 'max-w-3xl p-8',
      )}
    >
      <div className="text-center">
        <p className={clsx('font-bold', thermal ? 'text-base' : 'text-xl')}>{business?.name}</p>
        {branch?.address ? <p>{branch.address}</p> : null}
        {branch?.phone ? <p>Ph: {branch.phone}</p> : null}
        {branch?.gstin ? <p>GSTIN: {branch.gstin}</p> : null}
        <p className="mt-2 font-bold tracking-wide uppercase">{title}</p>
        {business?.gst_scheme === 'composition' ? <p className="text-[11px]">Composition taxable person, not eligible to collect tax on supplies</p> : null}
        {voided ? <p className="mt-1 font-bold text-red-600">*** CANCELLED ***</p> : null}
      </div>
      <div className="my-2 border-t border-dashed border-black" />
      <div className="flex justify-between gap-2">
        <span>No: {doc.doc_no}</span>
        <span>{fmtDate(doc.business_date)}</span>
      </div>
      {original ? <p>Against bill {original.doc_no}</p> : null}
      {doc.party_name ? (
        <p>
          To: {doc.party_name}
          {doc.party_phone ? ` · ${doc.party_phone}` : ''}
        </p>
      ) : null}
      {doc.party_gstin ? <p>Buyer GSTIN: {doc.party_gstin}</p> : null}
      {taxed ? <p>Place of supply: {INDIAN_STATES[doc.place_of_supply] ?? doc.place_of_supply}</p> : null}
      <div className="my-2 border-t border-dashed border-black" />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className="pb-1 font-semibold">Item</th>
            <th className="pb-1 text-right font-semibold">Qty</th>
            {!thermal ? <th className="pb-1 text-right font-semibold">Rate</th> : null}
            {!thermal && taxed ? <th className="pb-1 text-right font-semibold">GST</th> : null}
            <th className="pb-1 text-right font-semibold">Amt</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any) => (
            <tr key={l.id} className="align-top">
              <td className="py-0.5 pr-1">
                {l.name}
                {l.hsn && taxed ? <span className="block text-[10px]">HSN {l.hsn}{thermal && l.gst_rate_bp ? ` · GST ${l.gst_rate_bp / 100}%` : ''}</span> : null}
                {thermal ? <span className="block text-[10px]">@ {inr(l.unit_price_paise)}{l.discount_paise ? ` − ${inr(l.discount_paise)}` : ''}</span> : null}
              </td>
              <td className="py-0.5 text-right whitespace-nowrap">{qty(l.qty_milli, thermal ? '' : l.unit)}</td>
              {!thermal ? <td className="py-0.5 text-right">{inr(l.unit_price_paise)}</td> : null}
              {!thermal && taxed ? <td className="py-0.5 text-right">{l.gst_rate_bp / 100}%</td> : null}
              <td className="py-0.5 text-right">{inr(l.line_total_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="my-2 border-t border-dashed border-black" />
      <div className="space-y-0.5">
        {doc.discount_paise ? <Line label="Discount" value={`−${inr(doc.discount_paise)}`} /> : null}
        {taxed ? <Line label="Taxable value" value={inr(doc.taxable_paise)} /> : null}
        {doc.cgst_paise ? <Line label="CGST" value={inr(doc.cgst_paise)} /> : null}
        {doc.sgst_paise ? <Line label="SGST" value={inr(doc.sgst_paise)} /> : null}
        {doc.igst_paise ? <Line label="IGST" value={inr(doc.igst_paise)} /> : null}
        {doc.cess_paise ? <Line label="Cess" value={inr(doc.cess_paise)} /> : null}
        {doc.round_off_paise ? <Line label="Round off" value={inr(doc.round_off_paise)} /> : null}
        <div className={clsx('flex justify-between font-bold', thermal ? 'text-sm' : 'text-lg')}>
          <span>TOTAL</span>
          <span>{inr(doc.total_paise)}</span>
        </div>
        {pay.map((p: any) => (
          <Line key={p.id} label={`Paid · ${METHOD_LABEL[p.method] ?? p.method}`} value={inr(p.tendered_paise || p.amount_paise)} />
        ))}
        {pay.some((p: any) => p.change_paise) ? <Line label="Change" value={inr(pay.reduce((s: number, p: any) => s + (p.change_paise || 0), 0))} /> : null}
        {doc.due_paise ? <Line label="Balance due (khata)" value={inr(doc.due_paise)} bold /> : null}
      </div>
      {qr ? (
        <div className="mt-3 text-center">
          <img src={qr} alt="UPI QR" className="mx-auto size-32" />
          <p className="text-[11px]">Scan to pay {inr(doc.due_paise)} · {branch.upi_id}</p>
        </div>
      ) : null}
      <div className="my-2 border-t border-dashed border-black" />
      <p className="text-center">{branch?.receipt_footer || 'Thank you! Visit again.'}</p>
      <p className="mt-1 text-center text-[10px] text-stone-500">Billed with ShopOS</p>
    </div>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={clsx('flex justify-between', bold && 'font-bold')}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
