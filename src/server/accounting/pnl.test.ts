import { describe, expect, it } from 'vitest';
import { baseTrade, botOrder, openTrade } from '../../../test/fixtures/incident/builders';
import { dcaClosedTrades, votemaxClosedTrades, votemaxOpenTrades } from '../../../test/fixtures/incident/ftFixtures';
import { computeTradePnl, openQtyOf, pickMark, tradeFills, withPnl } from './pnl';

const TOL = 1e-4;

describe('computeTradePnl against freqtrade profit_abs (the three cases of PLAN section 7)', () => {
  it('votemax closed trade 1 = +2.60846', () => {
    const t = votemaxClosedTrades().find((x) => x.tradeId === 1)!;
    const pnl = computeTradePnl(t, null);
    expect(Math.abs(pnl.realizedUsd - 2.60846)).toBeLessThan(TOL);
    expect(Math.abs(pnl.realizedUsd - t.ftProfitAbs!)).toBeLessThan(TOL);
    expect(pnl.unrealizedUsd).toBe(0);
    expect(pnl.totalUsd).toBeCloseTo(pnl.realizedUsd, 12);
    expect(pnl.openQty).toBe(0);
    expect(pnl.entryQty).toBeCloseTo(0.02749403, 12);
    expect(pnl.feesUsd).toBeCloseTo(0.15624994719 + 0.26211, 8);
  });

  it('dca closed trade 2 = -0.50966', () => {
    const t = dcaClosedTrades().find((x) => x.tradeId === 2)!;
    const pnl = computeTradePnl(t, null);
    expect(Math.abs(pnl.realizedUsd - -0.50966)).toBeLessThan(TOL);
    expect(Math.abs(pnl.realizedUsd - t.ftProfitAbs!)).toBeLessThan(TOL);
  });

  it('votemax open trade 8 marked at 83414.5 = -0.31006', () => {
    const t = votemaxOpenTrades().find((x) => x.tradeId === 8)!;
    const pnl = computeTradePnl(t, { price: 83414.5, source: 'kraken' });
    expect(Math.abs(pnl.unrealizedUsd! - -0.31006)).toBeLessThan(TOL);
    expect(Math.abs(pnl.totalUsd! - t.ftProfitAbs!)).toBeLessThan(TOL);
    expect(pnl.realizedUsd).toBe(0);
    expect(pnl.openQty).toBeCloseTo(0.00046744, 12);
    expect(pnl.markSource).toBe('kraken');
    expect(pnl.markPrice).toBe(83414.5);
    expect(pnl.roiOnStake).toBeCloseTo(pnl.totalUsd! / pnl.costBasisUsd, 12);
  });

  it('matches profit_abs for every closed fixture trade whose order list is complete', () => {
    // dca trades 1 and 3 lost their exit (and some entry) orders when the fixtures were truncated to 3 list items.
    const complete = [...votemaxClosedTrades(), ...dcaClosedTrades()].filter((t) => t.orders.some((o) => !o.isEntry));
    expect(complete.length).toBe(4);
    for (const t of complete) {
      const pnl = computeTradePnl(t, null);
      expect(Math.abs(pnl.realizedUsd - t.ftProfitAbs!), `${t.key}`).toBeLessThan(TOL);
    }
  });
});

