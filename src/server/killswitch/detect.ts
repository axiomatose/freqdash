import type { KrakenOrder, Ms } from '@/shared/types/domain';

// Killswitch trigger (pure). Kraken is the source of truth: a runaway bot shows up as a burst of buy orders for one
// pair, whatever the bot's own records say. Two rules, both per pair:
//  * more than `maxBuysShort` buys inside any `windowShortMs` (default: more than 2 in 30 s);
//  * more than `maxBuysLong` buys inside any `windowLongMs` (default: more than 3 in 10 min), which catches the slower
//    pattern of the 2026-09-28 incident (about one buy every 2 to 3 minutes).

export interface BurstConfig {
  maxBuysShort: number;
  windowShortMs: Ms;
  maxBuysLong: number;
  windowLongMs: Ms;
}

export interface Trip {
  rule: 'burst-short' | 'burst-long';
  pair: string;
  count: number;
  max: number;
  windowMs: Ms;
  firstAt: Ms;
  lastAt: Ms;
  txids: string[];
}

/** A buy that counts: it filled or is still working. Cancelled or expired orders without a fill never spent anything. */
export function isCountedBuy(o: KrakenOrder): boolean {
  if (o.side !== 'buy') return false;
  if (o.status === 'open' || o.status === 'pending') return true;
  return o.volExec > 0;
}

interface Hit {
  count: number;
  from: number;
  to: number;
}

/** The densest window (largest count) of `times` (ascending) that is at most `windowMs` wide, if it exceeds `max`. */
function densest(times: readonly number[], windowMs: Ms, max: number): Hit | null {
  let best: Hit | null = null;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while ((times[hi] as number) - (times[lo] as number) > windowMs) lo++;
    const count = hi - lo + 1;
    if (count > max && (best === null || count > best.count)) best = { count, from: lo, to: hi };
  }
  return best;
}

/**
 * `orders` are Kraken orders in any order; `ignore` filters out orders that must not count (acknowledged manual
 * orders, anything before the last reset). Returns the first trip per pair (short rule first), most recent pair first.
 */
export function detectBurst(
  orders: readonly KrakenOrder[],
  cfg: BurstConfig,
  ignore: (o: KrakenOrder) => boolean = () => false,
): Trip[] {
  const byPair = new Map<string, KrakenOrder[]>();
  for (const o of orders) {
    if (!isCountedBuy(o) || ignore(o)) continue;
    const key = o.pair ?? o.krakenPair;
    const list = byPair.get(key);
    if (list === undefined) byPair.set(key, [o]);
    else list.push(o);
  }

  const trips: Trip[] = [];
  for (const [pair, list] of byPair) {
    list.sort((a, b) => a.openedAt - b.openedAt || a.txid.localeCompare(b.txid));
    const times = list.map((o) => o.openedAt);
    const rules = [
      { rule: 'burst-short' as const, windowMs: cfg.windowShortMs, max: cfg.maxBuysShort },
      { rule: 'burst-long' as const, windowMs: cfg.windowLongMs, max: cfg.maxBuysLong },
    ];
    for (const r of rules) {
      const hit = densest(times, r.windowMs, r.max);
      if (hit === null) continue;
      const inWindow = list.slice(hit.from, hit.to + 1);
      trips.push({
        rule: r.rule,
        pair,
        count: hit.count,
        max: r.max,
        windowMs: r.windowMs,
        firstAt: inWindow[0]?.openedAt ?? 0,
        lastAt: inWindow[inWindow.length - 1]?.openedAt ?? 0,
        txids: inWindow.map((o) => o.txid),
      });
      break;
    }
  }
  return trips.sort((a, b) => b.lastAt - a.lastAt);
}
