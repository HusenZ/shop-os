import { allocate, divRound, lineAmount } from './money';

export type GstScheme = 'none' | 'composition' | 'regular';
export type PriceMode = 'inclusive' | 'exclusive';
export type SaleDocType = 'tax_invoice' | 'bill_of_supply' | 'invoice_cum_bos' | 'cash_memo';

export interface CartLineInput {
  productId: string;
  name: string;
  hsn?: string | null;
  unit: string;
  qtyMilli: number;
  unitPricePaise: number;
  discountPaise?: number;
  gstRateBp: number;
  cessRateBp?: number;
}

export interface PricingContext {
  scheme: GstScheme;
  priceMode: PriceMode;
  interState: boolean;
  roundOff: boolean;
  billDiscountPaise?: number;
  buyerRegistered?: boolean;
}

export interface PricedLine extends CartLineInput {
  grossPaise: number;
  lineDiscountPaise: number;
  billDiscountPaise: number;
  netPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  taxPaise: number;
  lineTotalPaise: number;
  /** GST rate actually charged (0 when the scheme collects no tax). */
  appliedRateBp: number;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  docType: SaleDocType;
}

export class PricingError extends Error {}

/** Tax on one line, given its net amount (after all discounts). */
export function taxLine(
  netPaise: number,
  gstRateBp: number,
  cessRateBp: number,
  ctx: Pick<PricingContext, 'scheme' | 'priceMode' | 'interState'>,
) {
  if (ctx.scheme !== 'regular' || (gstRateBp === 0 && cessRateBp === 0)) {
    return { taxablePaise: netPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, lineTotalPaise: netPaise, appliedRateBp: 0 };
  }
  let taxable =
    ctx.priceMode === 'inclusive' ? divRound(netPaise * 10000, 10000 + gstRateBp + cessRateBp) : netPaise;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (ctx.interState) igst = divRound(taxable * gstRateBp, 10000);
  else {
    cgst = divRound(taxable * gstRateBp, 20000);
    sgst = cgst;
  }
  const cess = divRound(taxable * cessRateBp, 10000);
  if (ctx.priceMode === 'inclusive') {
    // Keep the shelf price exact: the taxable value absorbs the rounding paisa.
    taxable = netPaise - cgst - sgst - igst - cess;
  }
  const lineTotal = taxable + cgst + sgst + igst + cess;
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, cessPaise: cess, lineTotalPaise: lineTotal, appliedRateBp: gstRateBp };
}

export function chooseDocType(scheme: GstScheme, lines: { appliedRateBp: number; gstRateBp: number }[], buyerRegistered = false): SaleDocType {
  if (scheme === 'none') return 'cash_memo';
  if (scheme === 'composition') return 'bill_of_supply';
  const taxable = lines.filter((l) => l.gstRateBp > 0).length;
  if (taxable === 0) return 'bill_of_supply';
  if (taxable === lines.length) return 'tax_invoice';
  return buyerRegistered ? 'tax_invoice' : 'invoice_cum_bos';
}

export function priceCart(input: CartLineInput[], ctx: PricingContext): PricedCart {
  if (input.length === 0) throw new PricingError('The bill has no items');
  const gross = input.map((l) => {
    if (!Number.isInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new PricingError(`Quantity for ${l.name} must be more than zero`);
    if (!Number.isInteger(l.unitPricePaise) || l.unitPricePaise < 0) throw new PricingError(`Price for ${l.name} is invalid`);
    const g = lineAmount(l.unitPricePaise, l.qtyMilli);
    const d = l.discountPaise ?? 0;
    if (d < 0 || d > g) throw new PricingError(`Discount on ${l.name} is more than the line amount`);
    return { g, d };
  });
  const afterLine = gross.map((x) => x.g - x.d);
  const billDiscount = ctx.billDiscountPaise ?? 0;
  const afterLineTotal = afterLine.reduce((s, v) => s + v, 0);
  if (billDiscount < 0 || billDiscount > afterLineTotal) throw new PricingError('Bill discount is more than the bill amount');
  const billShares = allocate(billDiscount, afterLine);

  const lines: PricedLine[] = input.map((l, i) => {
    const net = afterLine[i] - billShares[i];
    const t = taxLine(net, l.gstRateBp, l.cessRateBp ?? 0, ctx);
    return {
      ...l,
      discountPaise: l.discountPaise ?? 0,
      cessRateBp: l.cessRateBp ?? 0,
      grossPaise: gross[i].g,
      lineDiscountPaise: gross[i].d,
      billDiscountPaise: billShares[i],
      netPaise: net,
      ...t,
      taxPaise: t.cgstPaise + t.sgstPaise + t.igstPaise + t.cessPaise,
    };
  });

  const sum = (k: keyof PricedLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const linesTotal = sum('lineTotalPaise');
  const roundOff = ctx.roundOff ? Math.round(linesTotal / 100) * 100 - linesTotal : 0;
  return {
    lines,
    subtotalPaise: sum('grossPaise'),
    discountPaise: sum('lineDiscountPaise') + billDiscount,
    taxablePaise: sum('taxablePaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    cessPaise: sum('cessPaise'),
    taxPaise: sum('taxPaise'),
    roundOffPaise: roundOff,
    totalPaise: linesTotal + roundOff,
    docType: chooseDocType(ctx.scheme, lines, ctx.buyerRegistered),
  };
}

/** GSTIN format check (15 chars, state code + PAN + entity + Z + checksum char). */
export function isValidGstin(gstin: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin.trim().toUpperCase());
}

export function gstinState(gstin?: string | null): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

export const INDIAN_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

/** Seeded GST slabs. Rates are data (editable per product), never hard-coded in posting. */
export const GST_RATES_BP = [0, 300, 500, 1200, 1800, 2800, 4000];
