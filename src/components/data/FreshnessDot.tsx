'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/components/ui/utils';
import { formatAgo, formatClock } from '@/lib/client/format';
import { usePrefs } from '@/lib/client/prefs';
import type { FreshnessState } from '@/shared/types/domain';
import { STATE_LABEL, type FreshnessItem, type OfflineInfo } from './freshness';
import { useNow } from './useNow';

const DOT: Record<FreshnessState, string> = {
  fresh: 'bg-positive',
  aging: 'bg-warning',
  // Hollow rings tell stale/disabled apart from aging/fresh without relying on hue alone.
  stale: 'border-[1.5px] border-warning',
  error: 'bg-critical',
  disabled: 'border-[1.5px] border-muted/70',
};

/** The bare coloured dot (no interaction). Green fresh, amber aging/stale, red error, grey disabled. */
export function DotMark({ state, className }: { state: FreshnessState; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[state], className)} />;
}

export interface FreshnessDotProps {
  state: FreshnessState;
  /** With items, the dot is a button that opens the details popover on hover (mouse) or tap/Enter. */
  items?: readonly FreshnessItem[];
  offline?: OfflineInfo | null;
  className?: string;
}

export function FreshnessDot({ state, items, offline, className }: FreshnessDotProps) {
  if (!items || items.length === 0) {
    return (
      <span role="img" aria-label={`Data ${STATE_LABEL[state].toLowerCase()}`} className={cn('inline-flex', className)}>
        <DotMark state={state} />
      </span>
    );
  }
  return <InteractiveDot state={state} items={items} offline={offline ?? null} className={className} />;
}

const HOVER_CLOSE_MS = 120;

interface InteractiveDotProps {
  state: FreshnessState;
  items: readonly FreshnessItem[];
  offline: OfflineInfo | null;
  className?: string;
}

function InteractiveDot({ state, items, offline, className }: InteractiveDotProps) {
  const [open, setOpen] = useState(false);
  const pointerType = useRef<string>('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const summary = items.map((i) => `${i.label} ${STATE_LABEL[i.state].toLowerCase()}`).join(', ');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Data freshness: ${summary}`}
          data-freshness-dot={state}
          className={cn(
            "relative inline-flex size-2 shrink-0 items-center justify-center rounded-full outline-none before:absolute before:-inset-3 before:content-[''] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            className,
          )}
          onPointerDown={(e) => {
            pointerType.current = e.pointerType;
          }}
          onPointerEnter={(e) => {
            pointerType.current = e.pointerType;
            if (e.pointerType === 'mouse') {
              cancelClose();
              setOpen(true);
            }
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') scheduleClose();
          }}
          onClick={(e) => {
            // A mouse click after hover pins the popover open instead of toggling it shut.
            if (pointerType.current === 'mouse') {
              e.preventDefault();
              cancelClose();
              setOpen(true);
            }
          }}
        >
          <DotMark state={state} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-72"
        onPointerEnter={cancelClose}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') scheduleClose();
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <FreshnessDetails items={items} offline={offline} />
      </PopoverContent>
    </Popover>
  );
}

/** Popover body: one row per source ("Kraken balance · 12 s ago"), with the redacted error when there is one. */
export function FreshnessDetails({
  items,
  offline,
}: {
  items: readonly FreshnessItem[];
  offline?: OfflineInfo | null;
}) {
  const now = useNow();
  const { utc } = usePrefs();
  return (
    <div className="flex flex-col gap-2.5">
      <p className="eyebrow">Data freshness</p>
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.source} className="flex items-start gap-2">
            <DotMark state={i.state} className="mt-[5px]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-text">
                {i.label}
                <span className="text-muted">
                  {' · '}
                  {i.lastOkAt === null
                    ? 'never updated'
                    : now === null
                      ? formatClock(i.lastOkAt, utc)
                      : formatAgo(i.lastOkAt, now)}
                </span>
              </p>
              {i.error ? <p className="mt-0.5 text-xs break-words text-critical-fg">{i.error}</p> : null}
            </div>
            <span className="shrink-0 text-[11px] leading-5 text-muted">{STATE_LABEL[i.state]}</span>
          </li>
        ))}
      </ul>
      {offline ? (
        <p className="border-t pt-2 text-xs text-muted">
          Dashboard offline{offline.since ? ` since ${formatClock(offline.since, utc)}` : ''}: showing the last data
          received.
        </p>
      ) : null}
    </div>
  );
}
