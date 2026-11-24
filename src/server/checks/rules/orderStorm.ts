import type { Ms, Pair } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { allBotOrders, fingerprint, orderAcked, type Rule } from '../util';

interface Attempt {
  id: string;
  at: Ms;
  source: 'kraken' | 'log' | 'bot';
}

/**
 * Many order attempts on one pair within a few minutes: a runaway loop. An attempt is a Kraken order, a logged
 * `order_created`/`order_failed`, or a bot order; the same txid seen by several sources counts once.
 */
export const orderStorm: Rule = ({ now, cfg, bots, events, kraken, acks }) => {
  const from = now - cfg.stormWindowMs;
  const byPair = new Map<Pair, Map<string, Attempt>>();
  const add = (pair: Pair | null | undefined, id: string, at: Ms | null, source: Attempt['source']): void => {
    if (!pair || at === null || at < from || at > now) return;
    const attempts = byPair.get(pair) ?? new Map<string, Attempt>();
    const cur = attempts.get(id);
    if (cur === undefined || at < cur.at) attempts.set(id, { id, at, source });
    byPair.set(pair, attempts);
  };

  if (kraken !== null) {
    for (const o of [...kraken.orders, ...kraken.openOrders]) {
      if (!orderAcked(acks, o.txid, now)) add(o.pair ?? o.krakenPair, o.txid, o.openedAt, 'kraken');
    }
  }
  for (const e of events) {
    if (e.type === 'order_created' && e.orderId) {
      if (!orderAcked(acks, e.orderId, now)) add(e.pair, e.orderId, e.at, 'log');
    } else if (e.type === 'order_failed') {
      add(e.pair, `failed:${e.fingerprint}`, e.at, 'log');
    }
  }
  for (const { order } of allBotOrders(bots)) {
    if (!orderAcked(acks, order.orderId, now)) add(order.pair, order.orderId, order.placedAt, 'bot');
  }

  const out: RawFinding[] = [];
  for (const [pair, attempts] of byPair) {
    if (attempts.size < cfg.stormWarnCount) continue;
    const list = [...attempts.values()].sort((a, b) => a.at - b.at);
    const critical = list.length >= cfg.stormCriticalCount;
    out.push({
      rule: 'ORDER_STORM',
      fingerprint: fingerprint('ORDER_STORM', pair),
      severity: critical ? 'critical' : 'warning',
      title: `${list.length} order attempts on ${pair} in ${Math.round(cfg.stormWindowMs / 60_000)} minutes`,
      detail: `${list.length} orders or order attempts on ${pair} within the last ${Math.round(cfg.stormWindowMs / 60_000)} minutes. Normal trading places at most one or two; this looks like a runaway loop.`,
      subject: { pair },
      evidence: { count: list.length, windowMs: cfg.stormWindowMs, attempts: list },
    });
  }
  return out;
};
