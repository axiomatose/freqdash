import 'server-only';
import type { BotId, BotOrder, Ms } from '@/shared/types/domain';
import { getDb } from '../client';

// Every bot order id ever seen (`bot_orders_seen`). Freqtrade's API drops orders of trades it deleted (a timed-out
// entry with zero fill), so without this table the orphan checks would flag them (docs/PLAN.md fact F3).
// Kept forever: the table is small and is the source of truth for "did the bot ever know this order".

export type SeenOrderInput = Pick<BotOrder, 'botId' | 'tradeId' | 'orderId' | 'pair' | 'side'>;

/**
 * Records orders as seen at `now`. Already-known orders keep `first_seen_at` and refresh `last_seen_at` plus
 * trade/pair/side; an observation older than the stored `last_seen_at` is ignored.
 */
export function markOrdersSeen(orders: readonly SeenOrderInput[], now: Ms): void {
  if (orders.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO bot_orders_seen (bot_id, order_id, trade_id, pair, side, first_seen_at, last_seen_at)
     VALUES (@botId, @orderId, @tradeId, @pair, @side, @now, @now)
     ON CONFLICT(bot_id, order_id) DO UPDATE SET
       trade_id = excluded.trade_id,
       pair = excluded.pair,
       side = excluded.side,
       last_seen_at = excluded.last_seen_at
     WHERE excluded.last_seen_at >= bot_orders_seen.last_seen_at`,
  );
  db.transaction(() => {
    for (const order of orders) {
      upsert.run({
        botId: order.botId,
        orderId: order.orderId,
        tradeId: order.tradeId,
        pair: order.pair,
        side: order.side,
        now,
      });
    }
  })();
}

/**
 * Every persisted order id, shaped like `CheckInput.knownOrders`. The caller unions it with the orders currently in
 * the live API responses. Exchange txids are unique, so an id belongs to one bot; should two bots ever report the
 * same id, the bot that saw it first wins.
 */
export function getKnownOrders(): Record<string, { botId: BotId; tradeId: number }> {
  const rows = getDb()
    .prepare('SELECT bot_id, order_id, trade_id FROM bot_orders_seen ORDER BY first_seen_at DESC, bot_id DESC')
    .all() as { bot_id: string; order_id: string; trade_id: number }[];
  const out: Record<string, { botId: BotId; tradeId: number }> = {};
  // Newest first, so a later assignment (an older first_seen_at) overwrites: the earliest bot ends up in the result.
  for (const row of rows) out[row.order_id] = { botId: row.bot_id, tradeId: row.trade_id };
  return out;
}
