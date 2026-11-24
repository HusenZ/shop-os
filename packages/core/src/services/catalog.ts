import type { Row } from '../db';
import { ShopError, type ShopEngine } from '../engine';
import { uuidv7 } from '../ids';
import { divRound } from '../money';
import { Journal } from '../posting';
import { ADJUST_REASONS, DECIMAL_UNITS } from '../seed';

const CATEGORY_FIELDS = ['name', 'parent_id', 'color', 'sort', 'deleted'];
const PRODUCT_FIELDS = [
  'category_id', 'name', 'sku', 'barcode', 'hsn', 'unit', 'allow_decimal', 'mrp_paise', 'price_paise', 'cost_paise',
  'gst_rate_bp', 'cess_rate_bp', 'track_stock', 'reorder_level_milli', 'is_active', 'favourite', 'deleted',
];

function pick(src: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

export function createCategory(e: ShopEngine, input: Row): string {
  if (!input.name?.trim()) throw new ShopError('Enter the category name');
  const id = uuidv7(e.now());
  const sort = e.db.get<{ n: number }>(`SELECT coalesce(max(sort), -1) + 1 AS n FROM categories`)?.n ?? 0;
  e.patch('categories', id, { business_id: e.business().id, sort, color: '#0f766e', ...pick(input, CATEGORY_FIELDS), name: input.name.trim() }, { create: true });
  return id;
}

export function updateCategory(e: ShopEngine, id: string, set: Row) {
  e.patch('categories', id, pick(set, CATEGORY_FIELDS));
}

function validateProduct(e: ShopEngine, p: Row, id?: string) {
  if (p.name !== undefined && !String(p.name).trim()) throw new ShopError('Enter the item name');
  for (const k of ['mrp_paise', 'price_paise', 'cost_paise', 'gst_rate_bp', 'cess_rate_bp', 'reorder_level_milli']) {
    if (p[k] !== undefined && p[k] !== null && (!Number.isInteger(p[k]) || p[k] < 0)) throw new ShopError(`Invalid value for ${k}`);
  }
  if (p.mrp_paise && p.price_paise && p.price_paise > p.mrp_paise) throw new ShopError('Selling price cannot be more than MRP');
  if (p.barcode) {
    const dup = e.db.get<{ name: string }>(
      `SELECT name FROM products WHERE barcode = ? AND deleted = 0 AND id <> ?`,
      [p.barcode, id ?? ''],
    );
    if (dup) throw new ShopError(`Barcode already used by "${dup.name}"`, 'duplicate_barcode');
  }
}

export interface CreateProductInput extends Row {
  name: string;
  price_paise: number;
  opening_qty_milli?: number;
}

export function createProduct(e: ShopEngine, input: CreateProductInput): string {
  const row = pick(input, PRODUCT_FIELDS);
  row.name = String(input.name ?? '').trim();
  row.unit ??= 'pcs';
  row.allow_decimal ??= DECIMAL_UNITS.has(row.unit) ? 1 : 0;
  row.gst_rate_bp ??= 0;
  row.cess_rate_bp ??= 0;
  row.track_stock ??= 1;
  row.is_active ??= 1;
  row.cost_paise ??= 0;
  row.price_paise ??= 0;
  row.reorder_level_milli ??= 0;
  row.favourite ??= 0;
  if (row.barcode === '') row.barcode = null;
  validateProduct(e, row);
  const id = uuidv7(e.now());
  e.db.tx(() => {
    e.patch('products', id, { business_id: e.business().id, ...row }, { create: true });
    if (input.opening_qty_milli && input.opening_qty_milli > 0) {
      setOpeningStock(e, { productId: id, qtyMilli: input.opening_qty_milli, unitCostPaise: row.cost_paise });
    }
  });
  return id;
}

export function updateProduct(e: ShopEngine, id: string, set: Row) {
  const row = pick(set, PRODUCT_FIELDS);
  if (row.barcode === '') row.barcode = null;
  const current = e.db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!current) throw new ShopError('Item not found', 'not_found');
  validateProduct(e, { ...current, ...row }, id);
  e.patch('products', id, row);
}

function product(e: ShopEngine, id: string): Row {
  const p = e.db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!p) throw new ShopError('Item not found', 'not_found');
  return p;
}

