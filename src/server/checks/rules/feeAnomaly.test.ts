import { describe, expect, it } from 'vitest';
import type { BotOrder, BotTradeBase, KrakenOrder } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import {
  DAY,
  T0,
  baseTrade,
  botOrder,
  healthyBot,
  input,
  krakenOrder,
  krakenView,
} from '../../../../test/fixtures/incident/builders';
import { withPnl } from '@/server/accounting';
import { DEFAULT_CHECK_CONFIG } from '../config';
import { feeAnomaly } from './feeAnomaly';

const BUY = 'O6YZHE-ACUWY-K3QJJT';
const SELL = 'OW5JLC-JQWBF-JNHIWM';

const entry = (over: Partial<BotOrder> = {}) => botOrder({ orderId: BUY, filled: 1, cost: 100, price: 100, ...over });
const exit = (over: Partial<BotOrder> = {}) =>
  botOrder({ orderId: SELL, side: 'sell', isEntry: false, filled: 1, cost: 100, price: 100, ...over });

function run(trade: Partial<BotTradeBase>, kraken: KrakenOrder[] | null, over: Partial<CheckInput> = {}) {
  const t = withPnl(baseTrade({ isOpen: false, orders: [entry(), exit()], ...trade }), null);
  return feeAnomaly(
    input({
      bots: [healthyBot('votemax', T0, { closedTrades: [t] })],
      kraken: kraken === null ? null : krakenView({ orders: kraken }),
      ...over,
    }),
  );
}

const kraken = (over: Partial<KrakenOrder>, txid = BUY) => krakenOrder({ txid, costUsd: 100, feeUsd: 0.4, ...over });

describe('FEE_ANOMALY with Kraken data', () => {
  it('is silent for fees at the expected 0.4 % taker rate on both sides', () => {
    expect(run({}, [kraken({}), kraken({}, SELL)])).toEqual([]);
  });

  it('flags a Kraken rate above expectedTaker x 1.25 + 0.05 % (boundary, with round numbers)', () => {
    const cfg = { ...DEFAULT_CHECK_CONFIG, feeTakerFactor: 1, feeTakerSlack: 0, feeDefaultTaker: 0.5 };
    const trade = { feeOpenRate: 0.5, feeCloseRate: 0.5 };
    expect(run(trade, [kraken({ feeUsd: 50 }), kraken({ feeUsd: 50 }, SELL)], { cfg })).toEqual([]);
    const [f] = run(trade, [kraken({ feeUsd: 51 }), kraken({ feeUsd: 50 }, SELL)], { cfg });
    expect(f!.evidence).toMatchObject({
      orders: [{ orderId: BUY, reasons: expect.arrayContaining(['kraken_fee_above_schedule']) }],
    });
  });

  it('uses the fee tier of the pair from TradeVolume when known', () => {
    // 0.5 % is fine for the default 0.4 % taker (limit 0.55 %) but too high for a 0.25 % tier (limit 0.36 %)
    const orders = [kraken({ feeUsd: 0.5 }), kraken({ feeUsd: 0.3 }, SELL)];
    const trade = { feeOpenRate: 0.005, feeCloseRate: 0.003 };
    expect(run(trade, orders)).toEqual([]);
    const tiered = { kraken: krakenView({ orders, feeTier: { 'ETH/USD': { taker: 0.0025, maker: 0.0015 } } }) };
    const t = withPnl(baseTrade({ isOpen: false, ...trade, orders: [entry(), exit()] }), null);
    const found = feeAnomaly(input({ bots: [healthyBot('votemax', T0, { closedTrades: [t] })], ...tiered }));
    expect(found).toHaveLength(1);
    expect((found[0]!.evidence as { orders: { expectedTaker: number }[] }).orders[0]!.expectedTaker).toBe(0.0025);
  });

  it('flags a missing bot fee rate on the side that was filled', () => {
    const [f] = run({ feeOpenRate: null, feeOpenCost: null }, [kraken({}), kraken({}, SELL)]);
    expect(f).toMatchObject({ fingerprint: 'FEE_ANOMALY:votemax:1:buy' });
    expect(f!.evidence).toMatchObject({ orders: [{ reasons: ['bot_fee_rate_missing'], botRate: null }] });
  });

  it('flags a bot rate that differs from the Kraken rate by more than 0.1 %', () => {
    expect(run({ feeOpenRate: 0.0049 }, [kraken({}), kraken({}, SELL)])).toEqual([]);
    const [f] = run({ feeOpenRate: 0.0025 }, [kraken({ feeUsd: 0.54 }), kraken({}, SELL)]);
    expect(f!.evidence).toMatchObject({ orders: [{ reasons: ['bot_fee_differs_from_kraken'] }] });
  });

  it('reports a rate that trips both checks with both reasons', () => {
    const [f] = run({ feeCloseRate: 0.008 }, [kraken({}), kraken({ feeUsd: 1.2 }, SELL)]);
    expect(f!.fingerprint).toBe('FEE_ANOMALY:votemax:1:sell');
    expect((f!.evidence as { orders: { reasons: string[] }[] }).orders[0]!.reasons).toEqual([
      'kraken_fee_above_schedule',
      'bot_fee_differs_from_kraken',
    ]);
  });

  it('falls back to the bot-only range check when Kraken has no priced record of the order', () => {
    expect(run({ feeOpenRate: 0.02 }, [])).toHaveLength(1);
    expect(run({ feeOpenRate: 0.004 }, [kraken({ costUsd: 0, feeUsd: 0 })])).toEqual([]);
    expect(run({ feeOpenRate: 0.02 }, [kraken({ costUsd: 0, feeUsd: 0 })])).toHaveLength(1);
  });
});

