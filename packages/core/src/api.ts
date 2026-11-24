import type { Row } from './db';
import type { ShopEngine } from './engine';
import { seedDemoData } from './demo';
import { healthCheck, rebuildDerived } from './health';
import * as q from './queries';
import * as r from './reports';
import * as catalog from './services/catalog';
import * as money from './services/money';
import * as parties from './services/parties';
import * as purchases from './services/purchases';
import * as sales from './services/sales';
import * as setup from './services/setup';

/**
 * Everything the UI can call. In the browser these run inside the DB worker;
 * each mutating call is a single SQLite transaction.
 */
export function createApi(e: ShopEngine) {
  return {
    // session & setup
    session: () => q.session(e),
    setupShop: (i: setup.SetupInput) => setup.setupShop(e, i),
    seedDemoData: () => seedDemoData(e),
    updateBusiness: (set: Row) => setup.updateBusiness(e, set),
    updateBranch: (id: string, set: Row) => setup.updateBranch(e, id, set),
    createBranch: (i: Row) => setup.createBranch(e, i),
    selectBranch: (id: string) => setup.selectBranch(e, id),
    setUserName: (name: string) => setup.setUserName(e, name),
    adoptSyncedShop: () => setup.adoptSyncedShop(e),
    setMeta: (key: string, value: string | null) => {
      if (!/^(hub_|app_pin|last_backup_at|ui_)/.test(key)) throw new Error('Not allowed');
      e.setMeta(key, value);
    },
    getMeta: (key: string) => e.meta(key),

    // catalog & stock
    listCategories: () => q.listCategories(e),
    createCategory: (i: Row) => catalog.createCategory(e, i),
    updateCategory: (id: string, set: Row) => catalog.updateCategory(e, id, set),
    listProducts: (i: Parameters<typeof q.listProducts>[1] = {}) => q.listProducts(e, i),
    getProduct: (id: string) => q.getProduct(e, id),
    findProductByCode: (code: string) => q.findProductByCode(e, code),
    createProduct: (i: catalog.CreateProductInput) => catalog.createProduct(e, i),
    updateProduct: (id: string, set: Row) => catalog.updateProduct(e, id, set),
    setOpeningStock: (i: Parameters<typeof catalog.setOpeningStock>[1]) => {
      catalog.setOpeningStock(e, i);
    },
    adjustStock: (i: Parameters<typeof catalog.adjustStock>[1]) => {
      catalog.adjustStock(e, i);
    },
    transferStock: (i: Parameters<typeof catalog.transferStock>[1]) => {
      catalog.transferStock(e, i);
    },
    listMovements: (i: Parameters<typeof q.listMovements>[1] = {}) => q.listMovements(e, i),
    stockSummary: (i: Parameters<typeof r.stockSummary>[1] = {}) => r.stockSummary(e, i),

    // parties & khata
    listParties: (i: Parameters<typeof q.listParties>[1] = {}) => q.listParties(e, i),
    getParty: (id: string) => q.getParty(e, id),
    createParty: (i: Row) => parties.createParty(e, i),
    updateParty: (id: string, set: Row) => parties.updateParty(e, id, set),
    setOpeningBalance: (partyId: string, amountPaise: number) => {
      parties.setOpeningBalance(e, partyId, amountPaise);
    },
    receivePayment: (i: Parameters<typeof parties.receivePayment>[1]) => parties.receivePayment(e, i),
    paySupplier: (i: Parameters<typeof parties.paySupplier>[1]) => parties.paySupplier(e, i),
    partyStatement: (i: Parameters<typeof r.partyStatement>[1]) => r.partyStatement(e, i),

    // sales
    previewSale: (i: Parameters<typeof sales.previewSale>[1]) => sales.previewSale(e, i),
    issueSale: (i: sales.IssueSaleInput) => sales.issueSale(e, i),
    returnSale: (i: sales.ReturnInput) => sales.returnSale(e, i),
    voidSale: (id: string, reason: string) => sales.voidSale(e, id, reason),
    listSales: (i: Parameters<typeof q.listSales>[1] = {}) => q.listSales(e, i),
    getSale: (id: string) => q.getSale(e, id),
    holdBill: (label: string, cart: unknown) => sales.holdBill(e, label, cart),
    listHeldBills: () => sales.listHeldBills(e),
    deleteHeldBill: (id: string) => sales.deleteHeldBill(e, id),

    // purchases
    recordPurchase: (i: purchases.PurchaseInput) => purchases.recordPurchase(e, i),
    listPurchases: (i: Parameters<typeof q.listPurchases>[1] = {}) => q.listPurchases(e, i),
    getPurchase: (id: string) => q.getPurchase(e, id),

    // money & books
    recordExpense: (i: Parameters<typeof money.recordExpense>[1]) => money.recordExpense(e, i),
    createExpenseAccount: (name: string) => money.createExpenseAccount(e, name),
    recordMoneyMovement: (i: Parameters<typeof money.recordMoneyMovement>[1]) => money.recordMoneyMovement(e, i),
    closeDay: (i: Parameters<typeof money.closeDay>[1]) => money.closeDay(e, i),
    cashBalance: () => money.cashBalance(e),
    lockBooks: (date: string | null) => money.lockBooks(e, date),
    listExpenses: (i: Parameters<typeof q.listExpenses>[1] = {}) => q.listExpenses(e, i),
    listAccounts: (i: Parameters<typeof q.listAccounts>[1] = {}) => q.listAccounts(e, i),
    listMoneyEntries: () => q.listMoneyEntries(e),
    listCashSessions: () => q.listCashSessions(e),

    // reports
    dashboard: (i: Parameters<typeof r.dashboard>[1] = {}) => r.dashboard(e, i),
    profitAndLoss: (i: Parameters<typeof r.profitAndLoss>[1]) => r.profitAndLoss(e, i),
    balanceSheet: (i: Parameters<typeof r.balanceSheet>[1]) => r.balanceSheet(e, i),
    trialBalance: (i: Parameters<typeof r.trialBalance>[1]) => r.trialBalance(e, i),
    dayBook: (i: Parameters<typeof r.dayBook>[1]) => r.dayBook(e, i),
    accountLedger: (i: Parameters<typeof r.accountLedger>[1]) => r.accountLedger(e, i),
    salesSummary: (i: Parameters<typeof r.salesSummary>[1]) => r.salesSummary(e, i),
    gstSummary: (i: Parameters<typeof r.gstSummary>[1]) => r.gstSummary(e, i),

    // audit & integrity
    listOps: (i: Parameters<typeof q.listOps>[1] = {}) => q.listOps(e, i),
    listExceptions: (i: Parameters<typeof q.listExceptions>[1] = {}) => q.listExceptions(e, i),
    resolveException: (id: string, status: 'resolved' | 'ignored') => q.resolveException(e, id, status),
    healthCheck: () => healthCheck(e),
    rebuildDerived: () => rebuildDerived(e),
    searchAll: (text: string) => q.searchAll(e, text),
  };
}

export type ShopApi = ReturnType<typeof createApi>;
export type ApiMethod = keyof ShopApi;
