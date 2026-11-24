import type { BotId, KrakenOrder } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, groupBy, isKnownOrder, orderAcked, qty, usd, type Rule } from '../util';

/**
 * A Kraken order (opened after reconciliation started) that no bot knows and nobody acknowledged: something other
 * than the bots is trading the account, or a bot placed an order and lost it. Judged only once every reachable bot
 * fetched `/status` and `/trades` after the order was placed.
 */
export const orphanKrakenOrder: Rule = ({ now, cfg, bots, events, knownOrders, acks, kraken, reconStartAt }) => {
  if (kraken === null) return [];

  const gated = bots.filter((b) => b.firstFailureAt === null || now - b.firstFailureAt <= cfg.orphanBotDownIgnoreMs);
  const botsReady = (openedAt: number): boolean =>
    gated.every(
      (b) =>
        b.lastStatusOkAt !== null &&
        b.lastTradesOkAt !== null &&
        b.lastStatusOkAt > openedAt + cfg.refreshMarginMs &&
        b.lastTradesOkAt > openedAt + cfg.refreshMarginMs,
    );

  const createdBy = new Map<string, BotId>();
  for (const e of events) if (e.type === 'order_created' && e.orderId) createdBy.set(e.orderId, e.botId);

  const seen = new Set<string>();
  const orphans: KrakenOrder[] = [];
  for (const o of [...kraken.openOrders, ...kraken.orders]) {
    if (seen.has(o.txid)) continue;
    seen.add(o.txid);
    if (o.openedAt < reconStartAt || isKnownOrder(knownOrders, o.txid) || orderAcked(acks, o.txid, now)) continue;
    if (now - o.openedAt < cfg.orphanMinAgeMs) continue;
    const live = o.status === 'open' || o.status === 'pending';
    if (!live && !(o.volExec > 0)) continue;
    if (!botsReady(o.openedAt)) continue;
    orphans.push(o);
  }

  const out: RawFinding[] = [];
  for (const [pair, group] of groupBy(orphans, (o) => o.pair ?? o.krakenPair)) {
    group.sort((a, b) => a.openedAt - b.openedAt);
    const critical = group.some(
      (o) => o.status === 'open' || o.status === 'pending' || now - o.openedAt < cfg.orphanCriticalAgeMs,
    );
    const totalCostUsd = group.reduce((acc, o) => acc + o.costUsd, 0);
    const totalVol = group.reduce((acc, o) => acc + o.volExec, 0);
    const byBots = new Set(group.map((o) => createdBy.get(o.txid)).filter((b): b is BotId => b !== undefined));
    out.push({
      rule: 'ORPHAN_KRAKEN_ORDER',
      fingerprint: fingerprint('ORPHAN_KRAKEN_ORDER', pair),
      severity: critical ? 'critical' : 'warning',
      title: `${group.length} Kraken order${group.length === 1 ? '' : 's'} on ${pair} that no bot knows`,
      detail:
        `${group.length} order${group.length === 1 ? '' : 's'} on Kraken (${qty(totalVol)} filled, ${usd(totalCostUsd)}) ` +
        `${byBots.size > 0 ? `partly logged by ${[...byBots].join(', ')} ` : ''}are not in any bot's records. ` +
        `Check Kraken order history, decide whether to sell or keep the coins, then acknowledge the orders in freqdash.`,
      subject: { pair },
      evidence: {
        count: group.length,
        totalCostUsd,
        totalVol,
        orders: group.map((o) => ({
          txid: o.txid,
          pair: o.pair,
          side: o.side,
          status: o.status,
          openedAt: o.openedAt,
          vol: o.vol,
          volExec: o.volExec,
          costUsd: o.costUsd,
          avgPrice: o.avgPrice,
          createdByBot: createdBy.get(o.txid) ?? null,
        })),
      },
      evidenceKeys: group.map((o) => o.txid),
    });
  }
  return out;
};
