'use client';

import { cn } from '@/components/ui/utils';
import { DASH, formatAgo, formatClock, formatDateTime, formatFull } from '@/lib/client/format';
import { usePrefs } from '@/lib/client/prefs';
import type { Ms } from '@/shared/types/domain';
import { useNow } from './useNow';

/** "12 s ago", ticking every second. The hover title shows the exact time in the chosen zone. */
export function TimeAgo({ at, className, prefix }: { at: Ms | null | undefined; className?: string; prefix?: string }) {
  const now = useNow();
  const { utc } = usePrefs();
  if (at === null || at === undefined) return <span className={cn('text-muted', className)}>{DASH}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatFull(at, utc)} className={className}>
      {prefix}
      {now === null ? formatClock(at, utc) : formatAgo(at, now)}
    </time>
  );
}

/** An absolute time in local or UTC (per the Prefs toggle). `format`: clock = 14:32, datetime = Sep 28, 14:32. */
export function Time({
  at,
  format = 'datetime',
  className,
}: {
  at: Ms | null | undefined;
  format?: 'clock' | 'datetime';
  className?: string;
}) {
  const { utc } = usePrefs();
  if (at === null || at === undefined) return <span className={cn('text-muted', className)}>{DASH}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatFull(at, utc)} className={className}>
      {format === 'clock' ? formatClock(at, utc) : formatDateTime(at, utc)}
    </time>
  );
}
