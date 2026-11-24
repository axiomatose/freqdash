import type { EquityRange, EquityResponse } from '@/shared/types/api';
import { equityChange } from '../accounting';
import { listEquity, listFlows } from '../db';
import { pricesOf } from '../poller/context';
import { modeOf, type ViewContext } from './common';

const HOUR = 3_600_000;
const RANGE_MS: Record<Exclude<EquityRange, 'all'>, number> = {
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
  '90d': 90 * 24 * HOUR,
};
export const MAX_EQUITY_POINTS = 500;

export function buildEquity(ctx: ViewContext, range: EquityRange): EquityResponse {
  const since = range === 'all' ? 0 : ctx.now - RANGE_MS[range];
  const rows = listEquity(since, MAX_EQUITY_POINTS);
  const points = rows.map((p) => ({ t: p.at, totalUsd: p.totalUsd, usdCash: p.usdCash, source: p.source }));
  const flowsAvailable =
    modeOf(ctx).mode === 'kraken' && (ctx.state.sources['kraken:ledgers']?.lastOkAt ?? null) !== null;
  const flows = flowsAvailable ? listFlows({ since }) : null;

  let change: EquityResponse['change'] = null;
  const first = points[0];
  if (ctx.state.account !== null && first !== undefined) {
    const windowMs = range === 'all' ? ctx.now - first.t : RANGE_MS[range];
    change = equityChange({
      now: ctx.now,
      currentUsd: ctx.state.account.totalUsd,
      history: points.map((p) => ({ t: p.t, totalUsd: p.totalUsd })),
      flows,
      prices: pricesOf(ctx.state),
      windowMs,
      toleranceMs: Math.max(10 * 60_000, windowMs / 10),
    });
  }
  return { generatedAt: ctx.now, points, flows, flowsAvailable, change };
}
