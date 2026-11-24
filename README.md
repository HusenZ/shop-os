# ShopOS

Offline-first shop management for local Indian retail: fast GST and non-GST billing, stock, customer credit (khata), suppliers and real double-entry books. It runs in the browser, keeps the shop's data on the shop's own device, and syncs without conflicts across counters and branches through an optional FastAPI hub.

Portfolio project. All demo names, phone numbers (`55500 xxxxx`), emails (`.example`) and GSTINs are made up.

## Quick start

Requirements: Node 20+ (tested on 24), Python 3.12+ with [uv](https://docs.astral.sh/uv/) for the hub.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 → **Start a new shop** → keep **Fill with demo data** on. That's all that's needed for single-device use: no server and no account.

To sync several devices, start the hub:

```bash
npm run hub
```

Then on the first device go to **Settings → Sync between devices → Create hub account**. On a second device (or http://127.0.0.1:5173, which counts as a separate browser origin) choose **Join an existing shop** with the same email and password.

## What's in it

| Area | Built |
|---|---|
| **Billing (POS)** | Search/scan (USB scanner or camera), category chips, favourites, decimal quantities for loose items, line and bill discounts, round-off, held bills, keyboard shortcuts (F2 search, F9 pay). Payments by cash (change calculator and note buttons), offline **UPI QR with the amount**, card, khata (credit), split and partial. |
| **GST / non-GST** | A tax engine per registration: unregistered → cash memo; composition → bill of supply with the declaration; regular → tax invoice (CGST+SGST or IGST from place of supply), bill of supply, or invoice-cum-bill of supply. Inclusive and exclusive pricing, HSN, cess, per-device FY invoice series (`INV-A2627-00042`). |
| **Invoices** | Thermal 58/80 mm and A4 print layouts, a UPI QR for the balance due, WhatsApp share, returns as **credit notes** (refund or khata, restock or write-off), **void** as a reversal that keeps the number used. |
| **Items & stock** | Categories, items (MRP guard, barcode uniqueness, units), opening stock, adjustments with reasons, low-stock alerts, a movement ledger, weighted average cost per branch, valuation at cost and at retail, branch-to-branch transfers. |
| **Customers & khata** | Profiles, dedupe by phone, purchase history and favourites, passbook with running balance, credit limits (warn or override), ageing, WhatsApp reminders with a UPI pay link, opening balances from the paper khata. |
| **Suppliers & purchases** | Purchase bills with input tax credit (regular GST + registered supplier) or GST added to cost, partial payment, payables. |
| **Money** | Expenses (custom types), owner capital/drawings, cash ↔ bank, **day close** with denomination count posting cash short/excess. |
| **Double-entry books** | A seeded chart of accounts; every event posts a balanced journal in the same transaction. Trial balance, balance sheet, day book, account ledgers, period lock. |
| **Reports** | P&L with previous-period comparison and a "why profit ≠ cash" panel; sales by day/item/category/payment (CSV); stock valuation; GST summary with output vs input, HSN summary and B2B list (CSV), plus a composition estimate. |
| **Multi-branch** | Branches share items and customers; stock, cash and bill series stay per branch. Branch filter on reports; switching the device's branch. |
| **Offline-first DB** | SQLite (official WASM build) in a Web Worker on OPFS. One tab owns the DB (Web Locks, with "Use here"). PWA with a precached app shell. |
| **Sync** | A hash-chained op log; facts merge by union, reference data per field (LWW on hybrid logical clocks); per-device invoice series; an exceptions inbox (oversold stock, credit limit, duplicate customer, late entries, clock skew). |
| **Backup & audit** | Encrypted `.shopos` backups (gzip + AES-256-GCM, PBKDF2 600k), restore with integrity check, an immutable audit log (SQLite triggers + hash chain), a health check that rebuilds every total and compares, app PIN lock. |
| **Hub (FastAPI)** | Orgs and owner login (JWT), device enrolment with series codes, revoke, push/pull with hash and chain verification, journal balance checks, encrypted backup storage, consolidated P&L and trial balance across branches. |

## Not built yet (the remaining ~30%)

- Multi-business switcher (several legal entities on one device); today one device holds one business with many branches
- Advanced inventory: batches/expiry (FEFO), serial/IMEI, variants matrix, unit conversions, stocktake sessions, reorder engine
- Purchase orders → GRN → bill matching, purchase returns (debit notes), landed cost, supplier price history
- Staff roles and permissions with switch-user PINs (an app lock exists; ops already record the user)
- Bill-wise payment allocation, customer advances/wallet, loyalty points
- Inter-GSTIN branch transfers (blocked with a clear message), e-invoice/e-way bill, GSTR-1 JSON (CSV exports exist)
- Period-end inventory revaluation, year-end close entry
- Hub: WebSocket nudges (devices poll every 20 s), device snapshots for fast bootstrap, Postgres + row-level security, LAN HTTPS for phones on Wi-Fi
- Hindi UI, Bluetooth/serial ESC/POS printing, WhatsApp Business API

## Architecture

```
apps/web        React 19 + Vite 8 + Tailwind 4 PWA. UI only — every read/write is an RPC to the DB worker.
  src/db/worker.ts   sqlite-wasm on OPFS (SAH pool) + the ShopOS engine; backup/restore; HTTP sync
packages/core   Pure TypeScript domain, shared by the worker and Node tests:
  engine.ts     op log (hash chain), fact inserts, per-field LWW merge, projections
  tax.ts        GST engine and pricing   posting.ts  journals    services/*  use cases (one transaction each)
  reports.ts    P&L, balance sheet, TB, GST, stock   sync.ts  push/pull/apply + in-memory hub
  backup.ts     encrypted backup format   health.ts  integrity checks and rebuild
apps/api        FastAPI hub (SQLite by default): auth, devices, sync, backups, consolidated reports
```

Money is integer paise, quantities are integer thousandths, and rates are basis points. There are no floats in the ledger.

## Tests

| Command | What it covers |
|---|---|
| `npm test` | 33 core tests on real SQLite (WASM) under Node: money and GST maths (property-based), a hand-checked books scenario (P&L, balance sheet, GST, returns, voids, transfers, day close), immutability, lock dates, demo-shop consistency, **randomized 3-device sync convergence**, encrypted backup round-trip |
| `npm run test:api` | 41 hub tests, including a cross-language check that ops produced by the TypeScript core hash identically in Python and project into a balanced trial balance |
| `npm run test:e2e` | With the hub running: two devices bill offline, sync through the real hub, converge byte-for-byte, and match the hub's consolidated trial balance |
| `npm run typecheck` | Strict TypeScript for core and web |
