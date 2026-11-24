'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import { formatClock } from '@/lib/client/format';
import { usePrefs } from '@/lib/client/prefs';
import { FreshnessDot } from './FreshnessDot';
import { useResolveSources } from './FreshnessProvider';
import { summarizeFreshness, type SourceRef } from './freshness';

export interface MetricProps {
  /** The rendered number (a <Money/>, <Qty/>, <Pct/> or any node). */
  value: ReactNode;
  /** Every source the number depends on; the worst state wins. Keys resolve through <FreshnessProvider>. */
  sources: readonly SourceRef[];
  /** Show "as of 14:32" beside stale values (turn off in tight table cells; the popover still says it). */
  asOf?: boolean;
  className?: string;
}

/**
 * Wraps any number that comes from a bot or from Kraken: value + freshness dot. Stale and error values stay
 * visible but muted with an "as of HH:MM" label; hover (desktop) or tap (touch) on the dot lists each source.
 */
export function Metric({ value, sources, asOf = true, className }: MetricProps) {
  const resolved = useResolveSources(sources);
  const { utc } = usePrefs();
  const summary = summarizeFreshness(resolved.sources, resolved.offline);

  return (
    <span
      data-slot="metric"
      data-freshness={summary.state ?? 'unknown'}
      className={cn('inline-flex max-w-full items-baseline gap-1.5', className)}
    >
      <span className={cn('min-w-0', summary.muted && 'text-muted [&_*]:text-muted!')}>{value}</span>
      {summary.muted && asOf && summary.asOf !== null ? (
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted">
          as of {formatClock(summary.asOf, utc)}
        </span>
      ) : null}
      {summary.state ? (
        <FreshnessDot state={summary.state} items={summary.items} offline={resolved.offline} className="self-center" />
      ) : null}
    </span>
  );
}
