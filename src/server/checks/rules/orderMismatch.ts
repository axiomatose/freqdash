import type { RawFinding } from '@/shared/types/findings';
import { allBotOrders, fingerprint, krakenOrderMap, type Rule } from '../util';

/**
 * A bot order and the Kraken order with the same txid disagree about how much was filled, or the bot still thinks the
 * order is open while Kraken closed it. The lifecycle's minimum duration absorbs ordinary polling lag.
 */
export const orderMismatch: Rule = ({ cfg, bots, kraken }) => {
  if (kraken === null) return [];
  const orders = krakenOrderMap(kraken);
  const out: RawFinding[] = [];
  for (const { bot, trade, order } of allBotOrders(bots)) {
    if (bot.config?.dryRun === true) continue;
    const ko = orders.get(order.orderId);
    if (ko === undefined) continue;
    const fillDiff = Math.abs(order.filled - ko.volExec);
    const fillMismatch = fillDiff > Math.max(cfg.mismatchAbsVol, cfg.mismatchRelVol * ko.vol);
    const stateMismatch =
      order.isOpen && (ko.status === 'closed' || ko.status === 'canceled' || ko.status === 'expired');
    if (!fillMismatch && !stateMismatch) continue;
    out.push({
      rule: 'ORDER_MISMATCH',
      fingerprint: fingerprint('ORDER_MISMATCH', order.orderId),
      severity: 'warning',
      title: `${bot.name} and Kraken disagree about order ${order.orderId}`,
      detail:
        `${bot.name} has ${order.filled} filled${order.isOpen ? ' and the order still open' : ''}; ` +
        `Kraken says ${ko.volExec} of ${ko.vol} filled and the order ${ko.status}. Trade #${trade.tradeId} on ${order.pair}.`,
      subject: { botId: bot.botId, orderId: order.orderId, tradeId: trade.tradeId, pair: order.pair },
      evidence: {
        botFilled: order.filled,
        botIsOpen: order.isOpen,
        botStatus: order.status,
        krakenVol: ko.vol,
        krakenVolExec: ko.volExec,
        krakenStatus: ko.status,
        fillMismatch,
        stateMismatch,
      },
      minDurationMs: cfg.mismatchMinMs,
    });
  }
  return out;
};
