import type { PositionsResponse } from '@/shared/types/api';
import type { Acknowledgement } from '@/shared/types/domain';
import { buildManualPositions } from '../accounting';
import { getKnownOrders, listAcks, listKrakenOrders, listLedgerEntries } from '../db';
import { freshnessOf, modeOf, type ViewContext } from './common';

/** Kraken orders that are not the user's own: every order a bot owns, and those acknowledged as ignored. */
export function excludedTxids(ctx: ViewContext, acks: readonly Acknowledgement[]): Set<string> {
  const exclude = new Set<string>(Object.keys(getKnownOrders()));
  for (const bot of Object.values(ctx.state.bots)) {
    for (const t of [...bot.openTrades, ...bot.closedTrades]) for (const o of t.orders) exclude.add(o.orderId);
  }
  for (const a of acks) if (a.kind === 'kraken_order' && a.label === 'ignored') exclude.add(a.subject);
  return exclude;
}

/** Manual holdings with a cost basis derived from the Kraken orders no bot owns. Needs Kraken order history. */
export function buildPositions(ctx: ViewContext): PositionsResponse {
  const { mode, reason } = modeOf(ctx);
  const enabled = ctx.kraken.configured && ctx.state.allocation !== null;
  const base = {
    generatedAt: ctx.now,
    mode,
    modeReason: reason,
    enabled,
    historyStartAt: ctx.kraken.reconStartAt,
    sources: freshnessOf(ctx, (k) => k.startsWith('kraken:')),
  };
  const totals = { valueUsd: 0, costBasisUsd: 0, unrealizedUsd: 0, realizedUsd: 0, feesUsd: 0 };
  if (!enabled || ctx.state.allocation === null) return { ...base, positions: [], totals };

  const acks = listAcks(ctx.now);
  const exclude = excludedTxids(ctx, acks);

  const positions = buildManualPositions({
    allocation: ctx.state.allocation,
    acks,
    orders: listKrakenOrders({ order: 'asc' }),
    excludeTxids: exclude,
    ledger: listLedgerEntries(),
  });
  for (const p of positions) {
    totals.valueUsd += p.valueUsd ?? 0;
    totals.costBasisUsd += p.costBasisUsd ?? 0;
    totals.unrealizedUsd += p.unrealizedUsd ?? 0;
    totals.realizedUsd += p.realizedUsd;
    totals.feesUsd += p.feesUsd;
  }
  return { ...base, positions, totals };
}
