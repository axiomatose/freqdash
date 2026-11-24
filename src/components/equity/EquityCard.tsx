'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { EmptyState, ErrorState, Money, Pct, SkeletonRows } from '@/components/data';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEquity } from '@/lib/client/queries';
import type { EquityRange } from '@/shared/types/api';
import { equitySeries } from './equitySeries';

const EquityPlot = dynamic(() => import('./EquityPlot'), { ssr: false, loading: () => <SkeletonRows rows={5} /> });

const RANGES: { value: EquityRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

export function EquityCard({ className }: { className?: string }) {
  const [range, setRange] = useState<EquityRange>('7d');
  const q = useEquity(range);
  const series = useMemo(() => (q.data ? equitySeries(q.data) : null), [q.data]);
  const count = series ? series.kraken.length + series.botWallet.length : 0;
  return (
    <Card className={className} data-testid="equity-card">
      <CardHeader>
        <CardTitle>Equity</CardTitle>
        <CardAction>
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(v) => v && setRange(v as EquityRange)}
            aria-label="Range"
          >
            {RANGES.map((r) => (
              <ToggleGroupItem key={r.value} value={r.value} aria-label={r.label}>
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {q.data === undefined ? (
          q.isError ? (
            <ErrorState inline error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
          ) : (
            <SkeletonRows rows={5} />
          )
        ) : count < 2 ? (
          <EmptyState
            title="Collecting history"
            description="Snapshots are taken every 5 minutes; the chart appears after the second one."
          />
        ) : (
          <>
            {q.data.change ? (
              <p className="flex flex-wrap items-baseline gap-2 text-sm text-muted">
                Change over range: <Money value={q.data.change.usd} signed />{' '}
                <Pct value={null} points={q.data.change.pct} signed />
              </p>
            ) : null}
            <div className="h-[180px] lg:h-[260px]">{series ? <EquityPlot data={series} /> : null}</div>
            {q.data.points.some((p) => p.source === 'bot-wallet') ? (
              <p className="text-xs text-muted">Dashed: estimated from a bot wallet, not from Kraken.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
