import { daysBetween } from '@shopos/core';
import { HandCoins, Send, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Card, Empty, Loading, PageHeader, Stat, Table, Tabs } from '../components/ui';
import { inr, today } from '../lib/format';
import { useQ, useSession } from '../lib/hooks';
import { reminderMessage, whatsappLink } from '../lib/share';
import { PaymentDialog } from './Parties';

function ageTone(days: number) {
  return days > 60 ? 'red' : days > 30 ? 'amber' : 'neutral';
}

export default function Khata() {
  const { data: s } = useSession();
  const [tab, setTab] = useState<'get' | 'give'>('get');
  const [pay, setPay] = useState<any | null>(null);
  const { data: customers } = useQ('listParties', [{ kind: 'customer', withBalance: true }]);
  const { data: suppliers } = useQ('listParties', [{ kind: 'supplier', withBalance: true }]);
  const get = (customers ?? []).filter((p) => p.receivable_paise > 0);
  const give = (suppliers ?? []).filter((p) => p.payable_paise > 0);
  const totalGet = get.reduce((t, p) => t + p.receivable_paise, 0);
  const totalGive = give.reduce((t, p) => t + p.payable_paise, 0);
  const list = tab === 'get' ? get : give;

  return (
    <div>
      <PageHeader title="Khata" sub="Credit given to customers and owed to suppliers" />
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="You'll get" value={inr(totalGet, true)} sub={`${get.length} customers`} icon={Wallet} tone="amber" />
        <Stat label="You'll give" value={inr(totalGive, true)} sub={`${give.length} suppliers`} icon={HandCoins} tone="blue" />
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'get', label: `You'll get (${get.length})` }, { id: 'give', label: `You'll give (${give.length})` }]} />
      <Card>
        {!customers || !suppliers ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty icon={Wallet} title={tab === 'get' ? 'No one owes you money' : 'You owe nothing'} text="Credit bills and supplier bills appear here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Oldest due</th>
                <th className="text-right!">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const amount = tab === 'get' ? p.receivable_paise : p.payable_paise;
                const age = p.oldest_debit_date ? daysBetween(p.oldest_debit_date, today()) : 0;
                const over = p.credit_limit_paise && amount > p.credit_limit_paise;
                return (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/parties/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <span className="block text-xs text-stone-500">{p.phone ?? 'No phone'}</span>
                    </td>
                    <td>
                      {tab === 'get' ? <Badge tone={ageTone(age)}>{age} days</Badge> : null}
                      {over ? <Badge tone="red" className="ml-1">Over limit</Badge> : null}
                    </td>
                    <td className="text-right font-semibold tabular-nums">{inr(amount)}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        {tab === 'get' && p.phone ? (
                          <Button
                            size="sm"
                            icon={Send}
                            onClick={() => window.open(whatsappLink(p.phone, reminderMessage({ shop: s?.business?.name ?? 'our shop', name: p.name, due: amount, upiId: s?.branch?.upi_id })), '_blank', 'noopener')}
                          >
                            Remind
                          </Button>
                        ) : null}
                        <Button size="sm" variant="primary" onClick={() => setPay(p)}>
                          {tab === 'get' ? 'Receive' : 'Pay'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {pay ? <PaymentDialog party={pay} open onClose={() => setPay(null)} /> : null}
    </div>
  );
}
