import { CheckCircle2, History, RefreshCw, Search, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Badge, Button, Card, CardTitle, Empty, Input, Loading, PageHeader, Table, Tabs } from '../components/ui';
import { fmtTime } from '../lib/format';
import { useAct, useDebounced, useQ } from '../lib/hooks';

const TYPE_LABEL: Record<string, string> = {
  'sale.issued': 'Bill issued',
  'sale.returned': 'Return / credit note',
  'sale.voided': 'Bill voided',
  'purchase.recorded': 'Purchase recorded',
  'payment.received': 'Payment received',
  'payment.made': 'Payment made',
  'expense.recorded': 'Expense',
  'stock.opening': 'Opening stock',
  'stock.adjusted': 'Stock adjusted',
  'stock.transferred': 'Stock transfer',
  'day.closed': 'Day closed',
  'books.locked': 'Books locked',
  'books.unlocked': 'Books unlocked',
};

function describe(op: any) {
  if (TYPE_LABEL[op.type]) return TYPE_LABEL[op.type];
  if (op.kind === 'patch') {
    const verb = op.payload.create ? 'created' : 'changed';
    const what = op.entity.replace(/s$/, '').replace(/_/g, ' ');
    return `${what[0].toUpperCase()}${what.slice(1)} ${verb}`;
  }
  return op.type;
}

function patchSummary(op: any) {
  if (op.kind !== 'patch') return null;
  const set = op.payload.set ?? {};
  const before = op.payload.before ?? {};
  const name = set.name ?? '';
  if (op.payload.create) return name;
  return Object.keys(set)
    .map((k) => `${k.replace(/_paise$/, '').replace(/_/g, ' ')}: ${before[k] ?? '—'} → ${set[k] ?? '—'}`)
    .join(' · ');
}

export default function Audit() {
  const [tab, setTab] = useState<'log' | 'exceptions' | 'health'>('log');
  const { data: ex = [] } = useQ('listExceptions', [{ status: 'open' }]);
  return (
    <div>
      <PageHeader title="Audit & health" sub="Every change is recorded in a tamper-evident log" />
      <Tabs value={tab} onChange={setTab} items={[{ id: 'log', label: 'Activity log' }, { id: 'exceptions', label: `Exceptions${ex.length ? ` (${ex.length})` : ''}` }, { id: 'health', label: 'Health check' }]} />
      {tab === 'log' && <Log />}
      {tab === 'exceptions' && <Exceptions />}
      {tab === 'health' && <Health />}
    </div>
  );
}

function Log() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q, 250);
  const { data } = useQ('listOps', [{ limit: 200, q: dq || undefined }]);
  return (
    <Card>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by type, table or user" className="pl-9" />
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty icon={History} title="No activity" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Who</th>
              <th>Device</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {data.map((op) => (
              <Fragment key={op.op_id}>
                <tr className="cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => setOpen(open === op.op_id ? null : op.op_id)}>
                  <td className="text-stone-500">{fmtTime(op.created_at)}</td>
                  <td>
                    <span className="font-medium">{describe(op)}</span>
                    <span className="block max-w-md truncate text-xs text-stone-500">{patchSummary(op)}</span>
                  </td>
                  <td>{op.user_id}</td>
                  <td className="font-mono text-xs text-stone-500">{op.device_id.slice(-6)}</td>
                  <td>{op.origin === 'remote' ? <Badge tone="blue">From other device</Badge> : op.seq ? <Badge tone="green">Synced #{op.seq}</Badge> : <Badge>Local</Badge>}</td>
                </tr>
                {open === op.op_id ? (
                  <tr key={`${op.op_id}-x`}>
                    <td colSpan={5}>
                      <p className="mb-1 font-mono text-[11px] text-stone-500">
                        hash {op.hash.slice(0, 16)}… · prev {op.prev_hash ? `${op.prev_hash.slice(0, 16)}…` : '—'} · hlc {op.hlc.slice(0, 20)}
                      </p>
                      <pre className="max-h-72 overflow-auto rounded-lg bg-stone-100 p-3 text-[11px] dark:bg-stone-800">{JSON.stringify(op.payload, null, 2)}</pre>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Exceptions() {
  const act = useAct();
  const { data = [] } = useQ('listExceptions', [{}]);
  return (
    <Card>
      <CardTitle sub="Things only sync can reveal — e.g. the last unit sold on two counters while offline">Exceptions</CardTitle>
      {data.length === 0 ? (
        <Empty icon={ShieldCheck} title="Nothing needs attention" />
      ) : (
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {data.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <ShieldAlert className={`size-4 ${x.status === 'open' ? 'text-amber-600' : 'text-stone-400'}`} />
                  {x.message}
                </p>
                <p className="text-xs text-stone-500">
                  {x.kind.replace(/_/g, ' ')} · {fmtTime(x.created_at)} {x.status !== 'open' ? `· ${x.status}` : ''}
                </p>
              </div>
              {x.status === 'open' ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => act.run('resolveException', [x.id, 'ignored'])}>
                    Ignore
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => act.run('resolveException', [x.id, 'resolved'], 'Marked resolved')}>
                    Resolved
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Health() {
  const act = useAct();
  const { data, refetch, isFetching } = useQ('healthCheck', []);
  return (
    <Card>
      <CardTitle
        sub="Rebuilds every total from the raw records and compares"
        action={
          <div className="flex gap-2">
            <Button size="sm" icon={RefreshCw} loading={isFetching} onClick={() => refetch()}>
              Run again
            </Button>
            <Button size="sm" onClick={() => act.run('rebuildDerived', [], 'Totals rebuilt from the ledger')}>
              Rebuild totals
            </Button>
          </div>
        }
      >
        Health check {data ? data.ok ? <Badge tone="green">All good</Badge> : <Badge tone="red">Problems found</Badge> : null}
      </CardTitle>
      {!data ? (
        <Loading />
      ) : (
        <ul className="space-y-2">
          {data.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2 text-sm">
              {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose-600" />}
              <span>
                <span className="font-medium">{c.name}</span>
                <span className="block text-xs text-stone-500">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
