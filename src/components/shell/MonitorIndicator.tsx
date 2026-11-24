'use client';

import { Loader, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '@/components/data/useNow';
import { cn } from '@/components/ui/utils';
import { formatAgo } from '@/lib/client/format';
import { useSummary } from '@/lib/client/queries';
import type { Ms } from '@/shared/types/domain';

export type MonitorState = 'connecting' | 'live' | 'stalled' | 'offline';

export interface MonitorIndicatorViewProps {
  state: MonitorState;
  /** When the checks engine last ran (falls back to the poller's last cycle). */
  checkedAt: Ms | null;
  now: Ms | null;
  /** Phone layout: drops the "checked" wording. */
  compact?: boolean;
  className?: string;
}

/** "Live · checked 4 s ago", or a red "Monitoring stalled" / "Offline". Always a word, never just a coloured dot. */
export function MonitorIndicatorView({ state, checkedAt, now, compact, className }: MonitorIndicatorViewProps) {
  const ago = checkedAt !== null && now !== null ? formatAgo(checkedAt, now) : null;
  const base = 'inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap';

  if (state === 'stalled') {
    return (
      <span data-monitor="stalled" className={cn(base, 'font-medium text-critical-fg', className)}>
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{compact ? 'Stalled' : 'Monitoring stalled'}</span>
        {!compact && ago ? <span className="font-normal text-muted">· last check {ago}</span> : null}
      </span>
    );
  }
  if (state === 'offline') {
    return (
      <span data-monitor="offline" className={cn(base, 'font-medium text-critical-fg', className)}>
        <WifiOff aria-hidden className="size-3.5 shrink-0" />
        Offline
      </span>
    );
  }
  if (state === 'connecting') {
    return (
      <span data-monitor="connecting" className={cn(base, 'text-muted', className)}>
        <Loader aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
        Connecting
      </span>
    );
  }
  return (
    <span data-monitor="live" className={cn(base, 'text-muted', className)}>
      <span aria-hidden className="relative flex size-2 shrink-0">
        <span className="absolute inset-0 rounded-full bg-positive motion-safe:animate-ping-slow" />
        <span className="relative size-2 rounded-full bg-positive" />
      </span>
      <span className="font-medium text-text">Live</span>
      {ago ? (
        <span className="truncate">
          · {compact ? '' : 'checked '}
          {ago}
        </span>
      ) : null}
    </span>
  );
}

export function MonitorIndicator({ compact, className }: { compact?: boolean; className?: string }) {
  const { data, isError, isPending } = useSummary();
  const now = useNow();
  const state: MonitorState = isError
    ? 'offline'
    : isPending && !data
      ? 'connecting'
      : data?.monitor.stalled
        ? 'stalled'
        : 'live';
  const checkedAt = data ? (data.monitor.lastEvalAt ?? data.monitor.lastCycleAt) : null;
  return <MonitorIndicatorView state={state} checkedAt={checkedAt} now={now} compact={compact} className={className} />;
}
