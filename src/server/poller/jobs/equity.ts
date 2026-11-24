import { CADENCE_MS } from '@/shared/constants';
import { insertEquitySnapshot } from '../../db';
import type { PollerContext } from '../context';

// equity.snapshot every 5 minutes: Kraken source when the account total comes from Kraken, else the bot-wallet estimate.
export async function equityJob(ctx: PollerContext): Promise<void> {
  const s = ctx.store.get();
  const account = s.account;
  if (account === null) return;
  insertEquitySnapshot({
    at: ctx.now(),
    source: account.source,
    totalUsd: account.totalUsd,
    usdCash: account.usdCash,
    botPositionsUsd: s.allocation === null ? null : s.allocation.botPositions.reduce((acc, p) => acc + p.valueUsd, 0),
    untrackedUsd: s.allocation?.untrackedUsd ?? null,
    holdings: account.holdings,
    unpricedAssets: account.unpricedAssets,
  });
  ctx.touchCycle();
}

export function registerEquityJob(ctx: PollerContext): void {
  ctx.scheduler.add({
    name: 'equity.snapshot',
    cadenceMs: CADENCE_MS['equity.snapshot'],
    startDelayMs: 15_000,
    run: () => equityJob(ctx),
  });
}
