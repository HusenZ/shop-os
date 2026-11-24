import { Store } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { useAct, useSession } from '../lib/hooks';

/** Shown on a device that joined a multi-branch shop and has not picked its branch yet. */
export function ChooseBranch() {
  const { data: s } = useSession();
  const act = useAct();
  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold">Which branch is this device at?</h1>
      <p className="mt-1 text-sm text-stone-500">Bills, stock and cash on this device will belong to the branch you choose. You can change it later in Settings.</p>
      <div className="mt-5 space-y-3">
        {s?.branches.map((b) => (
          <Card key={b.id} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Store className="size-5 text-brand-700" />
              <div>
                <p className="font-medium">{b.name}</p>
                <p className="text-xs text-stone-500">{b.address || b.code}</p>
              </div>
            </div>
            <Button variant="primary" onClick={() => act.run('selectBranch', [b.id], `This device now bills for ${b.name}`)}>
              Choose
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
