import { Suspense } from 'react';
import { TradesView } from '@/components/trades/TradesView';

export default function Page() {
  return (
    <Suspense>
      <TradesView />
    </Suspense>
  );
}
