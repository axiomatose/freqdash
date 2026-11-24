import type { BotEvent, KrakenOrder, Severity } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { duration, fingerprint, groupBy, isKnownOrder, krakenOrderMap, orderAcked, usd, type Rule } from '../util';

interface Candidate {
  event: BotEvent;
  krakenOrder: KrakenOrder | undefined;
  zeroFillCanceled: boolean;
}

/** Nothing was filled and the order is over: per Kraken when it knows the order, else per the bot's own cancel log. */
function isZeroFillCanceled(kraken: KrakenOrder | undefined, canceledInLog: boolean): boolean {
  if (kraken === undefined) return canceledInLog;
  return kraken.status !== 'open' && kraken.status !== 'pending' && kraken.volExec <= 0;
}

/**
 * The bot's log says it created an order that the bot's API never showed: a crash between placing the order and
 * saving it (the 2026-09-28 incident). Only judged once both `/status` and `/trades` were fetched successfully after
 * the order, so a slow poll does not look like a lost order.
 */
export const unpersistedOrder: Rule = ({ now, cfg, bots, events, knownOrders, acks, kraken }) => {
  const orders = kraken === null ? null : krakenOrderMap(kraken);
  const canceled = new Set(
    events.filter((e) => e.type === 'order_canceled' && e.orderId).map((e) => `${e.botId}:${e.orderId}`),
  );
  const out: RawFinding[] = [];

  for (const bot of bots) {
    const { lastStatusOkAt, lastTradesOkAt } = bot;
    if (lastStatusOkAt === null || lastTradesOkAt === null) continue;
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const e of events) {
      if (e.botId !== bot.botId || e.type !== 'order_created' || !e.orderId || e.at > now) continue;
      const txid = e.orderId;
      if (seen.has(txid)) continue;
      seen.add(txid);
      if (isKnownOrder(knownOrders, txid) || orderAcked(acks, txid, now)) continue;
      if (now - e.at < cfg.unpersistedMinAgeMs) continue;
      if (lastStatusOkAt <= e.at + cfg.refreshMarginMs || lastTradesOkAt <= e.at + cfg.refreshMarginMs) continue;
      const krakenOrder = orders?.get(txid);
      candidates.push({
        event: e,
        krakenOrder,
        zeroFillCanceled: isZeroFillCanceled(krakenOrder, canceled.has(`${bot.botId}:${txid}`)),
      });
    }

    for (const [pair, group] of groupBy(candidates, (c) => c.event.pair ?? 'unknown')) {
      group.sort((a, b) => a.event.at - b.event.at);
      const live = group.filter((c) => !c.zeroFillCanceled);
      let severity: Severity = 'info';
      if (live.length > 0)
        severity = live.some((c) => now - c.event.at < cfg.unpersistedCriticalAgeMs) ? 'critical' : 'warning';
      const totalStakeUsd = group.reduce((acc, c) => acc + (c.event.stakeUsd ?? 0), 0);
      const oldest = group[0]!.event.at;
      out.push({
        rule: 'UNPERSISTED_ORDER',
        fingerprint: fingerprint('UNPERSISTED_ORDER', bot.botId, pair),
        severity,
        title: `${group.length} ${pair} order${group.length === 1 ? '' : 's'} logged by ${bot.name} but unknown to it`,
        detail:
          `${bot.name} logged ${group.length} order${group.length === 1 ? '' : 's'} on ${pair} (${usd(totalStakeUsd)} of stake, oldest ${duration(now - oldest)} ago) ` +
          `that its API and database never recorded. They may still be filled on Kraken. Check Kraken order history, ` +
          `decide whether to sell or keep the coins, then acknowledge the orders in freqdash.`,
        subject: { botId: bot.botId, pair },
        evidence: {
          count: group.length,
          totalStakeUsd,
          orders: group.map((c) => ({
            orderId: c.event.orderId,
            at: c.event.at,
            price: c.event.price ?? null,
            stakeUsd: c.event.stakeUsd ?? null,
            ...(c.krakenOrder ? { krakenStatus: c.krakenOrder.status, volExec: c.krakenOrder.volExec } : {}),
            zeroFillCanceled: c.zeroFillCanceled,
          })),
        },
        evidenceKeys: group.map((c) => c.event.orderId as string),
      });
    }
  }
  return out;
};
