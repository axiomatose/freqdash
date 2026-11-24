'use client';

import Link from 'next/link';
import { OctagonAlert } from 'lucide-react';
import { useSummary } from '@/lib/client/queries';
import type { KillswitchInfo } from '@/shared/types/api';

/** Sticky red banner while the killswitch is latched; it stays until someone resets it on the Status page. */
export function KillswitchBannerView({ info }: { info: KillswitchInfo }) {
  const t = info.tripped;
  if (t === null) return null;
  const failed = t.bots.filter((b) => b.status === 'failed' || b.status === 'not-stoppable');
  return (
    <div
      data-slot="killswitch-banner"
      role="alert"
      className="tint-critical flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm lg:px-6"
    >
      <OctagonAlert aria-hidden className="size-4 shrink-0 text-critical-fg" />
      <span className="font-semibold text-critical-fg">
        {t.dryRun ? 'Killswitch would have tripped (dry run)' : 'Killswitch tripped'}
      </span>
      <span>
        {t.count} buys of {t.pair}
        {t.dryRun ? '' : `: ${t.bots.map((b) => `${b.botId} ${b.status}`).join(', ')}`}
        {failed.length > 0 && !t.dryRun ? ' — check the bots yourself' : ''}
      </span>
      <Link href="/status" className="ml-auto text-accent hover:underline">
        Status
      </Link>
    </div>
  );
}

export function KillswitchBanner() {
  const { data } = useSummary();
  return data ? <KillswitchBannerView info={data.killswitch} /> : null;
}
