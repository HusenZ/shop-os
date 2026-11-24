/**
 * End-to-end: two real engines sync through the real FastAPI hub over HTTP.
 * Runs only when SHOPOS_HUB_URL is set, e.g.
 *   SHOPOS_HUB_URL=http://localhost:8000 npx vitest run test/hub.e2e.test.ts
 */
import { describe, expect, it } from 'vitest';
import { httpTransport, syncOnce } from '../src';
import { digest, newEngine, newShop } from './helpers';

const HUB = process.env.SHOPOS_HUB_URL;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${HUB}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

describe.skipIf(!HUB)('sync through the FastAPI hub', () => {
  it('two devices bill offline and converge through the hub', async () => {
    const email = `e2e-${Date.now()}@shop.example`;
    const org = await post('/v1/orgs', { org_name: 'E2E Kirana', email, password: 'e2e-test-pass' });

    const A = await newShop();
    A.api.seedDemoData();
    const enrolA = await post('/v1/devices/enrol', { device_id: A.e.deviceId, name: 'Counter A', preferred_series: 'A' }, org.access_token);
    const tA = httpTransport(HUB!, enrolA.device_token);
    const first = await syncOnce(A.e, tA);
    expect(first.rejected).toBe(0);
    expect(first.pushed).toBeGreaterThan(100);

    const B = await newEngine();
    const enrolB = await post('/v1/devices/enrol', { device_id: B.e.deviceId, name: 'Counter B' }, org.access_token);
    B.e.setMeta('series_code', enrolB.series_code);
    const tB = httpTransport(HUB!, enrolB.device_token);
    await syncOnce(B.e, tB);
    B.api.adoptSyncedShop();
    expect(digest(B.e)).toEqual(digest(A.e));

    // offline on both: sell, take payments, edit the same product
    const [rice] = A.api.listProducts({ q: 'Basmati' });
    const cust = A.api.listParties({ kind: 'customer' })[0];
    A.api.issueSale({ lines: [{ productId: rice.id, qtyMilli: 2000 }], tenders: [{ method: 'cash', amountPaise: 24000 }] });
    const bSale = B.api.issueSale({ lines: [{ productId: rice.id, qtyMilli: 1000 }], partyId: cust.id, tenders: [] });
    expect(bSale.docNo).toContain(`-${enrolB.series_code}`);
    B.api.receivePayment({ partyId: cust.id, amountPaise: 5000, method: 'upi' });
    A.api.updateProduct(rice.id, { price_paise: 12500 });
    B.api.updateProduct(rice.id, { reorder_level_milli: 8000 });

    await syncOnce(A.e, tA);
    await syncOnce(B.e, tB);
    await syncOnce(A.e, tA);
    expect(digest(A.e)).toEqual(digest(B.e));
    expect(A.api.getProduct(rice.id).product).toMatchObject({ price_paise: 12500, reorder_level_milli: 8000 });
    expect(A.api.healthCheck().ok).toBe(true);
    expect(B.api.healthCheck().checks.filter((c) => !c.ok && !c.name.includes('hash chain'))).toEqual([]);

    // the hub's consolidated books agree with the devices
    const tb = await fetch(`${HUB}/v1/reports/trial-balance?as_of=9999-12-31`, { headers: { authorization: `Bearer ${org.access_token}` } }).then((r) => r.json());
    expect(tb.balanced).toBe(true);
    const local = A.api.trialBalance({ to: '9999-12-31' });
    const hubNet = Object.fromEntries(tb.accounts.map((a: any) => [a.account_id, a.debit_paise - a.credit_paise]));
    for (const a of local.accounts) expect(hubNet[a.accountId] ?? 0).toBe(a.balanceDebitPaise - a.balanceCreditPaise);
  });
});
