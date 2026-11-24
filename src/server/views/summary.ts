import type { SummaryResponse } from '@/shared/types/api';
import { listFindings } from '../db';
import {
  botStatus,
  isLoopFinding,
  modeOf,
  monitorOf,
  shownFindings,
  countBySeverity,
  toLite,
  freshnessOf,
  killswitchOf,
  type ViewContext,
} from './common';

export function buildSummary(ctx: ViewContext): SummaryResponse {
  const { mode, reason } = modeOf(ctx);
  const active = listFindings({ status: 'active' });
  const { open, silenced } = shownFindings(active);
  const counts = countBySeverity(open);
  const top = open[0];

  const accountKey =
    mode === 'kraken' ? (key: string) => key === 'kraken:balance' : (key: string) => /^bot:[^:]+:balance$/.test(key);
  const fresh = freshnessOf(ctx, accountKey);
  // In freqtrade-only mode the total comes from the freshest wallet; the source that was polled most recently.
  const accountFreshness = fresh.reduce<(typeof fresh)[number] | null>(
    (best, f) => (best === null || (f.lastOkAt ?? 0) > (best.lastOkAt ?? 0) ? f : best),
    null,
  );

  return {
    generatedAt: ctx.now,
    mode,
    modeReason: reason,
    monitor: monitorOf(ctx),
    findings: { ...counts, silenced: silenced.length, top: top === undefined ? null : toLite(top) },
    accountTotalUsd: ctx.state.account?.totalUsd ?? null,
    accountFreshness,
    killswitch: killswitchOf(ctx),
    bots: Object.values(ctx.state.bots).map((b) => ({
      botId: b.botId,
      name: b.name,
      color: b.color,
      status: botStatus(
        b,
        ctx.now,
        active.some((f) => isLoopFinding(f, b.botId)),
      ),
    })),
  };
}
