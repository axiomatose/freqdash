import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '@/shared/types/domain';
import { withPnl } from '../accounting';
import { parsePairCandles } from '../freqtrade/candles';
import { normalizeTrades } from '../freqtrade/normalize';
import { buildChart, mergeCandles, type ChartInput } from './builder';
import { SingleFlightCache } from './cache';
import { buildIndicators } from './indicators';
import { snapToCandle } from './markers';

const read = (n: string): unknown =>
  JSON.parse(readFileSync(`${process.cwd()}/test/fixtures/raw/freqtrade/${n}.json`, 'utf8'));
const LINE = (color: string) => ({ color, type: 'line' });
const PLOT = {
  main_plot: {
    ema20: LINE('#f0b429'),
    ema50: LINE('#7b61ff'),
    support_4h: LINE('#2fb344'),
    resistance_4h: LINE('#d63939'),
    support_1d_1d: LINE('#5eba7d'),
  },
  subplots: {
    RSI: { rsi: LINE('#4dabf7'), rsi_ob: LINE('#d63939'), rsi_os: LINE('#2fb344') },
    Score: { entry_score: LINE('#2fb344'), exit_score: LINE('#d63939'), vote_threshold: LINE('#adb5bd') },
    Touches: { touch_sup: LINE('#2fb344'), touch_res: LINE('#d63939'), touch_threshold: LINE('#adb5bd') },
  },
};

const frame = parsePairCandles(read('votemax_pair_candles_BTC_4h'));
const trades = normalizeTrades('votemax', read('votemax_status'), { isOpen: true }).map((t) => withPnl(t, null));
const live = (time: number, liveFlag = true): Candle => ({
  time,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: 1,
  ...(liveFlag ? { live: true } : {}),
});

function input(over: Partial<ChartInput> = {}): ChartInput {
  return {
    botId: 'votemax',
    pair: 'BTC/USD',
    timeframe: '4h',
    strategyTimeframe: '4h',
    strategy: 'VoteMaxMulti',
    limit: 500,
    now: 1_790_630_000_000,
    frame,
    plotConfig: PLOT,
    kraken: [live(1_790_625_600)],
    recorded: [],
    trades,
    orphans: [],
    freshness: [],
    recordedSince: null,
    ...over,
  };
}

describe('buildIndicators', () => {
  const ind = buildIndicators(frame.rows, PLOT);
  const by = (k: string) => ind.find((i) => i.key === k);

  it('follows plot_config: ema on the main pane, RSI/Score/Touches panes', () => {
    expect(by('ema20')).toMatchObject({ placement: 'main', defaultVisible: true, color: '#f0b429' });
    expect(by('rsi')).toMatchObject({ placement: 'pane', pane: 'RSI' });
    expect(by('entry_score')?.pane).toBe('Score');
    expect(by('touch_sup')?.pane).toBe('Touches');
    expect(by('rsi_ob')?.kind).toBe('threshold');
  });

  it('shows only the strategy-timeframe support/resistance by default and steps them', () => {
    expect(by('support_4h')).toMatchObject({ kind: 'step', defaultVisible: true });
    expect(by('support_1d_1d')?.defaultVisible).toBe(false);
  });

  it('drops helper columns and hides unplaced ones in "Other"', () => {
    expect(by('__date_ts')).toBeUndefined();
    expect(by('_enter_long_signal_close')).toBeUndefined();
    expect(by('vol_sma20')).toMatchObject({ pane: 'Other', defaultVisible: false });
    expect(by('at_support')?.points.every((p) => p.value === 0 || p.value === 1)).toBe(true);
  });

  it('falls back to the registry without plot_config', () => {
    const fb = buildIndicators(frame.rows, null);
    expect(fb.find((i) => i.key === 'ema50')?.placement).toBe('main');
    expect(fb.find((i) => i.key === 'rsi')?.pane).toBe('RSI');
    expect(fb.find((i) => i.key === 'entry_score')?.pane).toBe('Score');
  });
});

