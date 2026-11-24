import { Lock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '../lib/hooks';
import { call } from '../lib/rpc';
import { Button, Input } from './ui';

const IDLE_MS = 10 * 60_000;

function hex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin: string, salt: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 150_000 }, key, 256);
  return hex(bits);
}

export async function makePinRecord(pin: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  return `${salt}:${await hashPin(pin, salt)}`;
}

let unlocked = (() => {
  try {
    return sessionStorage.getItem('shopos-unlocked') === '1';
  } catch {
    return false;
  }
})();

function setUnlocked(v: boolean) {
  unlocked = v;
  try {
    if (v) sessionStorage.setItem('shopos-unlocked', '1');
    else sessionStorage.removeItem('shopos-unlocked');
  } catch {
    /* blocked */
  }
}

/** App lock: a PIN screen on start and after 10 minutes without activity. */
export function LockGate({ children }: { children: ReactNode }) {
  const { data: s } = useSession();
  const [open, setOpen] = useState(unlocked);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!s?.pinSet || !open) return;
    let t = setTimeout(lock, IDLE_MS);
    function lock() {
      setUnlocked(false);
      setOpen(false);
    }
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(lock, IDLE_MS);
    };
    const events = ['pointerdown', 'keydown'];
    events.forEach((ev) => window.addEventListener(ev, bump));
    return () => {
      clearTimeout(t);
      events.forEach((ev) => window.removeEventListener(ev, bump));
    };
  }, [s?.pinSet, open]);

  if (!s?.pinSet || open) return <>{children}</>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const rec = await call('getMeta', 'app_pin');
    if (!rec) return setOpen(true);
    const [salt, hash] = rec.split(':');
    if ((await hashPin(pin, salt)) === hash) {
      setUnlocked(true);
      setOpen(true);
    } else {
      setError('Wrong PIN');
      setPin('');
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-xs rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <Lock className="mx-auto size-8 text-brand-700" />
        <p className="mt-3 text-lg font-semibold">{s.business?.name}</p>
        <p className="text-sm text-stone-500">Enter the PIN to open ShopOS</p>
        <Input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value);
            setError('');
          }}
          className="mt-4 text-center text-lg tracking-[0.5em]"
          aria-label="PIN"
        />
        {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
        <Button type="submit" variant="primary" className="mt-4 w-full">
          Unlock
        </Button>
      </form>
    </div>
  );
}
