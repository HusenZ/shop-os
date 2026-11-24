import type { ShopEngine } from './engine';
import { addDays } from './money';
import { createProduct, setOpeningStock } from './services/catalog';
import { recordExpense, recordMoneyMovement } from './services/money';
import { createParty, receivePayment } from './services/parties';
import { recordPurchase } from './services/purchases';
import { issueSale, previewSale, returnSale } from './services/sales';

/** Deterministic pseudo-random numbers so the demo shop is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface DemoItem {
  name: string;
  cat: number;
  unit: string;
  price: number;
  cost: number;
  mrp?: number;
  gst: number;
  hsn: string;
  stock: number;
  barcode?: string;
  fav?: boolean;
}

// All names, prices and numbers below are made up for the demo shop.
const KIRANA: DemoItem[] = [
  { name: 'Basmati rice 1 kg', cat: 0, unit: 'pcs', price: 12000, cost: 9500, mrp: 13000, gst: 500, hsn: '1006', stock: 40, barcode: '8900000000017', fav: true },
  { name: 'Wheat atta 5 kg', cat: 0, unit: 'pcs', price: 26500, cost: 22000, mrp: 28000, gst: 500, hsn: '1101', stock: 25, barcode: '8900000000024', fav: true },
  { name: 'Sugar (loose)', cat: 0, unit: 'kg', price: 4600, cost: 4000, gst: 500, hsn: '1701', stock: 60, fav: true },
  { name: 'Toor dal (loose)', cat: 1, unit: 'kg', price: 16500, cost: 13800, gst: 0, hsn: '0713', stock: 30 },
  { name: 'Moong dal (loose)', cat: 1, unit: 'kg', price: 14000, cost: 11800, gst: 0, hsn: '0713', stock: 20 },
  { name: 'Sunflower oil 1 L', cat: 2, unit: 'pcs', price: 15500, cost: 13000, mrp: 16500, gst: 500, hsn: '1512', stock: 30, barcode: '8900000000031', fav: true },
  { name: 'Desi ghee 500 ml', cat: 2, unit: 'pcs', price: 34000, cost: 29000, mrp: 35500, gst: 500, hsn: '0405', stock: 12, barcode: '8900000000048' },
  { name: 'Turmeric powder 200 g', cat: 3, unit: 'pcs', price: 5800, cost: 4400, mrp: 6000, gst: 500, hsn: '0910', stock: 24, barcode: '8900000000055' },
  { name: 'Red chilli powder 200 g', cat: 3, unit: 'pcs', price: 7200, cost: 5500, mrp: 7500, gst: 500, hsn: '0904', stock: 20, barcode: '8900000000062' },
  { name: 'Potato chips 50 g', cat: 4, unit: 'pcs', price: 2000, cost: 1500, mrp: 2000, gst: 500, hsn: '2106', stock: 80, barcode: '8900000000079', fav: true },
  { name: 'Glucose biscuits', cat: 4, unit: 'pcs', price: 1000, cost: 800, mrp: 1000, gst: 500, hsn: '1905', stock: 100, barcode: '8900000000086', fav: true },
  { name: 'Cola 750 ml', cat: 5, unit: 'pcs', price: 4500, cost: 3600, mrp: 4500, gst: 4000, hsn: '2202', stock: 36, barcode: '8900000000093' },
  { name: 'Tea 250 g', cat: 5, unit: 'pcs', price: 14000, cost: 11200, mrp: 14500, gst: 500, hsn: '0902', stock: 18, barcode: '8900000000109', fav: true },
  { name: 'Milk 500 ml', cat: 6, unit: 'pcs', price: 3000, cost: 2700, mrp: 3000, gst: 0, hsn: '0401', stock: 40, fav: true },
  { name: 'Paneer 200 g', cat: 6, unit: 'pcs', price: 9000, cost: 7500, mrp: 9500, gst: 500, hsn: '0406', stock: 10 },
  { name: 'Bath soap', cat: 7, unit: 'pcs', price: 3800, cost: 3000, mrp: 4000, gst: 500, hsn: '3401', stock: 48, barcode: '8900000000116' },
  { name: 'Toothpaste 150 g', cat: 7, unit: 'pcs', price: 9500, cost: 7800, mrp: 9900, gst: 500, hsn: '3306', stock: 6, barcode: '8900000000123' },
  { name: 'Detergent powder 1 kg', cat: 8, unit: 'pcs', price: 12000, cost: 9800, mrp: 12500, gst: 1800, hsn: '3402', stock: 15, barcode: '8900000000130' },
  { name: 'Floor cleaner 500 ml', cat: 8, unit: 'pcs', price: 9900, cost: 8000, mrp: 9900, gst: 1800, hsn: '3402', stock: 4, barcode: '8900000000147' },
];

const CUSTOMERS = [
  { name: 'Ramesh Kumar', phone: '5550010001', credit_limit_paise: 500000 },
  { name: 'Sunita Devi', phone: '5550010002', credit_limit_paise: 300000 },
  { name: 'Anil Sharma', phone: '5550010003', credit_limit_paise: 0 },
  { name: 'Priya Nair', phone: '5550010004', credit_limit_paise: 0 },
  { name: 'Mohammed Arif', phone: '5550010005', credit_limit_paise: 200000 },
];

/** Fills a freshly set-up shop with two weeks of realistic, made-up activity. */
export function seedDemoData(e: ShopEngine) {
  const business = e.business();
  const branch = e.branch();
  const rand = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const today = e.today();
  const start = addDays(today, -14);
  const cats = e.db.all<{ id: string }>(`SELECT id FROM categories WHERE deleted = 0 ORDER BY sort`);
  const state = branch.state_code ?? '27';

  e.db.tx(() => {
    const products = KIRANA.map((it) => {
      // Cost ≈ 80% of the pre-GST selling price: a typical kirana margin.
      const cost = Math.round((it.price * 10000) / (10000 + it.gst) * 0.8);
      const id = createProduct(e, {
        name: it.name, category_id: cats[it.cat % Math.max(cats.length, 1)]?.id ?? null, unit: it.unit, price_paise: it.price,
        cost_paise: cost, mrp_paise: it.mrp ?? null, gst_rate_bp: it.gst, hsn: it.hsn, barcode: it.barcode ?? null,
        reorder_level_milli: it.unit === 'kg' ? 10000 : 5000, favourite: it.fav ? 1 : 0,
      });
      setOpeningStock(e, { productId: id, qtyMilli: it.stock * 3000, unitCostPaise: cost, date: start });
      return { id, ...it, cost };
    });
    const customers = CUSTOMERS.map((c, i) => createParty(e, { ...c, kind: 'customer', address: `House ${12 + i}, Market Road`, tags: i < 2 ? 'regular' : null }));
    const supplier = createParty(e, {
      kind: 'supplier', name: 'Shree Ganesh Traders (demo)', phone: '5550020001', gstin: `${state}AAAPG1234C1Z5`, address: 'Wholesale Market',
    });
    const supplier2 = createParty(e, { kind: 'supplier', name: 'City Dairy (demo)', phone: '5550020002', opening_balance_paise: 120000 });

    recordMoneyMovement(e, { kind: 'capital_in', amountPaise: 2000000, method: 'cash', date: start, note: 'Opening cash' });

    for (let d = 0; d < 14; d++) {
      const date = addDays(start, d + 1);
      const bills = 7 + Math.floor(rand() * 6);
      for (let b = 0; b < bills; b++) {
        const n = 1 + Math.floor(rand() * 4);
        const taken = new Map<string, number>();
        const lines = Array.from({ length: n }, () => {
          const p = pick(products);
          const qty = p.unit === 'kg' ? 500 + Math.floor(rand() * 4) * 500 : 1000 * (1 + Math.floor(rand() * 2));
          return { productId: p.id, qtyMilli: qty };
        }).filter((l) => {
          // never oversell in the demo: keep a line only if stock covers it
          const have = e.stockLevel(l.productId).qty_milli - (taken.get(l.productId) ?? 0);
          if (have < l.qtyMilli) return false;
          taken.set(l.productId, (taken.get(l.productId) ?? 0) + l.qtyMilli);
          return true;
        });
        if (!lines.length) continue;
        const credit = rand() < 0.18;
        const party = credit || rand() < 0.3 ? pick(customers) : null;
        const preview = issueSaleTotal(e, lines, party);
        const method = rand() < 0.55 ? 'upi' : 'cash';
        const tenders = credit
          ? [{ method, amountPaise: Math.floor(preview / 2 / 100) * 100 }]
          : [{ method, amountPaise: method === 'cash' ? Math.ceil(preview / 10000) * 10000 : preview }];
        try {
          issueSale(e, { lines, partyId: party, tenders, date, allowOverCreditLimit: true });
        } catch {
          /* skip a bill that does not fit (e.g. credit limit) */
        }
      }
      if (d === 6) {
        recordPurchase(e, {
          partyId: supplier,
          supplierBillNo: 'SGT/1042',
          date,
          lines: products.filter((_, i) => i % 3 === 0).map((p) => ({ productId: p.id, qtyMilli: 10000, unitCostPaise: p.cost })),
          paid: { method: 'bank', amountPaise: 300000 },
        });
      }
      if (d === 9) {
        recordPurchase(e, {
          partyId: supplier2,
          supplierBillNo: 'CD-77',
          date,
          lines: products.filter((p) => p.cat === 6).map((p) => ({ productId: p.id, qtyMilli: 20000, unitCostPaise: p.cost })),
        });
      }
    }
    const accounts = new Map(e.db.all<{ code: string; id: string }>(`SELECT code, id FROM accounts`).map((a) => [a.code, a.id]));
    recordExpense(e, { accountId: accounts.get('6000')!, amountPaise: 600000, method: 'bank', date: addDays(start, 2), payee: 'Shop rent, half month (demo)' });
    recordExpense(e, { accountId: accounts.get('6020')!, amountPaise: 186000, method: 'upi', date: addDays(start, 8), payee: 'Electricity bill' });
    recordExpense(e, { accountId: accounts.get('6040')!, amountPaise: 45000, method: 'cash', date: addDays(start, 10), payee: 'Carry bags' });
    receivePayment(e, { partyId: customers[0], amountPaise: 50000, method: 'upi', date: addDays(today, -2), note: 'Part payment' });

    const lastBill = e.db.get<{ id: string }>(`SELECT id FROM sales_docs WHERE doc_type <> 'credit_note' ORDER BY hlc DESC LIMIT 1`);
    if (lastBill) {
      const line = e.db.get<{ id: string; qty_milli: number }>(`SELECT id, qty_milli FROM sales_lines WHERE doc_id = ? ORDER BY line_no LIMIT 1`, [lastBill.id]);
      if (line) returnSale(e, { docId: lastBill.id, lines: [{ lineId: line.id, qtyMilli: Math.min(line.qty_milli, 1000) }], refund: 'cash', restock: true, reason: 'Customer changed mind' });
    }
  });
  void business;
}

function issueSaleTotal(e: ShopEngine, lines: { productId: string; qtyMilli: number }[], partyId: string | null): number {
  return previewSale(e, { lines, partyId }).totalPaise;
}