describe('computeTradePnl semantics', () => {
  it('counts only orders with filled > 0 and prefers the exchange cost over filled x price', () => {
    const t = baseTrade({
      feeOpenRate: 0,
      feeCloseRate: 0,
      feeOpenCost: 0,
      feeCloseCost: 0,
      orders: [
        botOrder({ orderId: 'a', filled: 1, price: 100, cost: 99 }),
        botOrder({ orderId: 'b', filled: 0, price: 100, cost: 0, isOpen: true, status: 'open' }),
        botOrder({ orderId: 'c', filled: 2, price: 50, cost: null }),
      ],
    });
    const { entries } = tradeFills(t);
    expect(entries.map((f) => f.value)).toEqual([99, 100]);
    expect(computeTradePnl(t, null).entryCostUsd).toBe(199);
  });

  it('derives fees from the rates when the cost fields are null, and 0 when both are null', () => {
    const buy = botOrder({ filled: 1, cost: 100, price: 100 });
    const sell = botOrder({ orderId: 's', side: 'sell', isEntry: false, filled: 1, cost: 110, price: 110 });
    const rated = computeTradePnl(
      baseTrade({ feeOpenRate: 0.01, feeCloseRate: 0.02, isOpen: false, orders: [buy, sell] }),
      null,
    );
    expect(rated.feesUsd).toBeCloseTo(1 + 2.2, 12);
    expect(rated.realizedUsd).toBeCloseTo(110 - 101 - 2.2, 12);
    const bare = computeTradePnl(
      baseTrade({ feeOpenRate: null, feeCloseRate: null, isOpen: false, orders: [buy, sell] }),
      null,
    );
    expect(bare.feesUsd).toBe(0);
    expect(bare.realizedUsd).toBeCloseTo(10, 12);
  });

  it('books a partial exit against its share of the cost basis and values the rest at the mark', () => {
    const t = baseTrade({
      feeOpenRate: 0,
      feeCloseRate: 0,
      feeOpenCost: 0,
      feeCloseCost: 0,
      orders: [
        botOrder({ orderId: 'b', filled: 4, cost: 400, price: 100 }),
        botOrder({ orderId: 's', side: 'sell', isEntry: false, filled: 1, cost: 120, price: 120 }),
      ],
    });
    const pnl = computeTradePnl(t, { price: 130, source: 'bot' });
    expect(pnl.realizedUsd).toBeCloseTo(120 - 100, 12);
    expect(pnl.openQty).toBe(3);
    expect(pnl.unrealizedUsd).toBeCloseTo(3 * 130 - 300, 12);
    expect(pnl.totalUsd).toBeCloseTo(20 + 90, 12);
    expect(pnl.markSource).toBe('bot');
  });

  it('uses the 0.4% fallback exit fee only when no fee rate is known', () => {
    const t = baseTrade({
      feeOpenRate: null,
      feeCloseRate: null,
      feeOpenCost: 0,
      orders: [botOrder({ filled: 1, cost: 100, price: 100 })],
    });
    expect(computeTradePnl(t, { price: 110, source: 'kraken' }).unrealizedUsd).toBeCloseTo(110 * 0.996 - 100, 12);
    const withOpenRate = baseTrade({
      feeOpenRate: 0.01,
      feeCloseRate: null,
      feeOpenCost: 0,
      orders: [botOrder({ filled: 1, cost: 100, price: 100 })],
    });
    expect(computeTradePnl(withOpenRate, { price: 110, source: 'kraken' }).unrealizedUsd).toBeCloseTo(
      110 * 0.99 - 100,
      12,
    );
  });

  it('has no unrealized/total for a held position without a mark, but a 0 unrealized when nothing is held', () => {
    const held = computeTradePnl(baseTrade(), null);
    expect(held.unrealizedUsd).toBeNull();
    expect(held.totalUsd).toBeNull();
    expect(held.roiOnStake).toBeNull();
    expect(held.markPrice).toBeNull();
    expect(held.markSource).toBeNull();
    const unfilled = computeTradePnl(
      baseTrade({ orders: [botOrder({ filled: 0, isOpen: true, status: 'open' })] }),
      null,
    );
    expect(unfilled.openQty).toBe(0);
    expect(unfilled.unrealizedUsd).toBe(0);
    expect(unfilled.totalUsd).toBe(0);
    expect(unfilled.roiOnStake).toBeNull();
  });

  it('treats a rounding-noise remainder as closed and never reports a negative position', () => {
    const noise = baseTrade({
      isOpen: false,
      orders: [
        botOrder({ filled: 0.1 + 0.2, cost: 30, price: 100 }),
        botOrder({ orderId: 's', side: 'sell', isEntry: false, filled: 0.3, cost: 30, price: 100 }),
      ],
    });
    expect(computeTradePnl(noise, null).openQty).toBe(0);
    const oversold = baseTrade({
      isOpen: false,
      orders: [
        botOrder({ filled: 1, cost: 100, price: 100 }),
        botOrder({ orderId: 's', side: 'sell', isEntry: false, filled: 1.5, cost: 150, price: 100 }),
      ],
    });
    expect(computeTradePnl(oversold, null).openQty).toBe(0);
  });

  it('realized is 0 when nothing was sold and when there is no entry to book against', () => {
    expect(computeTradePnl(baseTrade(), { price: 1, source: 'bot' }).realizedUsd).toBe(0);
    const sellOnly = baseTrade({
      orders: [botOrder({ side: 'sell', isEntry: false, filled: 1, cost: 10, price: 10 })],
    });
    const pnl = computeTradePnl(sellOnly, null);
    expect(pnl.entryQty).toBe(0);
    expect(pnl.realizedUsd).toBe(10 - 0.04 - 0);
  });

  it('falls back to the trade fields when the API returned no orders', () => {
    const open = baseTrade({ orders: [], amount: 2, openRate: 50, feeOpenRate: 0, feeCloseRate: 0 });
    expect(computeTradePnl(open, { price: 60, source: 'bot' })).toMatchObject({
      entryQty: 2,
      entryCostUsd: 100,
      openQty: 2,
    });
    const closed = baseTrade({
      orders: [],
      isOpen: false,
      amount: 2,
      openRate: 50,
      closeRate: 55,
      feeOpenRate: 0,
      feeCloseRate: 0,
      closedAt: T(5),
    });
    expect(computeTradePnl(closed, null).realizedUsd).toBeCloseTo(10, 12);
    const empty = baseTrade({ orders: [], amount: 0 });
    expect(computeTradePnl(empty, null)).toMatchObject({ entryQty: 0, exitQty: 0, openQty: 0 });
  });

  it('withPnl attaches the pnl and keeps the trade fields', () => {
    const base = baseTrade();
    const t = withPnl(base, { price: 2700, source: 'kraken' });
    expect(t.pair).toBe(base.pair);
    expect(t.pnl.markPrice).toBe(2700);
  });
});

describe('pickMark / openQtyOf', () => {
  const t = baseTrade({ botCurrentRate: 99 });
  it('prefers the Kraken ticker, then the bot rate, then nothing', () => {
    expect(pickMark(t, { ETH: 105 })).toEqual({ price: 105, source: 'kraken' });
    expect(pickMark(t, { ETH: 0 })).toEqual({ price: 99, source: 'bot' });
    expect(pickMark({ ...t, botCurrentRate: null }, {})).toBeNull();
  });
  it('gives no mark for a closed trade', () => {
    expect(pickMark({ ...t, isOpen: false }, { ETH: 105 })).toBeNull();
  });
  it('openQtyOf is the held quantity of open trades and 0 for closed ones', () => {
    const held = openTrade('votemax', 'ETH', 0.5, 2000);
    expect(openQtyOf(held)).toBe(0.5);
    expect(openQtyOf({ ...held, isOpen: false })).toBe(0);
  });
});

function T(min: number): number {
  return Date.UTC(2026, 8, 28, 4, min, 0);
}
