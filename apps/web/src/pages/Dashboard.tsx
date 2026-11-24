import { AlertTriangle, Banknote, HandCoins, Plus, ReceiptIndianRupee, ShieldAlert, ShoppingCart, TrendingUp, Truck, Wallet } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Bar, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, CardTitle, Empty, Loading, PageHeader, Stat } from '../components/ui';
import { ago, fmtDate, inr, METHOD_LABEL, pct, qty } from '../lib/format';
import { useQ, useSession } from '../lib/hooks';

export default function Dashboard() {
  const nav = useNavigate();
  const { data: s } = useSession();
  const { data: d } = useQ('dashboard', [{}]);
  if (!d) return <Loading />;
  const backupOld = !s?.hub.enrolled && (!d.lastBackupAt || Date.now() - d.lastBackupAt > 7 * 86400_000);
  const chart = d.last14.map((x) => ({ day: fmtDate(x.day, true), sales: x.netSalesPaise / 100, profit: x.grossProfitPaise / 100 }));

  return (
    <div>
      <PageHeader
        title={`Namaste${s?.userName && s.userName !== 'Owner' ? `, ${s.userName}` : ''}`}
        sub={`${fmtDate(d.date)} · ${s?.branch?.name}`}
        actions={
          <>
            <Button icon={Truck} onClick={() => nav('/purchases/new')} className="hidden sm:inline-flex">
              Purchase
            </Button>
            <Button variant="primary" icon={ShoppingCart} onClick={() => nav('/pos')}>
              New bill
            </Button>
          </>
        }
      />

      {backupOld || d.openExceptions ? (
        <div className="mb-4 space-y-2">
          {backupOld ? (
            <Link to="/settings#backup" className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="size-4 shrink-0" />
              {d.lastBackupAt ? `Last backup ${ago(d.lastBackupAt)}.` : 'No backup yet.'} Your data lives only on this device — back it up now.
            </Link>
          ) : null}
          {d.openExceptions ? (
            <Link to="/audit" className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
              <ShieldAlert className="size-4 shrink-0" />
              {d.openExceptions} thing{d.openExceptions > 1 ? 's' : ''} need your attention after syncing (e.g. stock sold on two counters).
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Today's sales" value={inr(d.salesPaise, true)} sub={`${d.bills} bill${d.bills === 1 ? '' : 's'}${d.creditGivenPaise ? ` · ${inr(d.creditGivenPaise, true)} on khata` : ''}`} icon={ReceiptIndianRupee} tone="brand" />
        <Stat label="Gross profit today" value={inr(d.grossProfitPaise, true)} sub={`Margin ${pct(d.grossMarginBp)} on ${inr(d.netSalesPaise, true)} net sales`} icon={TrendingUp} tone="green" />
        <Stat label="Cash in drawer" value={inr(d.cashInHandPaise ?? 0, true)} sub={d.methods.map((m) => `${METHOD_LABEL[m.method] ?? m.method} ${inr(m.amount_paise, true)}`).join(' · ') || 'No payments yet today'} icon={Banknote} tone="amber" />
        <Stat label="You'll get" value={inr(d.receivablePaise, true)} sub={`${d.receivableCount} customer${d.receivableCount === 1 ? '' : 's'} · you'll give ${inr(d.payablePaise, true)}`} icon={Wallet} tone="blue" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle sub="Net sales (bars) and gross profit (line), last 14 days">Sales trend</CardTitle>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ left: -10, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-stone-200 dark:text-stone-800" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#a8a29e" tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v}`} />
                <Tooltip formatter={(v: any, n: any) => [inr(Math.round(v * 100)), n === 'sales' ? 'Net sales' : 'Gross profit']} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="sales" fill="#16766c" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line dataKey="profit" stroke="#d97706" strokeWidth={2} dot={false} type="monotone" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardTitle action={<Link to="/stock" className="text-sm text-brand-700 hover:underline">All stock</Link>}>Running low</CardTitle>
          {d.lowStock.length === 0 ? (
            <p className="py-6 text-center text-sm text-stone-500">Nothing is below its reorder level.</p>
          ) : (
            <ul className="divide-y divide-stone-100 dark:divide-stone-800">
              {d.lowStock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to={`/items/${p.id}`} className="truncate hover:underline">
                    {p.name}
                  </Link>
                  <Badge tone={p.qty_milli <= 0 ? 'red' : 'amber'}>{qty(p.qty_milli, p.unit)}</Badge>
                </li>
              ))}
            </ul>
          )}
          {d.lowStockCount > d.lowStock.length ? <p className="mt-2 text-xs text-stone-500">+{d.lowStockCount - d.lowStock.length} more</p> : null}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle sub="Last 7 days">Top items</CardTitle>
          {d.topItems.length === 0 ? (
            <Empty title="No sales yet" />
          ) : (
            <ul className="space-y-2">
              {d.topItems.map((t, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{t.name}</span>
                  <span className="shrink-0 text-stone-500 tabular-nums">
                    {qty(t.qty_milli, t.unit)} · {inr(t.net_paise, true)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle>Quick actions</CardTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { to: '/pos', label: 'New bill', icon: ShoppingCart },
              { to: '/khata', label: 'Collect dues', icon: HandCoins },
              { to: '/purchases/new', label: 'Stock in', icon: Truck },
              { to: '/money', label: 'Add expense', icon: Plus },
            ].map((a) => (
              <Link key={a.to} to={a.to} className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 p-4 text-sm font-medium transition hover:border-brand-600 hover:bg-brand-50 dark:border-stone-800 dark:hover:bg-brand-900/20">
                <a.icon className="size-5 text-brand-700 dark:text-brand-300" />
                {a.label}
              </Link>
            ))}
          </div>
          <p className="mt-4 text-xs text-stone-500">
            {s?.hub.enrolled ? `Synced ${ago(d.lastSyncAt)} · ${d.pendingOps} change(s) waiting` : `Local mode · last backup ${ago(d.lastBackupAt)}`}
          </p>
        </Card>
      </div>
    </div>
  );
}
