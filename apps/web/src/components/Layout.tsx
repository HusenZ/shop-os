import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Boxes,
  CloudOff,
  Home,
  Landmark,
  LayoutGrid,
  Moon,
  Package,
  ReceiptIndianRupee,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Sun,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ago } from '../lib/format';
import { useOnline, useSession } from '../lib/hooks';
import { call } from '../lib/rpc';
import { Button, clsx, Modal } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'Sell', items: [
    { to: '/', label: 'Home', icon: Home },
    { to: '/pos', label: 'New bill', icon: ShoppingCart },
    { to: '/sales', label: 'Sales', icon: ReceiptIndianRupee },
  ] },
  { title: 'Stock', items: [
    { to: '/items', label: 'Items', icon: Package },
    { to: '/stock', label: 'Stock', icon: Boxes },
    { to: '/purchases', label: 'Purchases', icon: Truck },
  ] },
  { title: 'People', items: [
    { to: '/customers', label: 'Customers', icon: Users },
    { to: '/khata', label: 'Khata', icon: Wallet },
    { to: '/suppliers', label: 'Suppliers', icon: ArrowLeftRight },
  ] },
  { title: 'Money', items: [
    { to: '/money', label: 'Expenses & cash', icon: Landmark },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/books', label: 'Books', icon: BookOpen },
  ] },
  { title: 'Shop', items: [
    { to: '/audit', label: 'Audit & health', icon: ShieldCheck },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ] },
];

const BOTTOM: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/pos', label: 'Bill', icon: ShoppingCart },
  { to: '/items', label: 'Items', icon: Package },
  { to: '/khata', label: 'Khata', icon: Wallet },
];

export function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('shopos-theme', dark ? 'dark' : 'light');
  } catch {
    /* storage blocked */
  }
}

function SyncRunner() {
  const { data: s } = useSession();
  const online = useOnline();
  const qc = useQueryClient();
  const enrolled = s?.hub.enrolled;
  useEffect(() => {
    if (!enrolled || !online) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await call('sync');
        if (r.pulled || r.pushed) qc.invalidateQueries();
      } catch {
        qc.invalidateQueries({ queryKey: ['session'] });
      }
    };
    tick();
    const t = setInterval(() => !stop && tick(), 20_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [enrolled, online, qc]);
  return null;
}

function SyncPill() {
  const { data: s } = useSession();
  const online = useOnline();
  const nav = useNavigate();
  if (!s) return null;
  if (!online)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
        <CloudOff className="size-3.5" /> Offline · billing works
      </span>
    );
  if (!s.hub.enrolled)
    return (
      <button onClick={() => nav('/settings#sync')} className="hidden items-center gap-1.5 rounded-full bg-stone-200/70 px-2.5 py-1 text-xs font-medium text-stone-600 sm:inline-flex dark:bg-stone-800 dark:text-stone-300">
        Local only · this device
      </button>
    );
  const err = s.hub.lastSyncError;
  return (
    <button
      onClick={() => nav('/settings#sync')}
      title={err ?? undefined}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        err ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
      )}
    >
      <RefreshCw className="size-3.5" />
      {err ? 'Sync error' : s.pendingOps ? `${s.pendingOps} to sync` : `Synced ${ago(s.hub.lastSyncAt)}`}
    </button>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="space-y-5">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <p className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-stone-400 uppercase">{g.title}</p>
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                clsx(
                  'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition',
                  isActive ? 'bg-brand-700 text-white' : 'text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800',
                )
              }
            >
              <it.icon className="size-4" aria-hidden /> {it.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Layout() {
  const { data: s } = useSession();
  const [more, setMore] = useState(false);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const memoryOnly = useMemoryMode();

  return (
    <div className="min-h-dvh lg:flex">
      <SyncRunner />
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r border-stone-200 bg-stone-50 px-3 py-4 lg:flex dark:border-stone-800 dark:bg-stone-900/60">
        <div className="mb-6 flex items-center gap-2 px-3">
          <img src="/icon.svg" alt="" className="size-8" />
          <div className="min-w-0">
            <p className="text-sm leading-tight font-semibold">ShopOS</p>
            <p className="truncate text-xs text-stone-500">{s?.business?.name}</p>
          </div>
        </div>
        <NavLinks />
      </aside>
      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-100/85 px-4 backdrop-blur lg:px-6 dark:border-stone-800 dark:bg-stone-950/85">
          <img src="/icon.svg" alt="" className="size-7 lg:hidden" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{s?.branch?.name}</p>
            <p className="truncate text-xs text-stone-500">
              {s?.userName} · counter {s?.seriesCode}
            </p>
          </div>
          <SyncPill />
          <button onClick={toggleTheme} className="rounded-lg p-2 text-stone-600 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-stone-800" aria-label="Toggle dark mode">
            <Sun className="hidden size-4 dark:block" />
            <Moon className="size-4 dark:hidden" />
          </button>
        </header>
        {memoryOnly ? (
          <div className="no-print bg-rose-600 px-4 py-2 text-center text-sm text-white">
            This browser cannot store data on disk (OPFS unavailable). Data will be lost when the tab closes — back up often.
          </div>
        ) : null}
        <main ref={main} className="mx-auto max-w-7xl px-4 pt-4 pb-28 sm:pt-6 lg:px-6 lg:pb-10">
          <Outlet />
        </main>
      </div>
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-stone-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden dark:border-stone-800 dark:bg-stone-900/95">
        {BOTTOM.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className={({ isActive }) => clsx('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', isActive ? 'text-brand-700 dark:text-brand-300' : 'text-stone-500')}
          >
            <it.icon className="size-5" aria-hidden />
            {it.label}
          </NavLink>
        ))}
        <button onClick={() => setMore(true)} className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-stone-500">
          <LayoutGrid className="size-5" aria-hidden />
          More
        </button>
      </nav>
      <Modal open={more} onClose={() => setMore(false)} title="Menu">
        <NavLinks onNavigate={() => setMore(false)} />
      </Modal>
    </div>
  );
}

let memoryModeCache: boolean | null = null;
function useMemoryMode() {
  const [m, setM] = useState(memoryModeCache ?? false);
  useEffect(() => {
    if (memoryModeCache !== null) return;
    call('init').then((r) => {
      memoryModeCache = r.mode === 'memory';
      setM(memoryModeCache);
    });
  }, []);
  return m;
}

export function PrintButton() {
  return (
    <Button icon={ScrollText} onClick={() => window.print()}>
      Print
    </Button>
  );
}
