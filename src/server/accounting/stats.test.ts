import { describe, expect, it } from 'vitest';
import type { BotTrade } from '@/shared/types/domain';
import { baseTrade, botOrder, openTrade } from '../../../test/fixtures/incident/builders';
import { dcaClosedTrades, votemaxClosedTrades, votemaxOpenTrades } from '../../../test/fixtures/incident/ftFixtures';
import { withPnl } from './pnl';
import { computeBotStats, peakConcurrentStake } from './stats';

const noFees = { feeOpenRate: 0, feeCloseRate: 0, feeOpenCost: 0, feeCloseCost: 0 } as const;

function closed(id: number, key: string, buyAt: number, sellAt: number, cost: number, proceeds: number): BotTrade {
  return withPnl(
    baseTrade({
      ...noFees,
      tradeId: id,
      key,
      isOpen: false,
      openedAt: buyAt,
      closedAt: sellAt,
      orders: [
        botOrder({ orderId: `${key}b`, filled: 1, cost, price: cost, placedAt: buyAt, filledAt: buyAt }),
        botOrder({
          orderId: `${key}s`,
          side: 'sell',
          isEntry: false,
          filled: 1,
          cost: proceeds,
          price: proceeds,
          placedAt: sellAt,
          filledAt: sellAt,
        }),
      ],
    }),
    null,
  );
}

describe('computeBotStats', () => {
  it('returns zeros and nulls for a bot without trades', () => {
    const s = computeBotStats([]);
    expect(s).toMatchObject({
      closedTrades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      realizedUsd: 0,
      unrealizedUsd: 0,
      totalUsd: 0,
      roiOnStake: null,
      openTrades: 0,
      openCostBasisUsd: 0,
      openMarketValueUsd: 0,
      peakConcurrentStakeUsd: 0,
      returnOnPeakStake: null,
      feesUsd: 0,
      firstTradeAt: null,
      lastTradeAt: null,
    });
  });

  it('counts wins by realized > 0, and roi as sum(realized) / sum(cost basis) of closed trades', () => {
    const trades = [
      closed(1, 'a', 1000, 2000, 100, 110),
      closed(2, 'b', 3000, 4000, 100, 95),
      closed(3, 'c', 5000, 6000, 100, 100),
    ];
    const s = computeBotStats(trades);
    expect(s.closedTrades).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(1 / 3, 12);
    expect(s.realizedUsd).toBeCloseTo(5, 12);
    expect(s.closedCostBasisUsd).toBeCloseTo(300, 12);
    expect(s.roiOnStake).toBeCloseTo(5 / 300, 12);
    expect(s.firstTradeAt).toBe(1000);
    expect(s.lastTradeAt).toBe(6000);
  });

  it('adds open trades: unrealized, cost basis of the held part, market value, return on peak stake', () => {
    const open = openTrade('votemax', 'BTC', 2, 100, { feeOpenRate: 0, feeCloseRate: 0, feeOpenCost: 0 });
    const s = computeBotStats([
      closed(1, 'a', 1000, 2000, 100, 110),
      { ...open, pnl: { ...open.pnl, markPrice: 110, unrealizedUsd: 20, totalUsd: 20 } },
    ]);
    expect(s.openTrades).toBe(1);
    expect(s.unrealizedUsd).toBe(20);
    expect(s.totalUsd).toBeCloseTo(30, 12);
    expect(s.openCostBasisUsd).toBeCloseTo(200, 12);
    expect(s.openMarketValueUsd).toBeCloseTo(220, 12);
    expect(s.peakConcurrentStakeUsd).toBeGreaterThanOrEqual(200);
    expect(s.returnOnPeakStake).toBeCloseTo(30 / s.peakConcurrentStakeUsd, 12);
  });

  it('has no market value when a held open trade has no mark, and ignores its unrealized', () => {
    const open = withPnl(baseTrade(), null);
    const s = computeBotStats([open]);
    expect(s.openMarketValueUsd).toBeNull();
    expect(s.unrealizedUsd).toBe(0);
  });

  it('works on the real fixture trades (votemax: 3 closed + open trade 8)', () => {
    const closedTrades = votemaxClosedTrades().map((t) => withPnl(t, null));
    const open = votemaxOpenTrades().map((t) => withPnl(t, { price: 83414.5, source: 'kraken' }));
    const s = computeBotStats([...closedTrades, ...open]);
    expect(s.closedTrades).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.realizedUsd).toBeCloseTo(2.60846 + 1.76475 - 0.04714, 3);
    expect(s.unrealizedUsd).toBeCloseTo(-0.31006, 3);
    expect(s.openTrades).toBe(1);
  });

  it('counts dca closed trades even when their order lists are truncated', () => {
    const s = computeBotStats(dcaClosedTrades().map((t) => withPnl(t, null)));
    expect(s.closedTrades).toBe(3);
  });
});

describe('peakConcurrentStake', () => {
  it('sweeps entry fills and exits over all trades in time order', () => {
    const a = closed(1, 'a', 1000, 5000, 100, 100);
    const b = closed(2, 'b', 2000, 6000, 50, 50);
    const c = closed(3, 'c', 7000, 8000, 80, 80);
    expect(peakConcurrentStake([a, b, c])).toBe(150);
  });

  it('does not stack a trade that closes at the very instant another opens', () => {
    const a = closed(1, 'a', 1000, 5000, 100, 100);
    const b = closed(2, 'b', 5000, 9000, 100, 100);
    expect(peakConcurrentStake([a, b])).toBe(100);
  });

  it('removes a partial exit proportionally', () => {
    const t = withPnl(
      baseTrade({
        ...noFees,
        orders: [
          botOrder({ orderId: 'b', filled: 4, cost: 400, price: 100, filledAt: 1000 }),
          botOrder({ orderId: 's', side: 'sell', isEntry: false, filled: 1, cost: 100, price: 100, filledAt: 2000 }),
          botOrder({ orderId: 'b2', filled: 1, cost: 100, price: 100, filledAt: 3000 }),
        ],
      }),
      { price: 100, source: 'bot' },
    );
    // 400 held, 300 after selling a quarter, 400 again after the second entry: the peak is the first 400.
    expect(peakConcurrentStake([t])).toBe(400);
  });

  it('ignores an exit that has nothing to sell', () => {
    const t = withPnl(
      baseTrade({
        ...noFees,
        orders: [botOrder({ side: 'sell', isEntry: false, filled: 1, cost: 10, price: 10, filledAt: 1000 })],
      }),
      null,
    );
    expect(peakConcurrentStake([t])).toBe(0);
  });
});