describe('FEE_ANOMALY bot rate against a known fee tier, without a matching Kraken order', () => {
  const tier = (taker: number) => ({ 'ETH/USD': { taker, maker: taker } });
  const runTiered = (trade: Partial<BotTradeBase>, taker: number) => {
    const t = withPnl(baseTrade({ isOpen: false, orders: [entry(), exit()], ...trade }), null);
    return feeAnomaly(
      input({
        bots: [healthyBot('votemax', T0, { closedTrades: [t] })],
        kraken: krakenView({ orders: [], feeTier: tier(taker) }),
      }),
    );
  };

  it('accepts a bot rate that matches an 0.8 % tier (not out of range)', () => {
    expect(runTiered({ feeOpenRate: 0.008, feeCloseRate: 0.008 }, 0.008)).toEqual([]);
  });

  it('flags a bot rate above the tier limit (tier x 1.25 + 0.05 %) and a negative one', () => {
    expect(runTiered({ feeOpenRate: 0.0105 }, 0.008)).toEqual([]);
    const [f] = runTiered({ feeOpenRate: 0.0106 }, 0.008);
    expect(f!.evidence).toMatchObject({
      orders: [{ reasons: ['bot_fee_out_of_range'], expectedSource: 'kraken-tier', expectedTaker: 0.008 }],
    });
    expect(runTiered({ feeCloseRate: -0.0001 }, 0.008)).toHaveLength(1);
  });

  it('still flags an 0.8 % bot rate when the tier is a 0.4 % one', () => {
    expect(runTiered({ feeCloseRate: 0.008 }, 0.004)).toHaveLength(1);
  });
});

describe('FEE_ANOMALY without Kraken (freqtrade-only)', () => {
  it('accepts rates between 0 and 0.6 % (boundary)', () => {
    expect(run({ feeOpenRate: 0.006, feeCloseRate: 0 }, null)).toEqual([]);
    expect(run({ feeOpenRate: 0.0061 }, null)).toHaveLength(1);
    expect(run({ feeCloseRate: -0.0001 }, null)).toHaveLength(1);
  });

  it('flags trade 3 of the live state: an 0.8 % exit fee', () => {
    const [f] = run({ feeCloseRate: 0.008 }, null, { now: T0 + 100 * DAY });
    expect(f).toMatchObject({ fingerprint: 'FEE_ANOMALY:votemax:1:sell', severity: 'info' });
    expect(f!.evidence).toMatchObject({
      orders: [{ reasons: ['bot_fee_out_of_range'], botRate: 0.008, krakenRate: null }],
    });
  });

  it('flags a missing rate', () => {
    expect(run({ feeCloseRate: null, feeCloseCost: null }, null)[0]!.fingerprint).toBe('FEE_ANOMALY:votemax:1:sell');
  });
});

describe('FEE_ANOMALY severity and grouping', () => {
  const stale = { feeOpenRate: 0.02 };
  it('is a warning for a recent fill and informational after 30 days (boundary)', () => {
    const at = (age: number) => entry({ filledAt: T0 - age, placedAt: T0 - age });
    const t = (age: number) => ({ ...stale, orders: [at(age)] });
    expect(run(t(30 * DAY), null)[0]!.severity).toBe('warning');
    expect(run(t(30 * DAY + 1), null)[0]!.severity).toBe('info');
    expect(run(t(DAY), null)[0]!.severity).toBe('warning');
  });

  it('uses the placement time when the fill time is unknown, and warns when neither is known', () => {
    expect(run({ ...stale, orders: [entry({ filledAt: null, placedAt: T0 - 40 * DAY })] }, null)[0]!.severity).toBe(
      'info',
    );
    expect(run({ ...stale, orders: [entry({ filledAt: null, placedAt: null })] }, null)[0]!.severity).toBe('warning');
  });

  it('judges by the newest flagged order of a group', () => {
    const orders = [
      entry({ orderId: 'OXCCOZ-CCRR3-BWDLA2', filledAt: T0 - 90 * DAY }),
      entry({ orderId: 'O7CLXI-3UA7R-OFDGSV', filledAt: T0 - DAY }),
    ];
    const found = run({ ...stale, orders }, null);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('warning');
    expect((found[0]!.evidence as { orders: unknown[] }).orders).toHaveLength(2);
  });

  it('gives one finding per trade side', () => {
    const found = run({ feeOpenRate: 0.02, feeCloseRate: 0.02 }, null);
    expect(found.map((f) => f.fingerprint)).toEqual(['FEE_ANOMALY:votemax:1:buy', 'FEE_ANOMALY:votemax:1:sell']);
  });

  it('ignores unfilled orders and checks open trades too', () => {
    expect(run({ feeOpenRate: 0.02, orders: [entry({ filled: 0, isOpen: true })] }, null)).toEqual([]);
    const open = withPnl(baseTrade({ feeOpenRate: 0.02, orders: [entry()] }), null);
    expect(feeAnomaly(input({ bots: [healthyBot('votemax', T0, { openTrades: [open] })] }))).toHaveLength(1);
  });
});
