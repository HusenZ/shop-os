export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  system_key: string | null;
}

/** Seed chart of accounts for an Indian retail business. */
export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  { code: '1000', name: 'Cash in hand', type: 'asset', system_key: 'cash' },
  { code: '1010', name: 'Bank / UPI', type: 'asset', system_key: 'bank' },
  { code: '1100', name: 'Accounts receivable (customers)', type: 'asset', system_key: 'ar' },
  { code: '1200', name: 'Inventory', type: 'asset', system_key: 'inventory' },
  { code: '1301', name: 'Input CGST', type: 'asset', system_key: 'input_cgst' },
  { code: '1302', name: 'Input SGST', type: 'asset', system_key: 'input_sgst' },
  { code: '1303', name: 'Input IGST', type: 'asset', system_key: 'input_igst' },
  { code: '1304', name: 'Input cess', type: 'asset', system_key: 'input_cess' },
  { code: '2000', name: 'Accounts payable (suppliers)', type: 'liability', system_key: 'ap' },
  { code: '2101', name: 'Output CGST', type: 'liability', system_key: 'output_cgst' },
  { code: '2102', name: 'Output SGST', type: 'liability', system_key: 'output_sgst' },
  { code: '2103', name: 'Output IGST', type: 'liability', system_key: 'output_igst' },
  { code: '2104', name: 'Output cess', type: 'liability', system_key: 'output_cess' },
  { code: '3000', name: "Owner's capital", type: 'equity', system_key: 'capital' },
  { code: '3100', name: 'Drawings', type: 'equity', system_key: 'drawings' },
  { code: '3200', name: 'Retained earnings', type: 'equity', system_key: 'retained' },
  { code: '3900', name: 'Opening balance equity', type: 'equity', system_key: 'opening' },
  { code: '4000', name: 'Sales', type: 'income', system_key: 'sales' },
  { code: '4100', name: 'Sales returns', type: 'income', system_key: 'sales_returns' },
  { code: '4200', name: 'Other income', type: 'income', system_key: 'other_income' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', system_key: 'cogs' },
  { code: '5100', name: 'Stock loss & write-offs', type: 'expense', system_key: 'stock_loss' },
  { code: '5200', name: 'Cash short / excess', type: 'expense', system_key: 'cash_diff' },
  { code: '5300', name: 'Round-off', type: 'expense', system_key: 'round_off' },
  { code: '6000', name: 'Rent', type: 'expense', system_key: null },
  { code: '6010', name: 'Salaries & wages', type: 'expense', system_key: null },
  { code: '6020', name: 'Electricity & utilities', type: 'expense', system_key: null },
  { code: '6030', name: 'Transport & delivery', type: 'expense', system_key: null },
  { code: '6040', name: 'Packaging', type: 'expense', system_key: null },
  { code: '6050', name: 'Repairs & maintenance', type: 'expense', system_key: null },
  { code: '6060', name: 'Bank & UPI charges', type: 'expense', system_key: null },
  { code: '6070', name: 'Phone & internet', type: 'expense', system_key: null },
  { code: '6080', name: 'Shop supplies', type: 'expense', system_key: null },
  { code: '6100', name: 'Composition tax', type: 'expense', system_key: 'composition_tax' },
  { code: '6900', name: 'Miscellaneous expenses', type: 'expense', system_key: null },
];

export type ShopType = 'kirana' | 'general' | 'clothing' | 'pharmacy' | 'electronics' | 'hardware';

export const SHOP_TYPES: { id: ShopType; label: string }[] = [
  { id: 'kirana', label: 'Kirana / grocery' },
  { id: 'general', label: 'General & stationery' },
  { id: 'clothing', label: 'Clothing & footwear' },
  { id: 'pharmacy', label: 'Pharmacy & cosmetics' },
  { id: 'electronics', label: 'Mobile & electronics' },
  { id: 'hardware', label: 'Hardware' },
];

export const STARTER_CATEGORIES: Record<ShopType, string[]> = {
  kirana: ['Staples & grains', 'Pulses', 'Oils & ghee', 'Spices', 'Snacks', 'Beverages', 'Dairy', 'Personal care', 'Household'],
  general: ['Stationery', 'Gifts', 'Toys', 'Household', 'Electronics accessories'],
  clothing: ['Men', 'Women', 'Kids', 'Footwear', 'Accessories'],
  pharmacy: ['Medicines', 'OTC', 'Personal care', 'Baby care', 'Cosmetics'],
  electronics: ['Mobiles', 'Accessories', 'Chargers & cables', 'Audio', 'Repairs'],
  hardware: ['Tools', 'Paints', 'Plumbing', 'Electrical', 'Fasteners'],
};

export const UNITS = ['pcs', 'kg', 'g', 'L', 'ml', 'm', 'pack', 'box', 'dozen', 'pair', 'strip'];
export const DECIMAL_UNITS = new Set(['kg', 'g', 'L', 'ml', 'm']);

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ADJUST_REASONS = [
  { id: 'adjust_damage', label: 'Damaged' },
  { id: 'adjust_expiry', label: 'Expired' },
  { id: 'adjust_loss', label: 'Lost / theft' },
  { id: 'adjust_self_use', label: 'Self use' },
  { id: 'count_correction', label: 'Count correction' },
] as const;
