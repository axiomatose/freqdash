import { APP_VERSION } from '@/shared/constants';
import type { StatusResponse } from '@/shared/types/api';
import { getDbStats } from '../db';
import { freshnessOf, killswitchOf, modeOf, type ViewContext } from './common';

export function buildStatus(ctx: ViewContext): StatusResponse {
  const s = ctx.state;
  const { mode, reason } = modeOf(ctx);
  return {
    generatedAt: ctx.now,
    version: APP_VERSION,
    startedAt: s.monitor.startedAt ?? ctx.now,
    mode,
    modeReason: reason,
    kraken: {
      configured: ctx.kraken.configured,
      status: s.kraken.status,
      reason: s.kraken.statusReason,
      permissionDenied: s.kraken.permissionDenied,
      backfillComplete: s.kraken.backfillComplete,
      reconStartAt: ctx.kraken.reconStartAt,
      tier: ctx.kraken.tier,
    },
    sources: freshnessOf(ctx),
    logTails: Object.values(s.bots).map((b) => ({
      botId: b.botId,
      file: b.logTail.file,
      configured: b.logTail.configured,
      available: b.logTail.available,
      lastLineAt: b.logTail.lastLineAt,
      error: b.logTail.error,
    })),
    notifier: s.notifier,
    db: getDbStats(),
    clockSkewMs: s.market.clockSkewMs,
    killswitch: killswitchOf(ctx),
  };
}
