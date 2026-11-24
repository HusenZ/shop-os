import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import App from './App';
import './index.css';
import { startWorker, stopWorker } from './lib/rpc';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2000, refetchOnWindowFocus: false, retry: false } },
});

type Gate = 'checking' | 'ready' | 'busy' | 'taken';
let requested = false;

/**
 * The SQLite file can be open in only one tab. A Web Lock decides which tab owns it;
 * another tab can take over ("Use here"), which stops the database in the old tab.
 */
function TabGate() {
  const [gate, setGate] = useState<Gate>('checking');

  function hold(steal: boolean) {
    if (!('locks' in navigator)) {
      startWorker();
      setGate('ready');
      return;
    }
    navigator.locks
      .request('shopos-db', steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) {
          setGate('busy');
          return;
        }
        startWorker();
        setGate('ready');
        await new Promise(() => {}); // keep the lock for the life of the tab
      })
      .catch(() => {
        stopWorker();
        setGate('taken');
      });
  }

  useEffect(() => {
    if (requested) return;
    requested = true;
    hold(false);
  }, []);

  if (gate === 'ready') return <App />;
  if (gate === 'checking') return null;
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <p className="text-lg font-semibold">{gate === 'busy' ? 'ShopOS is open in another tab' : 'ShopOS moved to another tab'}</p>
        <p className="mt-2 text-sm text-stone-500">The shop's database can be used in one tab at a time, so bills are never written twice.</p>
        <button className="mt-5 h-10 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white" onClick={() => (gate === 'busy' ? hold(true) : location.reload())}>
          Use ShopOS here
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TabGate />
      </BrowserRouter>
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
