import type { KrakenOrdersMatchFilter, KrakenOrdersResponse } from '@/shared/types/api';
import type { BotId, KrakenOrder, Ms, Pair } from '@/shared/types/domain';
import { getKnownOrders, listAcks, listEvents, listKrakenOrders } from '../db';
import { freshnessOf, type ViewContext } from './common';

export interface KrakenOrdersQuery {
  since?: Ms | undefined;
  pair?: Pair | undefined;
  match?: KrakenOrdersMatchFilter | undefined;
  limit?: number | undefined;
}

export function buildKrakenOrders(ctx: ViewContext, q: KrakenOrdersQuery): KrakenOrdersResponse {
  const enabled = ctx.kraken.configured;
  const base: Omit<KrakenOrdersResponse, 'orders'> = {
    generatedAt: ctx.now,
    enabled,
    sources: freshnessOf(ctx, (k) => k.startsWith('kraken:')),
  };
  if (!enabled) return { ...base, orders: [] };

  const limit = q.limit ?? 200;
  const since = q.since ?? ctx.kraken.reconStartAt ?? undefined;
  const byTxid = new Map<string, KrakenOrder>();
  for (const o of listKrakenOrders({
    ...(since === undefined ? {} : { since }),
    ...(q.pair === undefined ? {} : { pair: q.pair }),
  })) {
    byTxid.set(o.txid, o);
  }
  for (const o of ctx.state.kraken.openOrders ?? []) {
    if ((q.pair === undefined || o.pair === q.pair) && (since === undefined || o.openedAt >= since))
      byTxid.set(o.txid, o);
  }

  const known: Record<string, { botId: BotId; tradeId: number }> = { ...getKnownOrders() };
  for (const bot of Object.values(ctx.state.bots)) {
    for (const t of [...bot.openTrades, ...bot.closedTrades])
      for (const o of t.orders) known[o.orderId] = { botId: bot.botId, tradeId: t.tradeId };
  }
  const acks = new Map(listAcks(ctx.now, { kind: 'kraken_order' }).map((a) => [a.subject, a]));
  const created = new Map<string, BotId>();
  for (const e of listEvents({ types: ['order_created'], ...(since === undefined ? {} : { since }) })) {
    if (e.orderId !== undefined) created.set(e.orderId, e.botId);
  }

  const match = q.match ?? 'all';
  const orders = [...byTxid.values()]
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((o) => ({
      ...o,
      match: known[o.txid] ?? null,
      ack: acks.get(o.txid) ?? null,
      createdByBotLog: created.get(o.txid) ?? null,
    }))
    .filter((o) => {
      if (match === 'matched') return o.match !== null;
      if (match === 'unmatched') return o.match === null && o.ack === null;
      if (match === 'acked') return o.ack !== null;
      return true;
    })
    .slice(0, limit);
  return { ...base, orders };
}
