import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BotHealth } from '@/shared/types/domain';
import {
  markUnreachable,
  normalizeConfig,
  normalizeHealth,
  normalizeLocks,
  normalizeOrder,
  normalizeTrades,
  normalizeWallet,
  normalizeWhitelist,
  secondsToMs,
} from './normalize';

function fixture(name: string): unknown {
  const url = new URL(`../../../test/fixtures/raw/freqtrade/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

describe('secondsToMs', () => {
  it('converts seconds and leaves ms-sized values alone', () => {
    expect(secondsToMs(1790630988)).toBe(1790630988000);
    expect(secondsToMs(1790630988000)).toBe(1790630988000);
    expect(secondsToMs(1790630988.5)).toBe(1790630988500);
  });

  it('rejects unset and invalid values', () => {
    expect(secondsToMs(null)).toBeNull();
    expect(secondsToMs(0)).toBeNull();
    expect(secondsToMs('1790630988')).toBeNull();
    expect(secondsToMs(Number.NaN)).toBeNull();
  });
});

describe('normalizeHealth', () => {
  it('turns the /health seconds into epoch ms (F4)', () => {
    expect(normalizeHealth(fixture('votemax_health'))).toEqual({
      reachable: true,
      authFailed: false,
      lastProcessAt: 1790630988000,
      botStartAt: 1775330841000,
      botStartupAt: 1790628570000,
      unreachableSince: null,
    });
  });

  it('is lenient about missing fields', () => {
    const h = normalizeHealth({ last_process_ts: 1790630988 });
    expect(h.lastProcessAt).toBe(1790630988000);
    expect(h.botStartAt).toBeNull();
    expect(h.botStartupAt).toBeNull();
  });
});

describe('markUnreachable', () => {
  const healthy: BotHealth = normalizeHealth(fixture('dca_health'));

  it('keeps the last timestamps and starts the unreachable clock', () => {
    const down = markUnreachable(healthy, 5_000, false);
    expect(down).toMatchObject({ reachable: false, authFailed: false, unreachableSince: 5_000 });
    expect(down.lastProcessAt).toBe(healthy.lastProcessAt);
    expect(down.botStartupAt).toBe(healthy.botStartupAt);
  });

  it('does not restart the clock while the bot stays down, and flags auth failures', () => {
    const first = markUnreachable(healthy, 5_000, false);
    expect(markUnreachable(first, 9_000, true)).toMatchObject({ unreachableSince: 5_000, authFailed: true });
  });

  it('works without a previous health', () => {
    expect(markUnreachable(null, 7, false)).toEqual({
      reachable: false,
      authFailed: false,
      lastProcessAt: null,
      botStartAt: null,
      botStartupAt: null,
      unreachableSince: 7,
    });
  });
});

describe('normalizeConfig', () => {
  it('maps votemax /show_config', () => {
    expect(normalizeConfig('votemax', fixture('votemax_show_config'))).toEqual({
      botId: 'votemax',
      botName: 'freqtrade-votemax',
      strategy: 'VoteMaxMulti',
      timeframe: '4h',
      timeframeMs: 14_400_000,
      stakeCurrency: 'USD',
      maxOpenTrades: 2,
      dryRun: false,
      tradingMode: 'spot',
      state: 'running',
      runmode: 'live',
      version: '2026.8',
      positionAdjustment: false,
      exchange: 'kraken',
    });
  });

  it('reports position adjustment for the DCA bot', () => {
    const c = normalizeConfig('dca', fixture('dca_show_config'));
    expect(c.strategy).toBe('DcaBot');
    expect(c.positionAdjustment).toBe(true);
  });

  it('falls back to the timeframe string when timeframe_ms is absent', () => {
    expect(normalizeConfig('x', { timeframe: '15m' }).timeframeMs).toBe(900_000);
    expect(normalizeConfig('x', { timeframe: 'weird' }).timeframeMs).toBe(0);
    expect(normalizeConfig('x', {}).botName).toBe('x');
  });
});

describe('normalizeTrades: /status (open trades, F2)', () => {
  const trades = normalizeTrades('votemax', fixture('votemax_status'), { isOpen: true });

  it('yields the one open BTC/USD trade', () => {
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t).toMatchObject({
      botId: 'votemax',
      tradeId: 8,
      key: 'votemax:8',
      pair: 'BTC/USD',
      base: 'BTC',
      quote: 'USD',
      isOpen: true,
      strategy: 'VoteMaxMulti',
      enterTag: 'vote_entry',
      exitReason: null,
      amount: 0.00046744,
      stakeAmount: 38.98940412,
      openRate: 83410.5,
      closeRate: null,
      botCurrentRate: 83414.5,
      openedAt: 1790628707427,
      openFilledAt: 1790628758621,
      closedAt: null,
      feeOpenRate: 0.00400006,
      feeOpenCost: 0.1559599558442472,
      feeCloseRate: 0.00400006,
      feeCloseCost: null,
      entries: 1,
      exits: 0,
      hasOpenOrders: false,
      ftProfitAbs: -0.31005763,
    });
  });

  it('derives isEntry for orders that lack ft_is_entry and normalizes timestamps', () => {
    const order = trades[0]!.orders[0]!;
    expect(order).toEqual({
      botId: 'votemax',
      tradeId: 8,
      orderId: 'O6ROFS-APVH7-255LCC',
      pair: 'BTC/USD',
      side: 'buy',
      isEntry: true,
      tag: 'vote_entry',
      status: 'closed',
      orderType: 'limit',
      amount: 0.00046744,
      filled: 0.00046744,
      remaining: 0,
      price: 83410.5,
      cost: 38.98940412,
      placedAt: 1790628707021,
      filledAt: 1790628758621,
      isOpen: false,
    });
  });

  it('handles an empty bot', () => {
    expect(normalizeTrades('dca', fixture('dca_status'), { isOpen: true })).toEqual([]);
  });
});

describe('normalizeTrades: /trades (closed trades)', () => {
  it('maps votemax closed trades with their fees and exit orders', () => {
    const trades = normalizeTrades('votemax', fixture('votemax_trades'), { isOpen: false });
    expect(trades.map((t) => t.tradeId)).toEqual([1, 2, 3]);
    const t1 = trades[0]!;
    expect(t1).toMatchObject({
      pair: 'ETH/USD',
      isOpen: false,
      enterTag: 'vote_entry',
      exitReason: 'vote_exit',
      closeRate: 2383.31,
      botCurrentRate: null,
      openedAt: 1777305608096,
      openFilledAt: 1777305617131,
      closedAt: 1777953618672,
      feeCloseRate: 0.00400004,
      feeCloseCost: 0.26211,
      entries: 1,
      exits: 1,
      ftProfitAbs: 2.60845801,
    });
    expect(t1.orders.map((o) => [o.orderId, o.side, o.isEntry, o.tag])).toEqual([
      ['ON76CL-MUYJS-OHK6HL', 'buy', true, 'vote_entry'],
      ['OF45GM-KAS6Y-QCVCJL', 'sell', false, 'vote_exit'],
    ]);
    expect(t1.orders[1]).toMatchObject({ price: 2383.31, cost: 65.5267966393, filledAt: 1777953618672 });
    // trade 3 carries the 0.8% exit fee (F15)
    expect(trades[2]!.feeCloseRate).toBe(0.00800001);
  });

  it('uses the fill price (average) rather than the limit price, and turns empty tags into null (dca)', () => {
    const trades = normalizeTrades('dca', fixture('dca_trades'), { isOpen: false });
    const first = trades[0]!;
    expect(first.entries).toBe(5); // nr_of_successful_entries, although only 3 orders are in the truncated sample
    expect(first.orders).toHaveLength(3);
    expect(first.ftProfitAbs).toBe(23.66290319);
    const second = first.orders[1]!;
    expect(second.tag).toBeNull(); // ft_order_tag ""
    expect(second.price).toBe(62258.2); // average, not the 62287.1 limit
    expect(second.isEntry).toBe(true);
    expect(first.orders[0]!.tag).toBe('dca_entry');
    expect(trades[1]!.exitReason).toBe('main_bot_exited');
    expect(trades[1]!.ftProfitAbs).toBe(-0.50966122);
  });

  it('accepts a bare array and lets isOpen override the trade flag', () => {
    const page = fixture('votemax_trades') as { trades: unknown[] };
    const asOpen = normalizeTrades('votemax', page.trades, { isOpen: true });
    expect(asOpen.every((t) => t.isOpen)).toBe(true);
    expect(normalizeTrades('votemax', page).every((t) => !t.isOpen)).toBe(true);
  });
});

describe('normalizeTrades: leniency', () => {
  const minimal = { trade_id: 3, pair: 'ETH/USD' };

  it('fills defaults for a bare trade', () => {
    const [t] = normalizeTrades('b', [minimal]);
    expect(t).toMatchObject({
      tradeId: 3,
      base: 'ETH',
      quote: 'USD',
      isOpen: false,
      strategy: '',
      enterTag: null,
      amount: 0,
      stakeAmount: 0,
      maxStakeAmount: 0,
      openedAt: 0,
      openFilledAt: null,
      closedAt: null,
      feeOpenRate: null,
      hasOpenOrders: false,
      entries: 0,
      exits: 0,
      ftProfitAbs: null,
      orders: [],
    });
  });

  it('turns wrong-typed leaves into null instead of failing and keeps unknown fields harmlessly', () => {
    const [t] = normalizeTrades('b', [
      { ...minimal, open_rate: 'oops', close_timestamp: null, stake_amount: 10, brand_new_field: { a: 1 } },
    ]);
    expect(t!.openRate).toBe(0);
    expect(t!.closedAt).toBeNull();
    expect(t!.maxStakeAmount).toBe(10);
  });

  it('counts filled entry and exit orders when the trade omits the counters, and falls back for opened time', () => {
    const [t] = normalizeTrades('b', [
      {
        ...minimal,
        orders: [
          { order_id: 'A', ft_order_side: 'buy', filled: 1, order_timestamp: 2_000 },
          { order_id: 'B', ft_order_side: 'buy', filled: 0, is_open: true, order_timestamp: 1_000 },
          { order_id: 'C', ft_order_side: 'sell', filled: 1, order_timestamp: 3_000 },
        ],
      },
    ]);
    expect(t).toMatchObject({ entries: 1, exits: 1, hasOpenOrders: true, openedAt: 1_000 });
  });

  it('throws on structurally invalid input', () => {
    expect(() => normalizeTrades('b', [{ pair: 'ETH/USD' }])).toThrow();
    expect(() => normalizeTrades('b', { nope: true })).toThrow();
  });
});

describe('normalizeOrder', () => {
  it('prefers an explicit ft_is_entry and infers the side from it when ft_order_side is missing', () => {
    const o = normalizeOrder('b', 1, 'ETH/USD', {
      order_id: 'X',
      ft_is_entry: false,
      order_timestamp: 5,
      safe_price: 2,
    });
    expect(o).toMatchObject({ side: 'sell', isEntry: false, price: 2, placedAt: 5, filledAt: null, tag: null });
  });
});

describe('normalizeWallet', () => {
  it('maps the full /balance sample', () => {
    const w = normalizeWallet('votemax', fixture('votemax_balance'), { fetchedAt: 123, lastWalletSyncAt: 99 });
    expect(w.botId).toBe('votemax');
    expect(w.fetchedAt).toBe(123);
    expect(w.lastWalletSyncAt).toBe(99);
    expect(w.totalUsd).toBeCloseTo(1809.544454168616, 9);
    expect(w.currencies.map((c) => c.currency)).toEqual(['BABY', 'SHIB', 'ETH', 'BTC', 'USD']);
    const btc = w.currencies.find((c) => c.currency === 'BTC')!;
    expect(btc).toEqual({
      currency: 'BTC',
      balance: 0.00046744,
      free: 0.00046744,
      used: 0,
      botOwned: 0.00046744,
      estStakeUsd: 39.022218408,
      isBotManaged: true,
    });
    expect(w.currencies.find((c) => c.currency === 'ETH')).toMatchObject({ balance: 8.9e-9, isBotManaged: false });
  });

  it('defaults lastWalletSyncAt to null and does not report a non-USD stake as USD', () => {
    expect(normalizeWallet('dca', fixture('dca_balance'), { fetchedAt: 1 }).lastWalletSyncAt).toBeNull();
    const eur = normalizeWallet(
      'x',
      {
        currencies: [{ currency: 'BTC', balance: 1, free: 1, used: 0, est_stake: 50000, stake: 'EUR' }],
        total: 50000,
        stake: 'EUR',
      },
      { fetchedAt: 1 },
    );
    expect(eur.totalUsd).toBe(0);
    expect(eur.currencies[0]!.estStakeUsd).toBeNull();
  });

  it('sums the estimates when the bot does not report a total', () => {
    const w = normalizeWallet(
      'x',
      {
        currencies: [
          { currency: 'USD', est_stake: 10 },
          { currency: 'BTC', est_stake: 5.5 },
        ],
      },
      { fetchedAt: 1 },
    );
    expect(w.totalUsd).toBe(15.5);
  });
});

describe('normalizeLocks and normalizeWhitelist', () => {
  it('returns no locks for the empty sample', () => {
    expect(normalizeLocks(fixture('votemax_locks'))).toEqual([]);
  });

  it('maps active locks using the ms end timestamp only', () => {
    const locks = normalizeLocks({
      lock_count: 3,
      locks: [
        {
          id: 1,
          pair: 'BTC/USD',
          lock_end_time: '2026-09-28T22:00:00.000Z',
          lock_end_timestamp: 1790632800000,
          reason: 'Stoploss',
          active: true,
        },
        { id: 2, pair: 'ETH/USD', lock_end_timestamp: 1790632800000, reason: '', active: false },
        { id: 3, pair: 'SHIB/USD', reason: 'x', active: true },
      ],
    });
    expect(locks).toEqual([{ pair: 'BTC/USD', until: 1790632800000, reason: 'Stoploss' }]);
  });

  it('reads the whitelist', () => {
    expect(normalizeWhitelist(fixture('votemax_whitelist'))).toEqual(['BTC/USD', 'ETH/USD']);
  });
});
