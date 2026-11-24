'use client';

import { RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { describeError, isApiError } from '@/lib/client/api';
import { formatClock } from '@/lib/client/format';
import { usePrefs } from '@/lib/client/prefs';
import type { Ms } from '@/shared/types/domain';

export interface ErrorStateProps {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * When the last successful response arrived (react-query's `dataUpdatedAt`). With it the state reads
   * "Offline since 14:32" and the caller keeps showing the last data underneath.
   */
  offlineSince?: Ms | null;
  /** Slim single-row variant to sit above data that is still on screen. */
  inline?: boolean;
  className?: string;
}

/** Inline error card with retry: "Couldn't load overview" or, over stale data, "Offline since 14:32". */
export function ErrorState({ error, title, onRetry, retrying, offlineSince, inline, className }: ErrorStateProps) {
  const { utc } = usePrefs();
  const network = isApiError(error) && error.kind === 'network';
  const Icon = network ? WifiOff : TriangleAlert;
  const since = offlineSince ? formatClock(offlineSince, utc) : null;
  const heading =
    title ?? (since ? `Offline since ${since}` : network ? 'Cannot reach the server' : "Couldn't load this data");
  const message = error !== undefined ? describeError(error) : null;

  const retry = onRetry ? (
    <Button
      variant="secondary"
      size={inline ? 'sm' : 'default'}
      onClick={onRetry}
      disabled={retrying}
      className="shrink-0"
    >
      <RefreshCw className={cn(retrying && 'motion-safe:animate-spin')} aria-hidden />
      Retry
    </Button>
  ) : null;

  if (inline) {
    return (
      <div
        role="alert"
        data-slot="error-state"
        className={cn(
          'flex items-center gap-2.5 rounded-lg border border-critical/35 bg-critical/10 px-3 py-2',
          className,
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-critical-fg" />
        <p className="min-w-0 flex-1 text-[13px] text-text">
          <span className="font-medium">{heading}</span>
          {since ? (
            <span className="text-muted"> · showing the last data received</span>
          ) : message ? (
            <span className="text-muted"> · {message}</span>
          ) : null}
        </p>
        {retry}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-critical/35 bg-critical/8 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-full border border-critical/40 bg-critical/15 text-critical-fg">
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-text">{heading}</p>
        {message ? <p className="text-[13px] text-muted">{message}</p> : null}
      </div>
      {retry}
    </div>
  );
}
