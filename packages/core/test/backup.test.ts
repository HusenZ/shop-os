import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backupCounts, createBackupFile, openBackupFile, pendingOps, readBackupHeader, SCHEMA_VERSION } from '../src';
import { engineFromBytes, newShop } from './helpers';

describe('encrypted backups', () => {
  it('round-trips the whole shop through an encrypted .shopos file', async () => {
    const { api, e, db } = await newShop();
    api.seedDemoData();
    const file = await createBackupFile(
      db.exportBytes(),
      { schema_v: SCHEMA_VERSION, app_v: 'test', device_id: e.deviceId, business_name: 'Test Kirana', counts: backupCounts(e) },
      'correct horse battery',
    );
    const { header } = readBackupHeader(file);
    expect(header).toMatchObject({ format: 'shopos-backup', encrypted: true, business_name: 'Test Kirana' });
    await expect(openBackupFile(file, 'wrong')).rejects.toThrow(/passphrase/);
    await expect(openBackupFile(file)).rejects.toThrow(/protected/);

    const { dbBytes } = await openBackupFile(file, 'correct horse battery');
    const restored = await engineFromBytes(dbBytes);
    expect(restored.e.deviceId).toBe(e.deviceId);
    expect(backupCounts(restored.e)).toEqual(backupCounts(e));
    expect(restored.api.trialBalance({ to: e.today() })).toEqual(api.trialBalance({ to: e.today() }));
    expect(restored.api.healthCheck().ok).toBe(true);

    const damaged = file.slice();
    damaged[damaged.length - 5] ^= 0xff;
    await expect(openBackupFile(damaged, 'correct horse battery')).rejects.toThrow();
  });

  it('supports unencrypted backups and rejects other files', async () => {
    const { e, db } = await newShop();
    const file = await createBackupFile(db.exportBytes(), { schema_v: 1, app_v: 'test', device_id: e.deviceId, business_name: null, counts: {} });
    const { dbBytes, header } = await openBackupFile(file);
    expect(header.encrypted).toBe(false);
    expect(dbBytes.length).toBeGreaterThan(1000);
    expect(() => readBackupHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a ShopOS backup/);
  });
});

export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ops-from-core.json');

describe('fixture', () => {
  it('exports ops for cross-language verification', async () => {
    const { api, e } = await newShop();
    const pid = api.createProduct({ name: 'चाय पत्ती 250 g', price_paise: 14000, cost_paise: 11000, gst_rate_bp: 500, opening_qty_milli: 5000 });
    const cust = api.createParty({ kind: 'customer', name: 'Ramesh "RK" Kumar ', phone: '5550010001' });
    api.issueSale({ lines: [{ productId: pid, qtyMilli: 2000 }], partyId: cust, tenders: [{ method: 'upi', amountPaise: 10000 }] });
    const ops = pendingOps(e, 1000);
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, JSON.stringify({ device_id: e.deviceId, ops }, null, 1));
    expect(ops.length).toBeGreaterThan(40);
  });
});
