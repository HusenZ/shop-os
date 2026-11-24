import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  canonicalJson,
  chooseDocType,
  divRound,
  fyLabel,
  fyRange,
  formatINR,
  formatQty,
  HlcClock,
  isValidGstin,
  parseQty,
  parseRupees,
  priceCart,
  taxLine,
  uuidv7,
} from '../src';

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(1, 3)).toBe(0);
    expect(divRound(2, 3)).toBe(1);
  });

  it('allocates exactly, never losing a paisa', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 12 }), (total, weights) => {
        const parts = allocate(total, weights);
        expect(parts.reduce((s, v) => s + v, 0)).toBe(total);
        expect(parts.every((p) => p >= 0)).toBe(true);
      }),
    );
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('parses rupees and quantities without floats', () => {
    expect(parseRupees('1,234.5')).toBe(123450);
    expect(parseRupees('₹ 12')).toBe(1200);
    expect(parseRupees('0.07')).toBe(7);
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('1.234')).toBeNull();
    expect(parseQty('1.25')).toBe(1250);
    expect(parseQty('3')).toBe(3000);
    expect(parseQty('0.005')).toBe(5);
    expect(formatQty(1250)).toBe('1.25');
    expect(formatQty(3000)).toBe('3');
    expect(formatINR(12345650)).toBe('₹1,23,456.50');
  });

  it('labels Indian financial years', () => {
    expect(fyLabel('2026-11-24')).toBe('2627');
    expect(fyLabel('2027-03-31')).toBe('2627');
    expect(fyLabel('2027-04-01')).toBe('2728');
    expect(fyRange('2026-11-24')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
});

describe('tax engine', () => {
  const regular = { scheme: 'regular' as const, priceMode: 'inclusive' as const, interState: false, roundOff: false };

  it('extracts 18% GST from an inclusive price, split into CGST and SGST', () => {
    const t = taxLine(118000, 1800, 0, regular);
    expect(t).toMatchObject({ taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, lineTotalPaise: 118000 });
  });

  it('adds GST to an exclusive price and uses IGST across states', () => {
    const t = taxLine(100000, 1800, 0, { ...regular, priceMode: 'exclusive', interState: true });
    expect(t).toMatchObject({ taxablePaise: 100000, igstPaise: 18000, cgstPaise: 0, lineTotalPaise: 118000 });
  });

  it('collects no tax for composition or non-GST shops', () => {
    expect(taxLine(118000, 1800, 0, { ...regular, scheme: 'composition' }).lineTotalPaise).toBe(118000);
    expect(taxLine(118000, 1800, 0, { ...regular, scheme: 'none' }).cgstPaise).toBe(0);
  });

  it('inclusive lines always total exactly the shelf price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.constantFrom(0, 300, 500, 1200, 1800, 2800, 4000),
        fc.constantFrom(0, 0, 100, 1200),
        fc.boolean(),
        (net, rate, cess, inter) => {
          const t = taxLine(net, rate, cess, { ...regular, interState: inter });
          expect(t.lineTotalPaise).toBe(net);
          expect(t.cgstPaise).toBe(t.sgstPaise);
          expect(t.taxablePaise).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('prices a cart with line + bill discounts and round-off', () => {
    const cart = priceCart(
      [
        { productId: 'a', name: 'Rice', unit: 'pcs', qtyMilli: 2000, unitPricePaise: 12000, gstRateBp: 500, discountPaise: 1000 },
        { productId: 'b', name: 'Sugar', unit: 'kg', qtyMilli: 1500, unitPricePaise: 4630, gstRateBp: 500 },
        { productId: 'c', name: 'Milk', unit: 'pcs', qtyMilli: 1000, unitPricePaise: 3000, gstRateBp: 0 },
      ],
      { ...regular, roundOff: true, billDiscountPaise: 500 },
    );
    expect(cart.subtotalPaise).toBe(24000 + 6945 + 3000);
    expect(cart.discountPaise).toBe(1500);
    const lineSum = cart.lines.reduce((s, l) => s + l.lineTotalPaise, 0);
    expect(lineSum).toBe(cart.subtotalPaise - cart.discountPaise);
    expect(cart.totalPaise % 100).toBe(0);
    expect(Math.abs(cart.roundOffPaise)).toBeLessThanOrEqual(50);
    expect(cart.docType).toBe('invoice_cum_bos');
  });

  it('chooses the document type from the registration', () => {
    const taxed = [{ gstRateBp: 1800, appliedRateBp: 1800 }];
    const exempt = [{ gstRateBp: 0, appliedRateBp: 0 }];
    expect(chooseDocType('none', taxed)).toBe('cash_memo');
    expect(chooseDocType('composition', taxed)).toBe('bill_of_supply');
    expect(chooseDocType('regular', taxed)).toBe('tax_invoice');
    expect(chooseDocType('regular', exempt)).toBe('bill_of_supply');
    expect(chooseDocType('regular', [...taxed, ...exempt], true)).toBe('tax_invoice');
  });

  it('rejects bad carts', () => {
    expect(() => priceCart([], regular)).toThrow(/no items/);
    expect(() => priceCart([{ productId: 'a', name: 'X', unit: 'pcs', qtyMilli: 0, unitPricePaise: 100, gstRateBp: 0 }], regular)).toThrow(/more than zero/);
    expect(() => priceCart([{ productId: 'a', name: 'X', unit: 'pcs', qtyMilli: 1000, unitPricePaise: 100, gstRateBp: 0, discountPaise: 200 }], regular)).toThrow(/Discount/);
  });

  it('validates GSTINs', () => {
    expect(isValidGstin('27AAAPL1234C1Z5')).toBe(true);
    expect(isValidGstin('27AAAPL1234C1X5')).toBe(false);
    expect(isValidGstin('123')).toBe(false);
  });
});

describe('clocks, ids and hashing', () => {
  it('HLC ticks strictly increase and survive a clock going backwards', () => {
    let now = 1_000_000;
    const c = new HlcClock('dev', null, () => now);
    const a = c.tick();
    now = 500_000;
    const b = c.tick();
    const d = c.tick();
    expect(a < b && b < d).toBe(true);
  });

  it('HLC receive moves past remote timestamps', () => {
    const c = new HlcClock('a', null, () => 1000);
    c.receive('000000000005000-0007-b');
    expect(c.tick() > '000000000005000-0007-b').toBe(true);
  });

  it('UUIDv7 values are unique and time-ordered', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('canonical JSON sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: 'x', z: undefined }, e: [3, 'ä'] })).toBe('{"a":{"c":"x","d":null},"b":1,"e":[3,"ä"]}');
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/floats/);
  });
});
