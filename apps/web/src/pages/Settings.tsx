import { INDIAN_STATES, SCHEMA_VERSION } from '@shopos/core';
import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Download, HardDrive, KeyRound, Link2, LogOut, Plus, RefreshCw, Store, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { makePinRecord } from '../components/LockGate';
import { toggleTheme } from '../components/Layout';
import { Badge, Button, Card, CardTitle, Field, Input, KeyValue, Modal, Select, Toggle } from '../components/ui';
import { ago, downloadBytes, fmtDate, fmtTime, today } from '../lib/format';
import { DEFAULT_HUB, deviceName, hub } from '../lib/hub';
import { useAct, useQ, useSession } from '../lib/hooks';
import { call } from '../lib/rpc';

export default function Settings() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.hash) setTimeout(() => document.querySelector(loc.hash)?.scrollIntoView({ behavior: 'smooth' }), 100);
  }, [loc.hash]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ShopSettings />
      <BranchSettings />
      <Branches />
      <Backup />
      <Sync />
      <Security />
      <About />
    </div>
  );
}

function useForm<T extends Record<string, any>>(initial: T | undefined) {
  const [f, setF] = useState<T>((initial ?? {}) as T);
  useEffect(() => {
    if (initial) setF(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);
  return [f, (k: keyof T, v: any) => setF((x) => ({ ...x, [k]: v }))] as const;
}

function ShopSettings() {
  const { data: s } = useSession();
  const act = useAct();
  const b = s?.business;
  const [f, set] = useForm(b ? { name: b.name ?? '', phone: b.phone ?? '', gst_scheme: b.gst_scheme, price_mode: b.price_mode, round_off: !!b.round_off, composition_rate_bp: b.composition_rate_bp ?? 100 } : undefined);
  const [user, setUser] = useState(s?.userName ?? '');
  useEffect(() => setUser(s?.userName ?? ''), [s?.userName]);
  return (
    <Card>
      <CardTitle>Shop</CardTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shop name">
          <Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="GST registration" hint="Changing this affects new bills only">
          <Select value={f.gst_scheme} onChange={(e) => set('gst_scheme', e.target.value)}>
            <option value="none">Not registered (cash memo)</option>
            <option value="composition">Composition (bill of supply)</option>
            <option value="regular">Regular (tax invoice)</option>
          </Select>
        </Field>
        <Field label="Prices are">
          <Select value={f.price_mode} onChange={(e) => set('price_mode', e.target.value)}>
            <option value="inclusive">Including GST</option>
            <option value="exclusive">Before GST</option>
          </Select>
        </Field>
        {f.gst_scheme === 'composition' ? (
          <Field label="Composition rate (%)">
            <Input value={String((f.composition_rate_bp ?? 100) / 100)} onChange={(e) => set('composition_rate_bp', Math.round(Number(e.target.value) * 100) || 0)} inputMode="decimal" />
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Toggle checked={!!f.round_off} onChange={(v) => set('round_off', v)} label="Round bill totals to the nearest rupee" />
        </div>
        <Field label="Your name on this device" hint="Recorded in the audit log for every change">
          <Input value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          loading={act.pending}
          onClick={async () => {
            await act.run('updateBusiness', [{ ...f, round_off: f.round_off ? 1 : 0 }]);
            if (user !== s?.userName) await act.run('setUserName', [user]);
            toast.success('Saved');
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

function BranchSettings() {
  const { data: s } = useSession();
  const act = useAct();
  const br = s?.branch;
  const [f, set] = useForm(
    br
      ? {
          name: br.name ?? '', address: br.address ?? '', phone: br.phone ?? '', state_code: br.state_code ?? '27', gstin: br.gstin ?? '', upi_id: br.upi_id ?? '',
          upi_name: br.upi_name ?? '', invoice_prefix: br.invoice_prefix ?? 'INV', receipt_footer: br.receipt_footer ?? '', negative_stock: br.negative_stock ?? 'warn', receipt_width: br.receipt_width ?? '80mm',
        }
      : undefined,
  );
  if (!br) return null;
  return (
    <Card>
      <CardTitle sub="Settings for the branch this device bills for">Branch: {br.name}</CardTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Branch name">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Phone on bills">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Address on bills" className="sm:col-span-2">
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="State">
          <Select value={f.state_code} onChange={(e) => set('state_code', e.target.value)}>
            {Object.entries(INDIAN_STATES).map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GSTIN">
          <Input value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} />
        </Field>
        <Field label="UPI ID" hint="For the pay QR on bills and reminders">
          <Input value={f.upi_id} onChange={(e) => set('upi_id', e.target.value.trim())} placeholder="shop@upi" />
        </Field>
        <Field label="UPI payee name">
          <Input value={f.upi_name} onChange={(e) => set('upi_name', e.target.value)} />
        </Field>
        <Field label="Bill number prefix" hint="Up to 4 letters">
          <Input value={f.invoice_prefix} onChange={(e) => set('invoice_prefix', e.target.value.toUpperCase().slice(0, 4))} />
        </Field>
        <Field label="Receipt size">
          <Select value={f.receipt_width} onChange={(e) => set('receipt_width', e.target.value)}>
            <option value="58mm">58 mm thermal</option>
            <option value="80mm">80 mm thermal</option>
            <option value="A4">A4 / A5 printer</option>
          </Select>
        </Field>
        <Field label="Message at the bottom of bills" className="sm:col-span-2">
          <Input value={f.receipt_footer} onChange={(e) => set('receipt_footer', e.target.value)} />
        </Field>
        <Field label="When stock runs out" className="sm:col-span-2">
          <Select value={f.negative_stock} onChange={(e) => set('negative_stock', e.target.value)}>
            <option value="warn">Warn but allow the sale (recommended)</option>
            <option value="block">Block the sale</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" loading={act.pending} onClick={() => act.run('updateBranch', [br.id, { ...f, gstin: f.gstin || null }], 'Branch saved')}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function Branches() {
  const { data: s } = useSession();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  return (
    <Card>
      <CardTitle sub="Shops and godowns of this business share items and customers; stock, cash and bill series stay per branch" action={<Button size="sm" icon={Plus} onClick={() => setOpen(true)}>Add branch</Button>}>
        Branches
      </CardTitle>
      <ul className="divide-y divide-stone-100 dark:divide-stone-800">
        {s?.branches.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <Store className="size-4 text-stone-400" />
              <span>
                <span className="font-medium">{b.name}</span>
                <span className="block text-xs text-stone-500">{b.address || b.code}</span>
              </span>
            </span>
            {b.id === s.branch?.id ? (
              <Badge tone="brand">This device</Badge>
            ) : (
              <Button size="sm" onClick={() => act.run('selectBranch', [b.id], `This device now bills for ${b.name}`)}>
                Switch here
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add branch"
        size="sm"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await act.run('createBranch', [{ name, address }], 'Branch added');
              setOpen(false);
              setName('');
              setAddress('');
            }}
          >
            Add
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Station Road shop, Godown" />
          </Field>
          <Field label="Address">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <p className="text-xs text-stone-500">The new branch copies this branch's GSTIN, UPI and bill settings. Edit them after switching to it.</p>
        </div>
      </Modal>
    </Card>
  );
}

function Backup() {
  const { data: s } = useSession();
  const qc = useQueryClient();
  const { data: storage } = useQ('storageEstimate', []);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState('');
  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  async function backup() {
    setBusy(true);
    try {
      const bytes = await call('exportBackup', pass);
      const slug = (s?.business?.name ?? 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
      downloadBytes(bytes, `shopos-${slug}-${stamp}.shopos`);
      toast.success(pass ? 'Encrypted backup downloaded' : 'Backup downloaded (not encrypted)');
      qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!restoreFile) return;
    setBusy(true);
    try {
      const r = await call('restoreBackup', new Uint8Array(await restoreFile.arrayBuffer()), restorePass);
      toast.success(`Restored backup from ${fmtTime(r.header.created_at)}${r.health.ok ? ' · verified' : ''}`);
      setRestoreFile(null);
      await qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const mb = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1024 / 1024).toFixed(1)} MB`);
  return (
    <Card>
      <span id="backup" className="relative -top-20 block" />
      <CardTitle sub="Your shop's data is stored in this browser. Keep a copy somewhere else.">Backup &amp; restore</CardTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
          <p className="text-stone-500">Last backup</p>
          <p className="font-medium">{ago(s?.lastBackupAt)}</p>
        </div>
        <div className="rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
          <p className="text-stone-500">Storage</p>
          <p className="font-medium">{storage?.mode === 'opfs' ? 'On disk (OPFS)' : 'Memory only!'} · {mb(storage?.usage)}</p>
        </div>
        <div className="rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
          <p className="text-stone-500">Protected from clean-up</p>
          <p className="font-medium">
            {persisted ? 'Yes' : 'No'}{' '}
            {!persisted ? (
              <button className="text-brand-700 underline" onClick={() => navigator.storage?.persist?.().then(setPersisted)}>
                Ask
              </button>
            ) : null}
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <Field label="Backup passphrase" hint="Encrypts the file (AES-256). You need it to restore — it cannot be recovered.">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button variant="primary" icon={Download} loading={busy} onClick={backup}>
            Download backup
          </Button>
        </div>
        <div className="space-y-3">
          <Field label="Restore from file" hint="Replaces everything on this device with the backup">
            <Input type="file" accept=".shopos" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} className="pt-2" />
          </Field>
          {restoreFile ? (
            <Field label="Passphrase (if the backup is encrypted)">
              <Input type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
            </Field>
          ) : null}
          <Button icon={Upload} disabled={!restoreFile} loading={busy} onClick={() => confirm('Replace all data on this device with the backup?') && restore()}>
            Restore
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Sync() {
  const { data: s } = useSession();
  const qc = useQueryClient();
  const [url, setUrl] = useState(s?.hub.url ?? DEFAULT_HUB);
  const [email, setEmail] = useState(s?.hub.email ?? '');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'create' | 'login'>('create');
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof hub.devices>> | null>(null);
  const [pnl, setPnl] = useState<Awaited<ReturnType<typeof hub.pnl>> | null>(null);
  const enrolled = !!s?.hub.enrolled;

  async function connect() {
    setBusy(true);
    try {
      await hub.health(url);
      const auth = mode === 'create' ? await hub.createOrg(url, s?.business?.name ?? 'My shop', email, password) : await hub.login(url, email, password);
      const info = await call('init');
      const enrol = await hub.enrol(url, auth.access_token, info.deviceId, deviceName(), s?.seriesCode);
      await call('applyEnrolment', { url, orgId: enrol.org_id, deviceToken: enrol.device_token, seriesCode: enrol.series_code, email, jwt: auth.access_token });
      const r = await call('sync');
      toast.success(`Connected as counter ${enrol.series_code} · ${r.pushed} changes uploaded, ${r.pulled} downloaded`);
      setPassword('');
      qc.invalidateQueries();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function syncNow() {
    setBusy(true);
    try {
      const r = await call('sync');
      toast.success(`Synced · ${r.pushed} up, ${r.pulled} down`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      qc.invalidateQueries();
    }
  }
  async function loadOwnerView() {
    const jwt = await call('getMeta', 'hub_jwt');
    if (!jwt || !s?.hub.url) return toast.error('Sign in again to see devices');
    try {
      setDevices(await hub.devices(s.hub.url, jwt));
      const from = `${today().slice(0, 7)}-01`;
      setPnl(await hub.pnl(s.hub.url, jwt, from, today()));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Card>
      <span id="sync" className="relative -top-20 block" />
      <CardTitle sub="Sync bills, stock and khata between your phones, PCs and branches. Each device keeps working offline.">Sync between devices</CardTitle>
      {!enrolled ? (
        <div className="space-y-4">
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Run the ShopOS hub on a shop PC (LAN) or a server, then connect. This device uploads its history, and other devices join with the same account.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'create' ? 'primary' : 'secondary'} onClick={() => setMode('create')}>
              Create hub account
            </Button>
            <Button size="sm" variant={mode === 'login' ? 'primary' : 'secondary'} onClick={() => setMode('login')}>
              I have an account
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Hub address">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Owner email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} />
            </Field>
          </div>
          <Button variant="primary" icon={Link2} loading={busy} disabled={!email || password.length < 6} onClick={connect}>
            Connect this device
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <KeyValue
            items={[
              ['Hub', s!.hub.url],
              ['Account', s!.hub.email],
              ['This counter', <Badge key="s" tone="brand">Series {s!.seriesCode}</Badge>],
              ['Last sync', s!.hub.lastSyncAt ? `${ago(s!.hub.lastSyncAt)} (${fmtTime(s!.hub.lastSyncAt)})` : 'never'],
              ['Waiting to upload', `${s!.pendingOps} change(s)`],
              ['Hub position', `#${s!.hub.cursor}`],
            ]}
          />
          {s!.hub.lastSyncError ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{s!.hub.lastSyncError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={RefreshCw} loading={busy} onClick={syncNow}>
              Sync now
            </Button>
            <Button icon={CloudUpload} onClick={loadOwnerView}>
              Devices & all-branch profit
            </Button>
            <Button
              icon={LogOut}
              variant="ghost"
              onClick={async () => {
                if (!confirm('Stop syncing this device? Data stays on the device.')) return;
                await call('disconnectHub');
                qc.invalidateQueries();
              }}
            >
              Disconnect
            </Button>
          </div>
          {devices ? (
            <div>
              <p className="mb-1 text-sm font-medium">Devices</p>
              <ul className="divide-y divide-stone-100 text-sm dark:divide-stone-800">
                {devices.map((d) => (
                  <li key={d.device_id} className="flex justify-between py-1.5">
                    <span>
                      {d.name} <Badge className="ml-1">{d.series_code}</Badge>
                      {d.revoked_at ? <Badge tone="red" className="ml-1">Revoked</Badge> : null}
                    </span>
                    <span className="text-stone-500">seen {ago(d.last_seen_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pnl ? (
            <div>
              <p className="mb-1 text-sm font-medium">This month, all branches (from the hub)</p>
              <ul className="text-sm">
                {pnl.branches.map((b) => (
                  <li key={b.branch_id} className="flex justify-between py-0.5">
                    <span>{b.branch_name ?? 'Unknown branch'}</span>
                    <span className="tabular-nums">{(b.net_profit_paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })} profit</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Security() {
  const { data: s } = useSession();
  const act = useAct();
  const [pin, setPin] = useState('');
  return (
    <Card>
      <CardTitle sub="Asks for a PIN when ShopOS opens and after 10 minutes without use">App lock</CardTitle>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={s?.pinSet ? 'Change PIN' : 'Set a PIN (4–8 digits)'}>
          <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} className="w-40" />
        </Field>
        <Button
          variant="primary"
          icon={KeyRound}
          disabled={pin.length < 4}
          onClick={async () => {
            await act.run('setMeta', ['app_pin', await makePinRecord(pin)], 'PIN set');
            setPin('');
          }}
        >
          Save PIN
        </Button>
        {s?.pinSet ? (
          <Button variant="ghost" onClick={() => act.run('setMeta', ['app_pin', null], 'App lock removed')}>
            Remove lock
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-stone-500">The PIN protects the screen on a shared counter. It is not encryption — use your phone's lock and encrypted backups too.</p>
    </Card>
  );
}

function About() {
  const { data: s } = useSession();
  const { data: init } = useQ('init', []);
  const qc = useQueryClient();
  const [reset, setReset] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <Card>
      <CardTitle>About this device</CardTitle>
      <KeyValue
        items={[
          ['Device ID', <span key="d" className="font-mono text-xs">{s?.deviceId}</span>],
          ['Bill series', s?.seriesCode],
          ['Changes recorded', s?.totalOps],
          ['Database', `${init?.mode === 'opfs' ? 'SQLite on OPFS' : 'SQLite in memory'} · schema v${SCHEMA_VERSION}`],
          ['App version', init?.appVersion],
          ['Books locked to', s?.business?.lock_date ? fmtDate(s.business.lock_date) : 'not locked'],
        ]}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button icon={HardDrive} onClick={toggleTheme}>
          Toggle dark mode
        </Button>
        <Button variant="danger" icon={Trash2} onClick={() => setReset(true)}>
          Erase this device
        </Button>
      </div>
      <Modal
        open={reset}
        onClose={() => setReset(false)}
        title="Erase all shop data on this device?"
        size="sm"
        footer={
          <Button
            variant="danger"
            disabled={typed !== 'ERASE'}
            onClick={async () => {
              const bytes = await call('exportBackup', '');
              downloadBytes(bytes, `shopos-before-erase-${Date.now()}.shopos`);
              await call('resetShop');
              setReset(false);
              await qc.invalidateQueries();
              toast.success('Device erased. A backup was downloaded first.');
            }}
          >
            Download backup & erase
          </Button>
        }
      >
        <p className="text-sm text-stone-600 dark:text-stone-300">This cannot be undone. A backup file downloads first. Synced data on the hub is not deleted.</p>
        <Field label="Type ERASE to confirm" className="mt-3">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </Modal>
    </Card>
  );
}