describe('buildChart', () => {
  it('reports the dataframe signals at 12:00 and 16:00', () => {
    const c = buildChart(input());
    expect(c.signals.filter((s) => s.kind === 'enter').map((s) => s.time)).toEqual([1_790_596_800, 1_790_611_200]);
    expect(c.source).toBe('freqtrade');
  });

  it('snaps the trade-8 fill onto the live Kraken candle', () => {
    const c = buildChart(input());
    const fill = c.fills.find((f) => f.tradeId === 8 && f.isEntry);
    expect(fill?.time).toBe(1_790_625_600);
    expect(c.meta.liveCandle).toBe(true);
    expect(c.candles[c.candles.length - 1]?.live).toBe(true);
  });

  it('keeps fills and signals sorted and marks positions', () => {
    const c = buildChart(input());
    expect(c.fills.map((f) => f.time)).toEqual([...c.fills.map((f) => f.time)].sort((a, b) => a - b));
    expect(c.positions[0]).toMatchObject({ tradeId: 8 });
  });

  it('adds the signals note for DcaBot only', () => {
    expect(buildChart(input({ strategy: 'DcaBot', recordedSince: Date.UTC(2026, 8, 1) })).meta.signalsNote).toMatch(
      /since 2026-09-01/,
    );
    expect(buildChart(input()).meta.signalsNote).toBeNull();
  });

  it('unions recorded signals for candles the dataframe no longer flags', () => {
    const c = buildChart(
      input({ recorded: [{ time: 1_790_568_000, enter: true, exit: false, enterTag: 't', exitTag: null }] }),
    );
    expect(c.signals.find((s) => s.time === 1_790_568_000)).toMatchObject({ source: 'recorded', tag: 't' });
  });

  it('uses Kraken only, without indicators, for other timeframes', () => {
    const k = [live(1000, false), live(1900, false), live(2800)];
    const c = buildChart(input({ timeframe: '15m', kraken: k }));
    expect(c).toMatchObject({ source: 'kraken', strategy: null, indicators: [], signals: [] });
    expect(c.candles).toHaveLength(3);
  });

  it('shows Kraken orphan fills as their own origin', () => {
    const c = buildChart(
      input({
        orphans: [
          {
            txid: 'OWDY2Z-TVWRN-IJBALL',
            pair: 'BTC/USD',
            krakenPair: 'XBTUSD',
            side: 'buy',
            orderType: 'market',
            status: 'closed',
            openedAt: 1_790_600_000_000,
            closedAt: 1_790_600_030_000,
            vol: 1,
            volExec: 1,
            costUsd: 80000,
            feeUsd: 0,
            avgPrice: 80000,
            limitPrice: null,
            userref: null,
            clOrdId: null,
            reason: null,
          },
        ],
      }),
    );
    expect(c.fills.find((f) => f.origin === 'kraken-orphan')).toMatchObject({
      botId: null,
      orderId: 'OWDY2Z-TVWRN-IJBALL',
    });
  });

  it('draws a manual source: Kraken candles only, manual fills and the derived average entry line', () => {
    const order = (txid: string, side: 'buy' | 'sell', at: number, price: number) => ({
      txid,
      pair: 'BTC/USD',
      krakenPair: 'XBTUSD',
      side,
      orderType: 'limit',
      status: 'closed' as const,
      openedAt: at,
      closedAt: at,
      vol: 1,
      volExec: 1,
      costUsd: price,
      feeUsd: 0,
      avgPrice: price,
      limitPrice: price,
      userref: null,
      clOrdId: null,
      reason: null,
    });
    const k = [live(1_790_596_800, false), live(1_790_611_200, false), live(1_790_625_600)];
    const c = buildChart(
      input({
        botId: 'manual',
        frame: null,
        strategy: null,
        strategyTimeframe: null,
        kraken: k,
        trades: [],
        orphans: [],
        manual: {
          orders: [order('b1', 'buy', 1_790_597_000_000, 80_000), order('s1', 'sell', 1_790_612_000_000, 90_000)],
          position: { avgPrice: 80_000, qty: 1 },
        },
      }),
    );
    expect(c).toMatchObject({ botId: 'manual', source: 'kraken', indicators: [], signals: [] });
    expect(c.fills.map((f) => [f.origin, f.side, f.isEntry, f.botId])).toEqual([
      ['kraken-manual', 'buy', true, null],
      ['kraken-manual', 'sell', false, null],
    ]);
    expect(c.positions).toEqual([{ botId: 'manual', tradeId: 0, avgPrice: 80_000, qty: 1 }]);
  });
});

describe('helpers', () => {
  it('merges only Kraken candles newer than the last closed one', () => {
    const merged = mergeCandles([live(100, false), live(200, false)], [live(200, false), live(300)]);
    expect(merged.map((c) => c.time)).toEqual([100, 200, 300]);
  });

  it('snaps times: before the range is dropped, after it attaches to the newest candle', () => {
    const cs = [live(100, false), live(200, false)];
    expect(snapToCandle(150, 100, cs)).toBe(100);
    expect(snapToCandle(50, 100, cs)).toBeNull();
    expect(snapToCandle(999, 100, cs)).toBe(200);
    expect(snapToCandle(1, 100, [])).toBeNull();
  });
});

describe('SingleFlightCache', () => {
  it('shares one in-flight load and refetches at most once per minute', async () => {
    let now = 0;
    const cache = new SingleFlightCache<number>({ now: () => now, isOutdated: () => true });
    const load = vi.fn(async () => {
      await Promise.resolve();
      return now;
    });
    await Promise.all([cache.get('k', load), cache.get('k', load), cache.get('k', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 30_000;
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 61_000;
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves the old value when a refetch fails, and does not retry immediately', async () => {
    let now = 0;
    const cache = new SingleFlightCache<string>({ now: () => now, ttlMs: 100_000 });
    await cache.get('k', async () => 'v1');
    now = 200_000;
    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    expect((await cache.get('k', failing)).value).toBe('v1');
    expect((await cache.get('k', failing)).value).toBe('v1');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure without a cached value', async () => {
    const cache = new SingleFlightCache<string>();
    await expect(cache.get('k', async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });
});
