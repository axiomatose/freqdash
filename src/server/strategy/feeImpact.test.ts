import { describe, expect, it } from 'vitest';
import type { BotTradeBase } from '@/shared/types/domain';
import type { StrategyParams } from '@/shared/types/strategy';
import { analyzeFeeImpact, profitRatio } from './feeImpact';

const params = (over: Partial<StrategyParams> = {}): StrategyParams => ({
  timeframe: '4h',
  minimalRoi: [[0, 0.25]],
  stoploss: -0.99,
  trailingStop: true,
  trailingStopPositive: 0.03,
  trailingStopPositiveOffset: 0.08,
  trailingOnlyOffsetIsReached: true,
  useExitSignal: true,
  exitProfitOnly: true,
  exitProfitOffset: 0,
  ignoreRoiIfEntrySignal: false,
  positionAdjustmentEnable: false,
  maxEntryPositionAdjustment: null,
  maxOpenTrades: 2,
  orderTypes: null,
  configFee: 0.0016,
  ...over,
});

function trade(over: Partial<BotTradeBase>): BotTradeBase {
  return {
    botId: 'votemax',
    tradeId: 1,
    key: 'votemax:1',
    pair: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    isOpen: false,
    strategy: 'VoteMaxMulti',
    enterTag: 'vote_entry',
    exitReason: 'vote_exit',
    amount: 1,
    stakeAmount: 100,
    maxStakeAmount: 100,
    openRate: 100,
    closeRate: 100.7,
    botCurrentRate: null,
    openedAt: 1,
    openFilledAt: 1,
    closedAt: 2,
    feeOpenRate: 0.004,
    feeOpenCost: null,
    feeCloseRate: 0.004,
    feeCloseCost: null,
    entries: 1,
    exits: 1,
    hasOpenOrders: false,
    orders: [],
    ftProfitAbs: null,
    ...over,
  };
}

describe('profitRatio', () => {
  it('is the fee-adjusted close/open ratio', () => {
    expect(profitRatio(100, 100, 0, 0)).toBeCloseTo(0, 12);
    expect(profitRatio(100, 110, 0.004, 0.004)).toBeCloseTo((110 * 0.996) / (100 * 1.004) - 1, 12);
  });
});

describe('analyzeFeeImpact', () => {
  it('flags a profit-gated exit that only looked profitable under the too-low assumed fee', () => {
    // +0.7 % gross: 0.4 % + 0.4 % fees make it a loss, 0.4 % + 0.16 % fees make it a win.
    const r = analyzeFeeImpact({ params: params(), closedTrades: [trade({})], assumedCloseFee: 0.0016 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]?.assumedProfitRatio).toBeGreaterThan(0);
    expect(r.trades[0]?.actualProfitRatio).toBeLessThan(0);
    expect(r.trades[0]?.gateFlipped).toBe(true);
    expect(r.summary.gateFlips).toBe(1);
    expect(r.summary.profitGatedExits).toBe(1);
    expect(r.summary.gapPoints).toBeCloseTo(-0.24, 6);
    expect(r.summary.totalCloseFeeGapUsd).toBeCloseTo(100.7 * 0.0024, 6);
  });

  it('does not flag trades whose gain clears both fee levels', () => {
    const r = analyzeFeeImpact({
      params: params(),
      closedTrades: [trade({ closeRate: 108 })],
      assumedCloseFee: 0.0016,
    });
    expect(r.summary.gateFlips).toBe(0);
  });

  it('only counts signal exits, not trailing/roi exits, and only when exit_profit_only is set', () => {
    const t = trade({ exitReason: 'trailing_stop_loss' });
    expect(
      analyzeFeeImpact({ params: params(), closedTrades: [t], assumedCloseFee: 0.0016 }).summary.profitGatedExits,
    ).toBe(0);
    const off = analyzeFeeImpact({
      params: params({ exitProfitOnly: false }),
      closedTrades: [trade({})],
      assumedCloseFee: 0.0016,
    });
    expect(off.summary.gateFlips).toBe(0);
    expect(off.sensitivities.find((s) => s.key === 'exit_profit_only')?.active).toBe(false);
  });

  it('skips open trades and trades without fee data, and handles an empty list', () => {
    const r = analyzeFeeImpact({
      params: null,
      closedTrades: [trade({ isOpen: true }), trade({ feeCloseRate: null })],
      assumedCloseFee: 0.0016,
    });
    expect(r.trades).toHaveLength(0);
    expect(r.summary.actualCloseFeeAvg).toBeNull();
    expect(r.summary.gapPoints).toBeNull();
  });

  it('marks entries as fee-independent and orders trades newest first', () => {
    const r = analyzeFeeImpact({
      params: params(),
      closedTrades: [trade({ tradeId: 1, closedAt: 5 }), trade({ tradeId: 2, closedAt: 9 })],
      assumedCloseFee: 0.0025,
    });
    expect(r.trades.map((t) => t.tradeId)).toEqual([2, 1]);
    const entries = r.sensitivities.find((s) => s.key === 'entries');
    expect(entries?.active).toBe(false);
    expect(entries?.shiftPoints).toBe(0);
  });
});

describe('analyzeFeeImpact with the default entry-fee basis', () => {
  // Real VoteMax exits: entries paid 0.25 % (old tier), exits paid 0.40 % / 0.80 %.
  const t3 = trade({
    tradeId: 3,
    pair: 'ETH/USD',
    openRate: 100,
    closeRate: 100.98,
    feeOpenRate: 0.0025,
    feeCloseRate: 0.008,
  });
  const t5 = trade({ tradeId: 5, openRate: 100, closeRate: 100.57, feeOpenRate: 0.0025, feeCloseRate: 0.004 });
  const t7 = trade({ tradeId: 7, openRate: 100, closeRate: 103.68, feeOpenRate: 0.004, feeCloseRate: 0.004 });

  it('assumes each trade closes at its own entry fee, and flags exits that only passed on that guess', () => {
    const r = analyzeFeeImpact({ params: params(), closedTrades: [t3, t5, t7], assumedCloseFee: null });
    expect(r.summary.basis).toBe('entry');
    expect(r.summary.gateFlips).toBe(2);
    expect(r.summary.profitGatedExits).toBe(3);
    expect(r.trades.find((t) => t.tradeId === 3)?.gateFlipped).toBe(true);
    expect(r.trades.find((t) => t.tradeId === 5)?.gateFlipped).toBe(true);
    expect(r.trades.find((t) => t.tradeId === 7)?.gateFlipped).toBe(false);
    // trade 7 paid the same fee both ways, so it contributes no gap
    expect(r.trades.find((t) => t.tradeId === 7)?.closeFeeGapUsd).toBeCloseTo(0, 10);
  });

  it('reports the average believed fee and a negative gap when the bot under-estimated', () => {
    const r = analyzeFeeImpact({ params: params(), closedTrades: [t3, t5], assumedCloseFee: null });
    expect(r.summary.assumedCloseFee).toBeCloseTo(0.0025, 10);
    expect(r.summary.actualCloseFeeAvg).toBeCloseTo(0.006, 10);
    expect(r.summary.gapPoints).toBeCloseTo(-0.35, 6);
  });

  it('a fixed rate still overrides the entry fee and is labelled fixed', () => {
    const r = analyzeFeeImpact({ params: params(), closedTrades: [t7], assumedCloseFee: 0.0016 });
    expect(r.summary.basis).toBe('fixed');
    expect(r.summary.assumedCloseFee).toBeCloseTo(0.0016, 10);
  });
});
