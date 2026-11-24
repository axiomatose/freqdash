'use client';

import Link from 'next/link';
import { Unplug, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { dismissFor, useDismissed } from '@/lib/client/prefs';
import { useSummary } from '@/lib/client/queries';

export const MODE_BANNER_KEY = 'mode-banner';

export interface ModeBannerViewProps {
  /** SummaryResponse.modeReason, for example "No Kraken key". */
  reason: string | null;
  onDismiss?: () => void;
  className?: string;
}

/** Amber-outline notice for freqtrade-only mode. Dismissible for 24 h; the top bar badge stays. */
export function ModeBannerView({ reason, onDismiss, className }: ModeBannerViewProps) {
  return (
    <div
      data-slot="mode-banner"
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-xl border border-warning/50 bg-warning/[0.06] py-2.5 pr-1.5 pl-3.5',
        className,
      )}
    >
      <Unplug aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-text">
        <span className="font-semibold text-warning">{reason ?? 'No Kraken key'}:</span> totals are estimated from bot
        wallet caches (may be up to 1 h stale) and Kraken order reconciliation is disabled.{' '}
        <Link
          href="/status#kraken"
          className="font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
        >
          Status → Kraken setup
        </Link>
      </p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide for 24 hours"
          title="Hide for 24 hours"
          className="-my-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:size-9"
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ModeBanner({ className }: { className?: string }) {
  const { data } = useSummary();
  const dismissed = useDismissed(MODE_BANNER_KEY);
  if (!data || data.mode !== 'freqtrade-only' || dismissed) return null;
  return (
    <ModeBannerView reason={data.modeReason} onDismiss={() => dismissFor(MODE_BANNER_KEY)} className={className} />
  );
}
