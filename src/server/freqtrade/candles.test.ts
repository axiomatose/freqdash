import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candleSignals, isSignalOn, parsePairCandles } from './candles';

function fixture(name: string): unknown {
  const url = new URL(`../../../test/fixtures/raw/freqtrade/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

const HOUR = 3_600;

describe('parsePairCandles: votemax BTC 4h (38 columns)', () => {
  const parsed = parsePairCandles(fixture('votemax_pair_candles_BTC_4h'));

  it('carries the metadata, converting last_analyzed_ts from seconds (F4)', () => {
    expect(parsed).toMatchObject({
      strategy: 'VoteMaxMulti',
      pair: 'BTC/USD',
      timeframe: '4h',
      timeframeMs: 14_400_000,
      lastAnalyzedAt: 1790628573000,
      dataStartAt: 1790568000000,
      dataStopAt: 1790611200000,
    });
    expect(parsed.columns).toHaveLength(38);
    expect(parsed.columns[0]).toBe('date');
    expect(parsed.columns).toContain('__date_ts');
  });

  it('builds candles in UTC seconds from __date_ts (never from date strings)', () => {
    expect(parsed.candles).toEqual([
      { time: 1790568000, open: 83319.9, high: 83516.7, low: 82688.5, close: 82931.3, volume: 430.9032745 },
      { time: 1790582400, open: 82928.8, high: 83116.1, low: 82566.4, close: 83062.3, volume: 453.75870968 },
      { time: 1790596800, open: 83062.2, high: 83795.5, low: 82568.9, close: 83340.3, volume: 666.48973891 },
      { time: 1790611200, open: 83339.8, high: 84338.1, low: 83081.9, close: 83350.2, volume: 706.3956689 },
    ]);
    expect(parsed.candles[1]!.time - parsed.candles[0]!.time).toBe(4 * HOUR);
  });

  it('keys rows by column name and preserves booleans, nulls, strings and numbers', () => {
    expect(parsed.rows).toHaveLength(4);
    const [r0, r1, r2, r3] = parsed.rows as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(r0.enter_long).toBeNull();
    expect(r0.at_support).toBe(false);
    expect(r0.enter_tag).toBe('');
    expect(r0.__date_ts).toBe(1790568000000);
    expect(r0._enter_long_signal_close).toBeNull();
    expect(r2.enter_long).toBe(1);
    expect(r2.enter_tag).toBe('vote_entry');
    expect(r2._enter_long_signal_close).toBe(83340.3);
    expect(r3.enter_long).toBe(1);
    expect(r1.enter_long).toBeNull();
    expect(r1.entry_score).toBe(1);
  });

  it('shows enter signals on the 12:00 and 16:00 rows', () => {
    const signals = candleSignals(parsed.rows);
    expect(signals.map((s) => [new Date(s.time * 1000).toISOString().slice(11, 16), s.enter, s.enterTag])).toEqual([
      ['04:00', false, null],
      ['08:00', false, null],
      ['12:00', true, 'vote_entry'],
      ['16:00', true, 'vote_entry'],
    ]);
    expect(signals.every((s) => !s.exit)).toBe(true);
  });
});

describe('parsePairCandles: dca (19 columns)', () => {
  it('handles the DCA layout where only the last row carries 0.0 and exit_long is 0 (F9)', () => {
    const parsed = parsePairCandles(fixture('dca_pair_candles_ETH_4h'));
    expect(parsed.strategy).toBe('DcaBot');
    expect(parsed.columns).toHaveLength(19);
    expect(parsed.candles).toHaveLength(4);
    const signals = candleSignals(parsed.rows);
    expect(signals.every((s) => !s.enter && !s.exit)).toBe(true);
    expect(parsed.rows[0]!.exit_long).toBe(0);
    expect(parsed.rows[3]!.enter_long).toBe(0);
    expect(parsed.rows[0]!.enter_long).toBeNull();
  });
});

describe('parsePairCandles: edge cases', () => {
  const base = { columns: ['date', 'open', 'high', 'low', 'close', 'volume', '__date_ts'] };

  it('drops rows without a finite OHLC or a usable time, keeps null volume as 0, and sorts by time', () => {
    const parsed = parsePairCandles({
      ...base,
      data: [
        ['x', 2, 3, 1, 2.5, null, 1790582400000],
        ['x', null, 3, 1, 2.5, 10, 1790568000000],
        ['x', 1, 2, 0.5, 1.5, 10, 1790568000000],
        ['2026-09-28 12:00:00', 1, 2, 0.5, 1.5, 10, null],
      ],
    });
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.candles).toEqual([
      { time: 1790568000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: 1790582400, open: 2, high: 3, low: 1, close: 2.5, volume: 0 },
    ]);
  });

  it('falls back to an ISO date only when it carries an explicit zone', () => {
    const parsed = parsePairCandles({
      ...base,
      data: [
        ['2026-09-28T12:00:00Z', 1, 2, 0.5, 1.5, 10, null],
        ['2026-09-28 16:00:00', 1, 2, 0.5, 1.5, 10, null],
      ],
    });
    expect(parsed.candles.map((c) => c.time)).toEqual([1790596800]);
  });

  it('pads short rows with null and tolerates missing metadata', () => {
    const parsed = parsePairCandles({ columns: ['a', 'b'], data: [[1]] });
    expect(parsed.rows).toEqual([{ a: 1, b: null }]);
    expect(parsed.candles).toEqual([]);
    expect(parsed).toMatchObject({ strategy: null, pair: null, lastAnalyzedAt: null, dataStopAt: null });
  });

  it('throws when the payload is not a candle response', () => {
    expect(() => parsePairCandles({ nope: 1 })).toThrow();
  });
});

describe('isSignalOn', () => {
  it('accepts null / 0 / 1.0 / booleans as freqtrade sends them', () => {
    expect(isSignalOn(null)).toBe(false);
    expect(isSignalOn(0)).toBe(false);
    expect(isSignalOn(0.0)).toBe(false);
    expect(isSignalOn(1.0)).toBe(true);
    expect(isSignalOn(true)).toBe(true);
    expect(isSignalOn(false)).toBe(false);
    expect(isSignalOn('1')).toBe(false);
    expect(isSignalOn(Number.NaN)).toBe(false);
  });
});