export function setOpeningStock(e: ShopEngine, input: { productId: string; qtyMilli: number; unitCostPaise: number; date?: string; branchId?: string }) {
  const p = product(e, input.productId);
  if (!Number.isInteger(input.qtyMilli) || input.qtyMilli <= 0) throw new ShopError('Opening quantity must be more than zero');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  const branchId = input.branchId ?? e.requireBranchId();
  const value = divRound(input.qtyMilli * (input.unitCostPaise || 0), 1000);
  const moveId = uuidv7(e.now());
  const j = new Journal(e, date, `Opening stock: ${p.name}`, { type: 'opening_stock', id: moveId });
  j.dr('inventory', value, { branch: branchId }).cr('opening', value, { branch: branchId });
  return e.fact(
    'stock.opening',
    'stock_movements',
    moveId,
    {
      stock_movements: [
        { id: moveId, branch_id: branchId, product_id: p.id, qty_delta_milli: input.qtyMilli, value_paise: value, unit_cost_paise: input.unitCostPaise || 0, reason: 'opening', source_type: 'opening', source_id: moveId, business_date: date },
      ],
      ...j.build(),
    },
    branchId,
  );
}

export function adjustStock(e: ShopEngine, input: { productId: string; qtyDeltaMilli: number; reason: string; note?: string; date?: string }) {
  const p = product(e, input.productId);
  if (!Number.isInteger(input.qtyDeltaMilli) || input.qtyDeltaMilli === 0) throw new ShopError('Enter the quantity to adjust');
  if (!ADJUST_REASONS.some((r) => r.id === input.reason)) throw new ShopError('Choose a reason');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const branchId = e.requireBranchId();
    const moveId = uuidv7(e.now());
    const out = input.qtyDeltaMilli < 0;
    const value = out ? -e.issueCost(p.id, -input.qtyDeltaMilli) : divRound(input.qtyDeltaMilli * e.avgCost(p.id), 1000);
    const j = new Journal(e, date, `Stock ${out ? 'write-off' : 'gain'}: ${p.name}`, { type: 'stock_adjustment', id: moveId });
    if (out) j.dr('stock_loss', -value).cr('inventory', -value);
    else j.dr('inventory', value).cr('stock_loss', value);
    return e.fact('stock.adjusted', 'stock_movements', moveId, {
      stock_movements: [
        {
          id: moveId, product_id: p.id, qty_delta_milli: input.qtyDeltaMilli, value_paise: value,
          unit_cost_paise: divRound(Math.abs(value) * 1000, Math.abs(input.qtyDeltaMilli)), reason: input.reason,
          source_type: 'adjustment', source_id: moveId, business_date: date, note: input.note ?? null,
        },
      ],
      ...j.build(),
    });
  });
}

/** Instant branch-to-branch transfer at cost (same GSTIN). */
export function transferStock(e: ShopEngine, input: { toBranchId: string; lines: { productId: string; qtyMilli: number }[]; note?: string; date?: string }) {
  const from = e.branch();
  const to = e.db.get(`SELECT * FROM branches WHERE id = ? AND deleted = 0`, [input.toBranchId]);
  if (!to) throw new ShopError('Choose the branch to send stock to');
  if (to.id === from.id) throw new ShopError('Choose a different branch');
  if ((to.gstin || null) !== (from.gstin || null)) {
    throw new ShopError('Transfers between different GSTINs must be billed as a sale (not supported yet)', 'cross_gstin');
  }
  if (!input.lines.length) throw new ShopError('Add items to transfer');
  const date = input.date ?? e.today();
  e.assertOpen(date);
  return e.db.tx(() => {
    const transferId = uuidv7(e.now());
    const movements: Row[] = [];
    const j = new Journal(e, date, `Stock transfer ${from.name} → ${to.name}`, { type: 'transfer', id: transferId });
    for (const l of input.lines) {
      const p = product(e, l.productId);
      if (!Number.isInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new ShopError(`Quantity for ${p.name} must be more than zero`);
      const value = e.issueCost(p.id, l.qtyMilli, from.id);
      const unit = divRound(value * 1000, l.qtyMilli);
      movements.push(
        { product_id: p.id, branch_id: from.id, qty_delta_milli: -l.qtyMilli, value_paise: -value, unit_cost_paise: unit, reason: 'transfer_out', source_type: 'transfer', source_id: transferId, business_date: date },
        { product_id: p.id, branch_id: to.id, qty_delta_milli: l.qtyMilli, value_paise: value, unit_cost_paise: unit, reason: 'transfer_in', source_type: 'transfer', source_id: transferId, business_date: date },
      );
      j.dr('inventory', value, { branch: to.id }).cr('inventory', value, { branch: from.id });
    }
    return e.fact('stock.transferred', 'stock_transfers', transferId, {
      stock_transfers: [{ id: transferId, from_branch_id: from.id, to_branch_id: to.id, business_date: date, lines: JSON.stringify(input.lines), note: input.note ?? null }],
      stock_movements: movements,
      ...j.build(),
    });
  });
}
