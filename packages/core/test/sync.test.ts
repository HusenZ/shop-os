import { describe, expect, it } from 'vitest';
import { applyRemoteOps, hashOp, MemoryHub, pendingOps, syncOnce, type ShopEngine } from '../src';
import { digest, newEngine, newShop } from './helpers';

/** A device whose clock we control. */
function clock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function joinDevice(hub: MemoryHub, series: string, now: () => number) {
  const ctx = await newEngine({ now });
  ctx.e.setMeta('series_code', series);
  await syncOnce(ctx.e, hub.transport(ctx.e.deviceId));
  const adopted = ctx.api.adoptSyncedShop();
  expect(adopted.businessId).toBeTruthy();
  return ctx;
}

const sync = (e: ShopEngine, hub: MemoryHub) => syncOnce(e, hub.transport(e.deviceId));

describe('conflict-free sync', () => {
  it('a second device joins and sees the same shop', async () => {
    const hub = new MemoryHub();
    const ca = clock(1_790_000_000_000);
    const A = await newShop({}, { now: ca.now });
    const pid = A.api.createProduct({ name: 'Rice 1 kg', price_paise: 12000, cost_paise: 9500, gst_rate_bp: 500, opening_qty_milli: 10_000 });
    A.api.issueSale({ lines: [{ productId: pid, qtyMilli: 2000 }], tenders: [{ method: 'cash', amountPaise: 24000 }] });
    const r1 = await sync(A.e, hub);
    expect(r1.pushed).toBeGreaterThan(40);
    expect(pendingOps(A.e)).toHaveLength(0);

    const B = await joinDevice(hub, 'B', clock(1_790_000_000_500).now);
    expect(B.api.session().business?.name).toBe('Test Kirana');
    expect(B.e.stockLevel(pid, A.e.branchId!)).toMatchObject({ qty_milli: 8000 });
    expect(digest(B.e)).toEqual(digest(A.e));
    expect(B.api.healthCheck().checks.filter((c) => !c.ok && c.name !== 'Audit log hash chain is intact')).toEqual([]);
  });

  it('two offline counters converge, never clash on invoice numbers, and flag oversold stock', async () => {
    const hub = new MemoryHub();
    const ca = clock(1_790_000_000_000);
    const A = await newShop({}, { now: ca.now });
    const pid = A.api.createProduct({ name: 'Ghee 500 ml', price_paise: 34000, cost_paise: 29000, gst_rate_bp: 500, opening_qty_milli: 1000 });
    const cust = A.api.createParty({ kind: 'customer', name: 'Sunita', phone: '5550010002' });
    await sync(A.e, hub);
    const cb = clock(1_790_000_001_000);
    const B = await joinDevice(hub, 'B', cb.now);
    B.api.selectBranch(A.e.branchId!);

    // Both sell the last unit while offline
    ca.advance(10_000);
    cb.advance(10_000);
    const sa = A.api.issueSale({ lines: [{ productId: pid, qtyMilli: 1000 }], tenders: [{ method: 'cash', amountPaise: 34000 }] });
    const sb = B.api.issueSale({ lines: [{ productId: pid, qtyMilli: 1000 }], partyId: cust, tenders: [{ method: 'upi', amountPaise: 10000 }] });
    expect(sa.docNo).toMatch(/-A\d{4}-00001$/);
    expect(sb.docNo).toMatch(/-B\d{4}-00001$/);
    B.api.receivePayment({ partyId: cust, amountPaise: 4000, method: 'cash' });

    await sync(A.e, hub);
    await sync(B.e, hub);
    await sync(A.e, hub);

    expect(digest(A.e)).toEqual(digest(B.e));
    expect(A.e.stockLevel(pid)).toMatchObject({ qty_milli: -1000 });
    expect(A.api.getParty(cust).party.receivable_paise).toBe(34000 - 10000 - 4000);
    const exA = A.api.listExceptions({ status: 'open' });
    const exB = B.api.listExceptions({ status: 'open' });
    expect([...exA, ...exB].some((x) => x.kind === 'negative_stock')).toBe(true);
    for (const x of [A, B]) {
      const h = x.api.healthCheck();
      expect(h.checks.find((c) => c.name === 'Trial balance tallies')!.ok).toBe(true);
      expect(h.checks.find((c) => c.name === 'Inventory account = stock valuation')!.ok).toBe(true);
    }
  });

  it('merges concurrent edits per field; same field → latest clock wins everywhere', async () => {
    const hub = new MemoryHub();
    const ca = clock(1_790_000_000_000);
    const A = await newShop({}, { now: ca.now });
    const pid = A.api.createProduct({ name: 'Tea 250 g', price_paise: 14000, cost_paise: 11000 });
    await sync(A.e, hub);
    const cb = clock(1_790_000_000_000);
    const B = await joinDevice(hub, 'B', cb.now);

    ca.advance(1000);
    A.api.updateProduct(pid, { price_paise: 14500 });
    cb.advance(2000);
    B.api.updateProduct(pid, { name: 'Tea premium 250 g' });
    cb.advance(1000);
    B.api.updateProduct(pid, { price_paise: 15000 }); // later than A's price edit
    ca.advance(500);
    A.api.updateProduct(pid, { reorder_level_milli: 3000 });

    await sync(B.e, hub);
    await sync(A.e, hub);
    await sync(B.e, hub);
    for (const x of [A, B]) {
      const p = x.api.getProduct(pid).product;
      expect(p).toMatchObject({ name: 'Tea premium 250 g', price_paise: 15000, reorder_level_milli: 3000 });
    }
    expect(digest(A.e).products).toEqual(digest(B.e).products);
  });

  it('is idempotent and rejects tampered ops', async () => {
    const hub = new MemoryHub();
    const A = await newShop();
    A.api.createProduct({ name: 'Soap', price_paise: 3800 });
    const ops = pendingOps(A.e);
    await sync(A.e, hub);
    const B = await joinDevice(hub, 'B', () => Date.now());
    const before = digest(B.e);
    const again = applyRemoteOps(B.e, ops.map((o, i) => ({ ...o, seq: i + 1 })));
    expect(again.applied).toBe(0);
    expect(digest(B.e)).toEqual(before);

    const C = await newEngine();
    const tampered = structuredClone(ops[ops.length - 1]);
    (tampered.payload as any).set.price_paise = 1;
    const res = applyRemoteOps(C.e, [tampered]);
    expect(res.invalid).toBe(1);
    expect(hub.push(A.e.deviceId, [tampered]).acked).toHaveLength(1); // same op_id already stored → idempotent ack
    const forged = { ...tampered, op_id: '0190aaaa-0000-7000-8000-000000000000' };
    forged.hash = hashOp(forged);
    expect(hub.push(A.e.deviceId, [forged]).rejected[0].reason).toBe('chain_broken');
  });

  it('random interleavings across three devices always converge', async () => {
    for (let round = 0; round < 4; round++) {
      let seed = 1000 + round;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const hub = new MemoryHub();
      const clocks = [clock(1_790_000_000_000), clock(1_790_000_000_000 - 5000), clock(1_790_000_000_000 + 7000)];
      const A = await newShop({}, { now: clocks[0].now });
      const products = ['Rice', 'Dal', 'Oil', 'Salt'].map((n, i) =>
        A.api.createProduct({ name: n, price_paise: 5000 + i * 1000, cost_paise: 4000 + i * 800, gst_rate_bp: i % 2 ? 500 : 0, opening_qty_milli: 5000 }),
      );
      const custs = ['P', 'Q'].map((n, i) => A.api.createParty({ kind: 'customer', name: n, phone: `55500100${10 + i}` }));
      const sup = A.api.createParty({ kind: 'supplier', name: 'S', gstin: '27AAAPG1234C1Z5' });
      await sync(A.e, hub);
      const B = await joinDevice(hub, 'B', clocks[1].now);
      const C = await joinDevice(hub, 'C', clocks[2].now);
      const devices = [A, B, C];
      for (const d of devices) d.api.selectBranch(A.e.branchId!);

      for (let step = 0; step < 40; step++) {
        const i = Math.floor(rand() * 3);
        const d = devices[i];
        clocks[i].advance(1 + Math.floor(rand() * 2000));
        const action = rand();
        const p = products[Math.floor(rand() * products.length)];
        try {
          if (action < 0.4) {
            const party = rand() < 0.4 ? custs[Math.floor(rand() * 2)] : null;
            const qty = 1000 * (1 + Math.floor(rand() * 3));
            const total = d.api.previewSale({ lines: [{ productId: p, qtyMilli: qty }], partyId: party }).totalPaise;
            d.api.issueSale({ lines: [{ productId: p, qtyMilli: qty }], partyId: party, tenders: party ? [] : [{ method: 'cash', amountPaise: total }], allowOverCreditLimit: true });
          } else if (action < 0.5) {
            d.api.recordPurchase({ partyId: sup, lines: [{ productId: p, qtyMilli: 3000, unitCostPaise: 3500 + Math.floor(rand() * 1000) }] });
          } else if (action < 0.6) {
            d.api.updateProduct(p, { price_paise: 5000 + Math.floor(rand() * 5000) });
          } else if (action < 0.68) {
            d.api.receivePayment({ partyId: custs[Math.floor(rand() * 2)], amountPaise: 1000, method: 'upi' });
          } else if (action < 0.74) {
            d.api.adjustStock({ productId: p, qtyDeltaMilli: -1000, reason: 'adjust_damage' });
          } else if (action < 0.8) {
            const bills = d.api.listSales({ limit: 5 }).filter((s) => !s.voided && s.doc_type !== 'credit_note');
            if (bills.length) d.api.voidSale(bills[0].id, 'test');
          } else {
            await sync(d.e, hub);
          }
        } catch (err: any) {
          if (!/returns|already voided|Bill not found/.test(String(err.message))) throw err;
        }
      }
      for (let k = 0; k < 2; k++) for (const d of devices) await sync(d.e, hub);
      const ref = digest(A.e);
      expect(digest(B.e)).toEqual(ref);
      expect(digest(C.e)).toEqual(ref);
      const nos = A.e.db.all<{ doc_no: string }>(`SELECT doc_no FROM sales_docs`).map((r) => r.doc_no);
      expect(new Set(nos).size).toBe(nos.length);
      for (const d of devices) {
        const failed = d.api.healthCheck().checks.filter((c) => !c.ok);
        expect(failed).toEqual([]);
      }
    }
  });
});
