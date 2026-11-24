import { Suspense } from 'react';
import { ChartView } from '@/components/chart/ChartView';

export default function Page() {
  return (
    <Suspense>
      <ChartView />
    </Suspense>
  );
}
