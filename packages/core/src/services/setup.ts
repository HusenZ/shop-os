import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { CHART_OF_ACCOUNTS, STARTER_CATEGORIES, type ShopType } from '../seed';
import { isValidGstin, type GstScheme, type PriceMode } from '../tax';

export interface SetupInput {
  businessName: string;
  ownerName?: string;
  shopType: ShopType;
  gstScheme: GstScheme;
  compositionRateBp?: number;
  stateCode: string;
  gstin?: string;
  priceMode?: PriceMode;
  roundOff?: boolean;
  branchName?: string;
  address?: string;
  phone?: string;
  upiId?: string;
  upiName?: string;
  invoicePrefix?: string;
  seedCategories?: boolean;
}

const COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8', '#15803d', '#a16207', '#c2410c', '#4338ca'];

export function setupShop(e: ShopEngine, input: SetupInput): { businessId: string; branchId: string } {
  if (e.businessId) throw new ShopError('This device already has a shop', 'already_setup');
  const name = input.businessName?.trim();
  if (!name) throw new ShopError('Enter the shop name');
  if (!/^\d{2}$/.test(input.stateCode ?? '')) throw new ShopError('Choose the state');
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (input.gstScheme !== 'none') {
    if (!gstin || !isValidGstin(gstin)) throw new ShopError('Enter a valid 15-character GSTIN');
    if (gstin.slice(0, 2) !== input.stateCode) throw new ShopError('The GSTIN does not match the chosen state');
  }
  const prefix = (input.invoicePrefix || 'INV').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'INV';
  const businessId = uuidv7(e.now());
  const branchId = uuidv7(e.now());

  e.db.tx(() => {
    e.setMeta('business_id', businessId);
    e.setMeta('branch_id', branchId);
    e.setMeta('user_name', input.ownerName?.trim() || 'Owner');
    e.setMeta('series_code', e.seriesCode);
    e.patch(
      'businesses',
      businessId,
      {
        name,
        legal_name: name,
        gst_scheme: input.gstScheme,
        composition_rate_bp: input.gstScheme === 'composition' ? (input.compositionRateBp ?? 100) : null,
        shop_type: input.shopType,
        fy_start_month: 4,
        price_mode: input.priceMode ?? 'inclusive',
        round_off: input.roundOff === false ? 0 : 1,
        lock_date: null,
        phone: input.phone ?? null,
      },
      { create: true },
    );
    e.patch(
      'branches',
      branchId,
      {
        business_id: businessId,
        name: input.branchName?.trim() || 'Main shop',
        code: 'MAIN',
        kind: 'shop',
        address: input.address ?? null,
        phone: input.phone ?? null,
        state_code: input.stateCode,
        gstin,
        upi_id: input.upiId?.trim() || null,
        upi_name: input.upiName?.trim() || name,
        invoice_prefix: prefix,
        receipt_footer: 'Thank you! Visit again.',
        negative_stock: 'warn',
        receipt_width: '80mm',
      },
      { create: true },
    );
    for (const a of CHART_OF_ACCOUNTS) {
      e.patch(
        'accounts',
        uuidv7(e.now()),
        { business_id: businessId, code: a.code, name: a.name, type: a.type, system_key: a.system_key, is_system: a.system_key ? 1 : 0 },
        { create: true },
      );
    }
    if (input.seedCategories !== false) {
      STARTER_CATEGORIES[input.shopType].forEach((c, i) =>
        e.patch('categories', uuidv7(e.now()), { business_id: businessId, name: c, sort: i, color: COLORS[i % COLORS.length] }, { create: true }),
      );
    }
  });
  return { businessId, branchId };
}

const BUSINESS_FIELDS = ['name', 'legal_name', 'gst_scheme', 'composition_rate_bp', 'shop_type', 'price_mode', 'round_off', 'phone', 'email', 'pan', 'fy_start_month'];
const BRANCH_FIELDS = ['name', 'code', 'kind', 'address', 'phone', 'state_code', 'gstin', 'upi_id', 'upi_name', 'invoice_prefix', 'receipt_footer', 'negative_stock', 'receipt_width', 'deleted'];

function pick(src: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

export function updateBusiness(e: ShopEngine, set: Row) {
  const clean = pick(set, BUSINESS_FIELDS);
  if (clean.gst_scheme && clean.gst_scheme !== 'none') {
    const branch = e.branch();
    if (!branch.gstin) throw new ShopError('Add the GSTIN on the branch before switching to a GST scheme');
  }
  e.patch('businesses', e.business().id, clean);
}

export function updateBranch(e: ShopEngine, branchId: string, set: Row) {
  const clean = pick(set, BRANCH_FIELDS);
  if (clean.gstin) {
    clean.gstin = String(clean.gstin).trim().toUpperCase();
    if (!isValidGstin(clean.gstin)) throw new ShopError('Enter a valid 15-character GSTIN');
  }
  if (clean.invoice_prefix) clean.invoice_prefix = String(clean.invoice_prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  e.patch('branches', branchId, clean);
}

export function createBranch(e: ShopEngine, input: Row): string {
  const biz = e.business();
  if (!input.name?.trim()) throw new ShopError('Enter the branch name');
  const id = uuidv7(e.now());
  const current = e.branch();
  e.patch(
    'branches',
    id,
    {
      business_id: biz.id,
      kind: 'shop',
      state_code: current.state_code,
      gstin: current.gstin,
      upi_id: current.upi_id,
      upi_name: current.upi_name,
      invoice_prefix: current.invoice_prefix,
      receipt_footer: current.receipt_footer,
      negative_stock: current.negative_stock,
      receipt_width: current.receipt_width,
      ...pick(input, BRANCH_FIELDS),
      code: (input.code || input.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
    },
    { create: true },
  );
  return id;
}

/** Which branch this device bills for (device-local setting). */
export function selectBranch(e: ShopEngine, branchId: string) {
  const b = e.db.get(`SELECT id FROM branches WHERE id = ? AND deleted = 0`, [branchId]);
  if (!b) throw new ShopError('Branch not found', 'not_found');
  e.setMeta('branch_id', branchId);
}

export function setUserName(e: ShopEngine, name: string) {
  e.setMeta('user_name', name.trim() || 'Owner');
}

/** After a joining device pulled the shop from the hub, adopt its business. */
export function adoptSyncedShop(e: ShopEngine): { businessId: string | null; branches: Row[] } {
  if (!e.businessId) {
    const b = e.db.get<{ id: string }>(`SELECT id FROM businesses WHERE deleted = 0 ORDER BY updated_hlc LIMIT 1`);
    if (b) e.setMeta('business_id', b.id);
  }
  const branches = e.db.all(`SELECT * FROM branches WHERE deleted = 0 ORDER BY name`);
  if (!e.branchId && branches.length === 1) e.setMeta('branch_id', branches[0].id);
  return { businessId: e.businessId, branches };
}
