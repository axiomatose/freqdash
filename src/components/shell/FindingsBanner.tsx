'use client';

import Link from 'next/link';
import { ChevronRight, OctagonAlert, TriangleAlert } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useSummary } from '@/lib/client/queries';
import type { FindingLite } from '@/shared/types/api';

export interface FindingsBannerViewProps {
  critical: number;
  warning: number;
  /** The most important active finding; its title is the banner text. */
  top: Pick<FindingLite, 'title'> | null;
  href?: string;
  /** Sticky under the top bar (the shell). Turn off to show it in flow (ui-kit). */
  sticky?: boolean;
  className?: string;
}

/**
 * Critical: red and sticky. Warnings only: amber. Nothing at all when everything is clear.
 * "2 critical: Orphan Kraken orders on ETH/USD (26 · $293.70)", plus "+1 warning" when both kinds exist.
 */
export function FindingsBannerView({
  critical,
  warning,
  top,
  href = '/findings',
  sticky = true,
  className,
}: FindingsBannerViewProps) {
  if (critical + warning <= 0) return null;
  const isCritical = critical > 0;
  const Icon = isCritical ? OctagonAlert : TriangleAlert;
  const count = isCritical ? critical : warning;
  const word = isCritical ? 'critical' : warning === 1 ? 'warning' : 'warnings';
  return (
    <div
      data-slot="findings-banner"
      data-severity={isCritical ? 'critical' : 'warning'}
      role="region"
      aria-label="Findings"
      className={cn(
        'border-b',
        isCritical ? 'tint-critical' : 'tint-warning',
        sticky && 'sticky top-[var(--shell-top)] z-30',
        className,
      )}
    >
      <Link
        href={href}
        className="flex min-h-11 items-center gap-2.5 px-4 py-2 outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent lg:min-h-10 lg:px-6"
      >
        <Icon aria-hidden className={cn('size-4 shrink-0', isCritical ? 'text-critical-fg' : 'text-warning')} />
        <p className="min-w-0 flex-1 truncate text-[13px] text-text">
          <span className={cn('font-semibold', isCritical ? 'text-critical-fg' : 'text-warning')}>
            {count} {word}
          </span>
          {top ? <span>: {top.title}</span> : null}
        </p>
        {isCritical && warning > 0 ? (
          <span className="hidden shrink-0 rounded-md border border-warning/40 px-1.5 py-0.5 text-[11px] font-medium text-warning sm:inline">
            +{warning} warning{warning === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="hidden shrink-0 items-center gap-0.5 text-xs font-medium text-text/80 lg:flex">
          View findings
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-text/60" />
      </Link>
    </div>
  );
}

/** Live banner for the shell; the shell's sticky wrapper positions it, so it renders in flow here. */
export function FindingsBanner() {
  const { data } = useSummary();
  if (!data) return null;
  return (
    <FindingsBannerView
      critical={data.findings.critical}
      warning={data.findings.warning}
      top={data.findings.top}
      sticky={false}
    />
  );
}
