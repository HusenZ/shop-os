import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { LockGate } from './components/LockGate';
import { Loading } from './components/ui';
import { useSession } from './lib/hooks';
import Audit from './pages/Audit';
import Books from './pages/Books';
import { ChooseBranch } from './pages/ChooseBranch';
import Dashboard from './pages/Dashboard';
import Items, { ItemDetail } from './pages/Items';
import Khata from './pages/Khata';
import Money from './pages/Money';
import Onboarding from './pages/Onboarding';
import Parties, { PartyDetail } from './pages/Parties';
import Pos from './pages/Pos';
import Purchases, { PurchaseDetail, PurchaseNew } from './pages/Purchases';
import Reports from './pages/Reports';
import Sales, { SaleDetail } from './pages/Sales';
import Settings from './pages/Settings';
import Stock from './pages/Stock';

export default function App() {
  const { data: s, isLoading, error } = useSession();
  if (error) return <div className="p-6 text-rose-600">Could not open the shop database: {String((error as Error).message)}</div>;
  if (isLoading || !s) return <Loading label="Opening your shop…" />;
  if (!s.setup) return <Onboarding />;
  if (!s.branch) return <ChooseBranch />;
  return (
    <LockGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="pos" element={<Pos />} />
          <Route path="sales" element={<Sales />} />
          <Route path="sales/:id" element={<SaleDetail />} />
          <Route path="items" element={<Items />} />
          <Route path="items/:id" element={<ItemDetail />} />
          <Route path="stock" element={<Stock />} />
          <Route path="customers" element={<Parties kind="customer" />} />
          <Route path="suppliers" element={<Parties kind="supplier" />} />
          <Route path="parties/:id" element={<PartyDetail />} />
          <Route path="khata" element={<Khata />} />
          <Route path="purchases" element={<Purchases />} />
          <Route path="purchases/new" element={<PurchaseNew />} />
          <Route path="purchases/:id" element={<PurchaseDetail />} />
          <Route path="money" element={<Money />} />
          <Route path="reports" element={<Reports />} />
          <Route path="books" element={<Books />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </LockGate>
  );
}
