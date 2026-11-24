import { describe, expect, it } from 'vitest';
import type { KrakenOrder } from '@/shared/types/domain';
import { detectBurst, isCountedBuy } from './detect';

const cfg = { maxBuysShort: 2, windowShortMs: 30_000, maxBuysLong: 3, windowLongMs: 600_000 };
const T0 = 1_790_000_000_000;

let n = 0;
function buy(atMs: number, over: Partial<KrakenOrder> = {}): KrakenOrder {
  n += 1;
  return {
    txid: `O${String(n).padStart(5, '0')}-AAAAA-BBBBBB`,
    pair: 'ETH/USD',
    krakenPair: 'ETHUSD',
    side: 'buy',
    orderType: 'market',
    status: 'closed',
    openedAt: T0 + atMs,
    closedAt: T0 + atMs + 1000,
    vol: 1,
    volExec: 1,
    costUsd: 10,
    feeUsd: 0,
    avgPrice: 10,
    limitPrice: null,
    userref: null,
    clOrdId: null,
    reason: null,
    ...over,
  };
}

describe('detectBurst', () => {
  it('trips on more than 2 buys of one pair within 30 s', () => {
    const trips = detectBurst([buy(0), buy(10_000), buy(30_000)], cfg);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ rule: 'burst-short', pair: 'ETH/USD', count: 3, max: 2 });
    expect(trips[0]?.txids).toHaveLength(3);
  });

  it('does not trip on exactly 2 buys, or when the third falls outside the window', () => {
    expect(detectBurst([buy(0), buy(10_000)], cfg)).toEqual([]);
    expect(detectBurst([buy(0), buy(10_000), buy(40_001)], cfg)).toEqual([]);
  });

  it('counts per pair: simultaneous buys of different pairs are fine', () => {
    const other = (t: number, p: string) => buy(t, { pair: p, krakenPair: p.replace('/', '') });
    expect(detectBurst([buy(0), other(1000, 'BTC/USD'), other(2000, 'SOL/USD'), buy(3000)], cfg)).toEqual([]);
  });

  it('catches the slow Sep-28 pattern: 4 buys in 10 minutes, about one every 3 minutes', () => {
    const trips = detectBurst([buy(0), buy(170_000), buy(340_000), buy(510_000)], cfg);
    expect(trips[0]).toMatchObject({ rule: 'burst-long', count: 4, max: 3 });
    expect(detectBurst([buy(0), buy(200_000), buy(400_000)], cfg)).toEqual([]);
  });

  it('ignores sells, zero-fill cancelled buys, and orders the caller filters out', () => {
    const noise = [
      buy(0, { side: 'sell' }),
      buy(1000, { status: 'canceled', volExec: 0 }),
      buy(2000, { status: 'expired', volExec: 0 }),
      buy(3000),
      buy(4000),
    ];
    expect(detectBurst(noise, cfg)).toEqual([]);
    const three = [buy(0), buy(1000), buy(2000)];
    expect(detectBurst(three, cfg, (o) => o.txid === three[0]?.txid)).toEqual([]);
  });

  it('counts a working (open) order and a partially filled cancelled one', () => {
    expect(isCountedBuy(buy(0, { status: 'open', volExec: 0 }))).toBe(true);
    expect(isCountedBuy(buy(0, { status: 'canceled', volExec: 0.1 }))).toBe(true);
    const trips = detectBurst([buy(0, { status: 'open', volExec: 0 }), buy(1000), buy(2000)], cfg);
    expect(trips).toHaveLength(1);
  });

  it('is independent of input order and reports the densest window', () => {
    const orders = [buy(20_000), buy(0), buy(10_000), buy(15_000)];
    const trips = detectBurst(orders, cfg);
    expect(trips[0]).toMatchObject({ count: 4, firstAt: T0, lastAt: T0 + 20_000 });
  });

  it('falls back to the Kraken pair name when the catalog does not know the pair', () => {
    const o = (t: number) => buy(t, { pair: null, krakenPair: 'XYZUSD' });
    expect(detectBurst([o(0), o(1000), o(2000)], cfg)[0]?.pair).toBe('XYZUSD');
  });
});
