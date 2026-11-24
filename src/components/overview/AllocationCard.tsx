'use client';

import { Metric, Money, Pct } from '@/components/data';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/utils';
import type { Allocation } from '@/shared/types/domain';
import { allocationSegments } from './allocation';

export function AllocationCard({
  allocation,
  bots,
  sources,
  className,
}: {
  allocation: Allocation | null;
  bots: readonly { botId: string; name: string; color: string }[];
  sources: readonly string[];
  className?: string;
}) {
  const segments = allocation === null ? [] : allocationSegments(allocation, bots);
  return (
    <Card className={className} data-testid="allocation-card">
      <CardHeader>
        <CardTitle>Allocation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {allocation === null ? (
          <p className="text-sm text-muted">No account data yet.</p>
        ) : (
          <>
            <div
              role="img"
              aria-label={`Allocation of ${segments.map((s) => `${s.label} ${s.pct.toFixed(0)} percent`).join(', ')}`}
              className="flex h-4 w-full overflow-hidden rounded-full bg-surface-2"
            >
              {segments.map((s) => (
                <div
                  key={s.key}
                  data-segment={s.key}
                  className={cn('h-full', s.striped && 'bg-stripes-critical')}
                  style={{ width: `${s.pct}%`, ...(s.color === null ? {} : { backgroundColor: s.color }) }}
                />
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {segments.map((s) => (
                <li key={s.key} className="flex min-w-0 flex-col" data-legend={s.key}>
                  <span className="flex items-center gap-1.5 text-muted">
                    <span
                      aria-hidden
                      className={cn('inline-block size-2.5 shrink-0 rounded-sm', s.striped && 'bg-stripes-critical')}
                      style={s.color === null ? undefined : { backgroundColor: s.color }}
                    />
                    <span className={cn('truncate', s.key === 'untracked' && 'font-medium text-critical-fg')}>
                      {s.label}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <Metric value={<Money value={s.usd} />} sources={sources} asOf={false} />
                    <span className="text-xs text-muted">
                      <Pct value={null} points={s.pct} dp={0} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
