import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTempDb, type TempDb } from '../testing';
import { listSignals, upsertSignals, type SignalRecord } from './signals';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const H4 = 4 * 60 * 60 * 1000;
const T0 = 1_790_596_800_000;

function signal(over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    botId: 'dca',
    pair: 'BTC/USD',
    timeframe: '4h',
    candleAt: T0,
    enter: true,
    exit: false,
    enterTag: 'dip',
    exitTag: null,
    firstSeenAt: T0 + H4,
    ...over,
  };
}

describe('signal history', () => {
  it('starts empty and ignores an empty batch', () => {
    upsertSignals([]);
    expect(listSignals()).toEqual([]);
  });

  it('round-trips a record with real booleans', () => {
    upsertSignals([signal({ exit: true, exitTag: 'roi' })]);
    expect(listSignals()).toEqual([signal({ exit: true, exitTag: 'roi' })]);
  });

  it('is keyed by (bot, pair, timeframe, candle): the same candle recorded twice stays one row', () => {
    upsertSignals([signal(), signal()]);
    upsertSignals([signal({ firstSeenAt: T0 + H4 + 5000 })]);
    expect(listSignals()).toHaveLength(1);
    upsertSignals([signal({ pair: 'ETH/USD' }), signal({ timeframe: '1h' }), signal({ botId: 'votemax' })]);
    expect(listSignals()).toHaveLength(4);
  });

  it('keeps the earliest firstSeenAt', () => {
    upsertSignals([signal({ firstSeenAt: 500 })]);
    upsertSignals([signal({ firstSeenAt: 900 })]);
    expect(listSignals()[0]?.firstSeenAt).toBe(500);
    upsertSignals([signal({ firstSeenAt: 100 })]);
    expect(listSignals()[0]?.firstSeenAt).toBe(100);
  });

  it('makes enter/exit sticky and fills empty tags', () => {
    upsertSignals([signal({ enter: true, exit: false, enterTag: null, exitTag: null })]);
    upsertSignals([signal({ enter: false, exit: true, enterTag: 'late-tag', exitTag: 'roi' })]);
    upsertSignals([signal({ enter: false, exit: false, enterTag: 'ignored', exitTag: 'ignored' })]);

    expect(listSignals()).toEqual([
      expect.objectContaining({ enter: true, exit: true, enterTag: 'late-tag', exitTag: 'roi' }),
    ]);
  });

  it('lists in candle order and filters by bot, pair, timeframe and candle range', () => {
    upsertSignals([
      signal({ candleAt: T0 + 2 * H4 }),
      signal({ candleAt: T0 }),
      signal({ candleAt: T0 + H4, pair: 'ETH/USD' }),
      signal({ candleAt: T0 + 3 * H4, botId: 'votemax', timeframe: '1h' }),
    ]);
    const at = (rows: SignalRecord[]): number[] => rows.map((r) => r.candleAt);

    expect(at(listSignals())).toEqual([T0, T0 + H4, T0 + 2 * H4, T0 + 3 * H4]);
    expect(at(listSignals({ botId: 'dca' }))).toEqual([T0, T0 + H4, T0 + 2 * H4]);
    expect(at(listSignals({ botId: 'dca', pair: 'BTC/USD' }))).toEqual([T0, T0 + 2 * H4]);
    expect(at(listSignals({ timeframe: '1h' }))).toEqual([T0 + 3 * H4]);
    expect(at(listSignals({ since: T0 + H4, until: T0 + 2 * H4 }))).toEqual([T0 + H4, T0 + 2 * H4]);
  });

  it('writes a batch atomically', () => {
    const bad = { ...signal({ candleAt: T0 + H4 }), botId: undefined } as unknown as SignalRecord;
    expect(() => upsertSignals([signal(), bad])).toThrow();
    expect(listSignals()).toEqual([]);
  });
});
