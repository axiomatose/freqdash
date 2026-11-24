import type { RawFinding } from '@/shared/types/findings';
import { allBotOrders, fingerprint, krakenOrderMap, orderAcked, type Rule } from '../util';

/**
 * A filled bot order that Kraken does not have (after the backfill and the QueryOrders lookup): the bot may be
 * running against the wrong account or in a simulated mode, or its record is wrong.
 */
export const botOrderMissingOnKraken: Rule = ({ now, cfg, bots, acks, kraken, reconStartAt }) => {
  if (kraken === null || !kraken.backfillComplete) return [];
  const known = krakenOrderMap(kraken);
  const from = reconStartAt + cfg.missingOnKrakenGraceMs;
  const to = now - cfg.missingOnKrakenMinAgeMs;
  const out: RawFinding[] = [];
  for (const { bot, trade, order } of allBotOrders(bots)) {
    if (bot.config?.dryRun === true || !(order.filled > 0) || order.placedAt === null) continue;
    if (order.placedAt < from || order.placedAt > to) continue;
    if (known.has(order.orderId) || orderAcked(acks, order.orderId, now)) continue;
    out.push({
      rule: 'BOT_ORDER_MISSING_ON_KRAKEN',
      fingerprint: fingerprint('BOT_ORDER_MISSING_ON_KRAKEN', bot.botId, order.orderId),
      severity: 'warning',
      title: `${bot.name} order ${order.orderId} is not on Kraken`,
      detail:
        `${bot.name} recorded a filled ${order.side} order (${order.filled} ${trade.base} on ${order.pair}, trade #${trade.tradeId}) ` +
        `that Kraken's order history does not contain. Verify that the bot uses the account freqdash watches.`,
      subject: { botId: bot.botId, orderId: order.orderId, tradeId: trade.tradeId, pair: order.pair },
      evidence: {
        orderId: order.orderId,
        side: order.side,
        filled: order.filled,
        price: order.price,
        placedAt: order.placedAt,
      },
    });
  }
  return out;
};
