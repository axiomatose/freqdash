import type { OrderMatch, TradesResponse, TradesStatusFilter } from '@/shared/types/api';
import type { BotId, KrakenOrder, Ms, Pair } from '@/shared/types/domain';
import { listKrakenOrders } from '../db';
import { freshnessOf, matchOrder, modeOf, type ViewContext } from './common';

export interface TradesQuery {
  bot?: BotId | undefined;
  pair?: Pair | undefined;
  status?: TradesStatusFilter | undefined;
  since?: Ms | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function buildTrades(ctx: ViewContext, q: TradesQuery): TradesResponse {
  const status = q.status ?? 'all';
  const limit = q.limit ?? 200;
  const offset = q.offset ?? 0;
  const { mode } = modeOf(ctx);

  let trades = Object.values(ctx.state.bots)
    .filter((b) => q.bot === undefined || b.botId === q.bot)
    .flatMap((b) => [...(status === 'closed' ? [] : b.openTrades), ...(status === 'open' ? [] : b.closedTrades)])
    .filter((t) => (q.pair === undefined || t.pair === q.pair) && (q.since === undefined || t.openedAt >= q.since));
  trades = trades.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt) || b.tradeId - a.tradeId);

  const totals = trades.reduce(
    (acc, t) => ({
      realizedUsd: acc.realizedUsd + t.pnl.realizedUsd,
      unrealizedUsd: acc.unrealizedUsd + (t.pnl.unrealizedUsd ?? 0),
      feesUsd: acc.feesUsd + t.pnl.feesUsd,
    }),
    { realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0 },
  );

  let kraken: Map<string, KrakenOrder> | null = null;
  if (mode === 'kraken') {
    kraken = new Map(listKrakenOrders({ since: (ctx.kraken.reconStartAt ?? 0) - 3_600_000 }).map((o) => [o.txid, o]));
    for (const o of ctx.state.kraken.openOrders ?? []) kraken.set(o.txid, o);
  }

  const page = trades.slice(offset, offset + limit).map((t) => {
    const krakenMatch: Record<string, OrderMatch> = {};
    for (const o of t.orders) krakenMatch[o.orderId] = matchOrder(o, kraken, ctx.kraken.reconStartAt);
    return { ...t, krakenMatch };
  });

  return {
    generatedAt: ctx.now,
    trades: page,
    total: trades.length,
    totals,
    sources: freshnessOf(ctx, (k) => /^bot:[^:]+:(status|trades)$/.test(k) || k.startsWith('kraken:')),
  };
}
