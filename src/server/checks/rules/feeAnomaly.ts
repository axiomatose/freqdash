import type { Ms } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, groupBy, krakenOrderMap, type Rule } from '../util';

interface Hit {
  orderId: string;
  reasons: string[];
  botRate: number | null;
  krakenRate: number | null;
  expectedTaker: number;
  /** Where `expectedTaker` came from: Kraken's TradeVolume for this pair, or the built-in fallback. */
  expectedSource: 'kraken-tier' | 'default';
  at: Ms | null;
}

/**
 * Fees that are higher than Kraken's schedule, missing, or different between the bot's record and Kraken's, per
 * filled order and grouped per trade side. Without Kraken data only the bot's own rate can be sanity-checked.
 * Old findings are informational: they cannot be acted upon any more.
 */
export const feeAnomaly: Rule = ({ now, cfg, bots, kraken }) => {
  const orders = kraken === null ? null : krakenOrderMap(kraken);
  const out: RawFinding[] = [];

  for (const bot of bots) {
    for (const trade of [...bot.openTrades, ...bot.closedTrades]) {
      const hits: (Hit & { side: 'buy' | 'sell' })[] = [];
      for (const order of trade.orders) {
        if (!(order.filled > 0)) continue;
        const botRate = order.isEntry ? trade.feeOpenRate : trade.feeCloseRate;
        const ko = orders?.get(order.orderId);
        const krakenRate = ko !== undefined && ko.costUsd > 0 ? ko.feeUsd / ko.costUsd : null;
        const tierTaker = kraken?.feeTier?.[order.pair]?.taker;
        const expectedTaker = tierTaker ?? cfg.feeDefaultTaker;
        const reasons: string[] = [];

        if (botRate === null) reasons.push('bot_fee_rate_missing');
        if (krakenRate !== null) {
          if (krakenRate > expectedTaker * cfg.feeTakerFactor + cfg.feeTakerSlack)
            reasons.push('kraken_fee_above_schedule');
          if (botRate !== null && Math.abs(botRate - krakenRate) > cfg.feeBotVsKrakenTolerance)
            reasons.push('bot_fee_differs_from_kraken');
        } else if (botRate !== null) {
          // No Kraken order to compare with: judge the bot's rate against the account's real fee tier when it is
          // known (a bot set to a 0.8 % tier is right, not out of range), else against a fixed ceiling.
          const ceiling =
            tierTaker === undefined ? cfg.feeBotMaxRate : tierTaker * cfg.feeTakerFactor + cfg.feeTakerSlack;
          if (botRate > ceiling || botRate < 0) reasons.push('bot_fee_out_of_range');
        }
        if (reasons.length > 0) {
          hits.push({
            orderId: order.orderId,
            reasons,
            botRate,
            krakenRate,
            expectedTaker,
            expectedSource: tierTaker === undefined ? ('default' as const) : ('kraken-tier' as const),
            at: order.filledAt ?? order.placedAt,
            side: order.side,
          });
        }
      }

      for (const [side, group] of groupBy(hits, (h) => h.side)) {
        const times = group.map((h) => h.at).filter((t): t is Ms => t !== null);
        const newest = times.length > 0 ? Math.max(...times) : null;
        const old = newest !== null && now - newest > cfg.feeInfoAgeMs;
        out.push({
          rule: 'FEE_ANOMALY',
          fingerprint: fingerprint('FEE_ANOMALY', bot.botId, trade.tradeId, side),
          severity: old ? 'info' : 'warning',
          title: `Unexpected fee on ${bot.name} trade #${trade.tradeId} (${side})`,
          detail:
            `${group.length} ${side} order${group.length === 1 ? '' : 's'} of trade #${trade.tradeId} on ${trade.pair} ` +
            `had a fee that does not match Kraken's schedule or the bot's own record` +
            `${old ? ' (historical, more than 30 days ago)' : ''}.`,
          subject: { botId: bot.botId, tradeId: trade.tradeId, pair: trade.pair, kind: side },
          evidence: { orders: group.map(({ side: _side, ...h }) => h) },
        });
      }
    }
  }
  return out;
};
