import { INDIAN_STATES, isValidGstin, SHOP_TYPES, type GstScheme, type ShopType } from '@shopos/core';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CloudDownload, FileUp, Store } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, Field, Input, Select, Toggle, clsx } from '../components/ui';
import { DEFAULT_HUB, deviceName, hub } from '../lib/hub';
import { call } from '../lib/rpc';

type Mode = 'choose' | 'new' | 'join' | 'restore';

export default function Onboarding() {
  const [mode, setMode] = useState<Mode>('choose');
  return (
    <div className="min-h-dvh bg-gradient-to-b from-brand-50 to-stone-100 px-4 py-10 dark:from-stone-900 dark:to-stone-950">
      <div className="mx-auto max-w-xl">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-11" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">ShopOS</h1>
            <p className="text-sm text-stone-500">Billing, stock, khata and books — works without internet.</p>
          </div>
        </div>
        {mode === 'choose' && <Choose onPick={setMode} />}
        {mode === 'new' && <NewShop onBack={() => setMode('choose')} />}
        {mode === 'join' && <JoinShop onBack={() => setMode('choose')} />}
        {mode === 'restore' && <Restore onBack={() => setMode('choose')} />}
      </div>
    </div>
  );
}

function Choose({ onPick }: { onPick: (m: Mode) => void }) {
  const options = [
    { id: 'new' as const, icon: Store, title: 'Start a new shop', text: 'Set up in two minutes. No account needed — your data stays on this device.' },
    { id: 'join' as const, icon: CloudDownload, title: 'Join an existing shop', text: 'Add this phone or PC as another counter. Needs the ShopOS hub (cloud or shop PC).' },
    { id: 'restore' as const, icon: FileUp, title: 'Restore from a backup file', text: 'Open a .shopos backup made on another device.' },
  ];
  return (
    <div className="space-y-3">
      {options.map((o) => (
        <button key={o.id} onClick={() => onPick(o.id)} className="block w-full text-left">
          <Card className="flex items-start gap-4 transition hover:border-brand-600 hover:shadow-sm">
            <span className="rounded-xl bg-brand-700 p-2.5 text-white">
              <o.icon className="size-5" />
            </span>
            <span>
              <span className="block font-semibold">{o.title}</span>
              <span className="mt-0.5 block text-sm text-stone-500">{o.text}</span>
            </span>
          </Card>
        </button>
      ))}
    </div>
  );
}

function NewShop({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    businessName: '',
    ownerName: '',
    shopType: 'kirana' as ShopType,
    stateCode: '27',
    phone: '',
    gstScheme: 'none' as GstScheme,
    gstin: '',
    priceMode: 'inclusive' as 'inclusive' | 'exclusive',
    roundOff: true,
    invoicePrefix: 'INV',
    upiId: '',
    address: '',
    demo: true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const gstOk = f.gstScheme === 'none' || (isValidGstin(f.gstin) && f.gstin.toUpperCase().startsWith(f.stateCode));

  async function finish() {
    setBusy(true);
    try {
      await call('setupShop', {
        businessName: f.businessName,
        ownerName: f.ownerName,
        shopType: f.shopType,
        gstScheme: f.gstScheme,
        stateCode: f.stateCode,
        gstin: f.gstScheme === 'none' ? undefined : f.gstin,
        priceMode: f.priceMode,
        roundOff: f.roundOff,
        invoicePrefix: f.invoicePrefix,
        upiId: f.upiId,
        upiName: f.businessName,
        address: f.address,
        phone: f.phone,
      });
      if (f.demo) await call('seedDemoData');
      try {
        await navigator.storage?.persist?.();
      } catch {
        /* not supported */
      }
      toast.success(f.demo ? 'Shop ready with two weeks of demo data' : 'Shop ready. Add your first items.');
      await qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  const steps = ['Shop', 'GST', 'Billing'];
  return (
    <Card>
      <button onClick={step ? () => setStep(step - 1) : onBack} className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <ol className="mb-5 flex gap-2">
        {steps.map((s, i) => (
          <li key={s} className={clsx('h-1.5 flex-1 rounded-full', i <= step ? 'bg-brand-700' : 'bg-stone-200 dark:bg-stone-700')} aria-label={s} />
        ))}
      </ol>
      {step === 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">About your shop</h2>
          <Field label="Shop name">
            <Input value={f.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="e.g. Sharma General Store" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name">
              <Input value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} placeholder="Owner" />
            </Field>
            <Field label="Shop phone">
              <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" placeholder="55500 00000" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What do you sell?" hint="Sets starter categories and units">
              <Select value={f.shopType} onChange={(e) => set('shopType', e.target.value as ShopType)}>
                {SHOP_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="State">
              <Select value={f.stateCode} onChange={(e) => set('stateCode', e.target.value)}>
                {Object.entries(INDIAN_STATES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button variant="primary" className="w-full" disabled={!f.businessName.trim()} onClick={() => setStep(1)}>
            Continue
          </Button>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">GST</h2>
          <div className="grid gap-2">
            {(
              [
                ['none', 'Not registered for GST', 'Simple cash memos, no tax on bills'],
                ['composition', 'Composition scheme', 'Bills of supply; you pay a small % on turnover'],
                ['regular', 'Regular GST', 'Tax invoices with CGST/SGST or IGST, input tax credit'],
              ] as const
            ).map(([id, title, text]) => (
              <button
                key={id}
                onClick={() => set('gstScheme', id)}
                className={clsx('rounded-xl border p-3 text-left transition', f.gstScheme === id ? 'border-brand-700 bg-brand-50 dark:bg-brand-900/30' : 'border-stone-200 dark:border-stone-700')}
              >
                <span className="block text-sm font-semibold">{title}</span>
                <span className="block text-xs text-stone-500">{text}</span>
              </button>
            ))}
          </div>
          {f.gstScheme !== 'none' && (
            <Field label="GSTIN" hint={f.gstin && !gstOk ? 'Enter a valid 15-character GSTIN for the chosen state' : 'Starts with your state code'}>
              <Input value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} placeholder={`${f.stateCode}AAAAA0000A1Z5`} />
            </Field>
          )}
          <Field label="Your selling prices are">
            <Select value={f.priceMode} onChange={(e) => set('priceMode', e.target.value as 'inclusive')}>
              <option value="inclusive">Including GST (MRP-style, most shops)</option>
              <option value="exclusive">Before GST (tax added on the bill)</option>
            </Select>
          </Field>
          <Button variant="primary" className="w-full" disabled={!gstOk} onClick={() => setStep(2)}>
            Continue
          </Button>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Billing</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bill number prefix" hint="Up to 4 letters, e.g. INV → INV-A2627-00001">
              <Input value={f.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase().slice(0, 4))} />
            </Field>
            <Field label="UPI ID (optional)" hint="Shows a pay QR on bills">
              <Input value={f.upiId} onChange={(e) => set('upiId', e.target.value.trim())} placeholder="shopname@upi" />
            </Field>
          </div>
          <Field label="Shop address (printed on bills)">
            <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Toggle checked={f.roundOff} onChange={(v) => set('roundOff', v)} label="Round bills to the nearest rupee" />
          <Toggle checked={f.demo} onChange={(v) => set('demo', v)} label="Fill with demo data" hint="Two weeks of made-up items, customers and bills — good for a first look" />
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={finish}>
            Open my shop
          </Button>
        </div>
      )}
    </Card>
  );
}

function JoinShop({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(DEFAULT_HUB);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function join() {
    setBusy(true);
    try {
      setStatus('Signing in…');
      const auth = await hub.login(url, email, password);
      const info = await call('init');
      setStatus('Adding this device…');
      const enrol = await hub.enrol(url, auth.access_token, info.deviceId, deviceName());
      await call('applyEnrolment', { url, orgId: enrol.org_id, deviceToken: enrol.device_token, seriesCode: enrol.series_code, email, jwt: auth.access_token });
      setStatus('Downloading the shop…');
      const r = await call('sync');
      const adopted = await call('adoptSyncedShop');
      if (!adopted.businessId) throw new Error('The hub has no shop data yet. Connect the first device to the hub from its Settings → Sync.');
      toast.success(`Joined as counter ${enrol.series_code} · ${r.pulled} changes downloaded`);
      await qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
      setStatus('');
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <h2 className="text-lg font-semibold">Join an existing shop</h2>
      <p className="text-sm text-stone-500">Sign in with the owner account created on the first device (Settings → Sync).</p>
      <Field label="Hub address">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Owner email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      </Field>
      <Field label="Password">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      <Button variant="primary" className="w-full" loading={busy} onClick={join} disabled={!email || !password}>
        Join shop
      </Button>
      {status ? <p className="text-center text-sm text-stone-500">{status}</p> : null}
    </Card>
  );
}

function Restore({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [info, setInfo] = useState<string>('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  async function pick(f: File | null) {
    setFile(f);
    setInfo('');
    if (!f) return;
    try {
      const h = await call('inspectBackup', new Uint8Array(await f.arrayBuffer()));
      setEncrypted(h.encrypted);
      setInfo(`${h.business_name ?? 'Shop'} · ${new Date(h.created_at).toLocaleString('en-IN')} · ${h.counts.sales_docs ?? 0} bills`);
    } catch (err) {
      toast.error((err as Error).message);
      setFile(null);
    }
  }

  async function restore() {
    if (!file) return;
    setBusy(true);
    try {
      const r = await call('restoreBackup', new Uint8Array(await file.arrayBuffer()), pass);
      toast.success(r.health.ok ? 'Backup restored and verified' : 'Backup restored — open Audit & health to review warnings');
      await qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ArrowLeft className="size-4" /> Back
      </button>
      <h2 className="text-lg font-semibold">Restore from a backup</h2>
      <Field label="Backup file (.shopos)">
        <Input type="file" accept=".shopos,application/octet-stream" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="pt-2" />
      </Field>
      {info ? <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800">{info}</p> : null}
      {encrypted ? (
        <Field label="Backup passphrase">
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
      ) : null}
      <Button variant="primary" className="w-full" loading={busy} disabled={!file || (encrypted && !pass)} onClick={restore}>
        Restore
      </Button>
    </Card>
  );
}
