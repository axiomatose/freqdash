import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotEvent, BotEventType } from '@/shared/types/domain';
import { MAX_TEXT_LENGTH } from '../client';
import { installTempDb, type TempDb } from '../testing';
import {
  insertEvents,
  listEvents,
  LONG_EVENT_RETENTION_MS,
  pruneBotEvents,
  SHORT_EVENT_RETENTION_MS,
} from './botEvents';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

let seq = 0;
function event(over: Partial<BotEvent> = {}): BotEvent {
  seq += 1;
  return { botId: 'votemax', at: 1000 + seq, type: 'startup', source: 'logfile', fingerprint: `fp-${seq}`, ...over };
}

describe('insertEvents', () => {
  it('inserts events and returns the number of new rows', () => {
    expect(insertEvents([])).toBe(0);
    expect(insertEvents([event(), event()])).toBe(2);
  });

  it('is idempotent by fingerprint, within and across batches', () => {
    const e = event({ fingerprint: 'same' });
    expect(insertEvents([e, { ...e }])).toBe(1);
    expect(insertEvents([{ ...e, message: 'changed' }])).toBe(0);
    const stored = listEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.message).toBeUndefined(); // the first write wins
  });

  it('round-trips every optional field and omits the empty ones', () => {
    const full: BotEvent = {
      botId: 'dca',
      at: 1790568007965,
      type: 'order_created',
      source: 'logfile',
      orderId: 'OX2D7A-ROVIF-A3YVZW',
      pair: 'ETH/USD',
      price: 2612.4,
      stakeUsd: 11.5,
      message: 'Order OX2D7A-ROVIF-A3YVZW was created',
      fingerprint: 'a',
    };
    const minimal: BotEvent = { botId: 'dca', at: 5, type: 'startup', source: 'health', fingerprint: 'b' };
    insertEvents([full, minimal]);

    expect(listEvents({ order: 'asc' })).toEqual([minimal, full]);
    expect(Object.keys(listEvents({ types: ['startup'] })[0] ?? {}).sort()).toEqual(
      ['at', 'botId', 'fingerprint', 'source', 'type'].sort(),
    );
  });

  it('clips oversized messages', () => {
    insertEvents([event({ message: 'y'.repeat(MAX_TEXT_LENGTH + 10) })]);
    expect(listEvents()[0]?.message).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('writes a batch atomically', () => {
    const bad = { ...event(), at: undefined } as unknown as BotEvent;
    expect(() => insertEvents([event(), bad])).toThrow();
    expect(listEvents()).toEqual([]);
  });
});

describe('listEvents', () => {
  beforeEach(() => {
    insertEvents([
      event({ botId: 'votemax', at: 100, type: 'startup', fingerprint: 'e1' }),
      event({ botId: 'votemax', at: 200, type: 'fatal', fingerprint: 'e2' }),
      event({ botId: 'dca', at: 300, type: 'order_created', fingerprint: 'e3' }),
      event({ botId: 'votemax', at: 400, type: 'order_created', fingerprint: 'e4' }),
    ]);
  });

  const fps = (events: BotEvent[]): string[] => events.map((e) => e.fingerprint);

  it('returns newest first by default and oldest first on request', () => {
    expect(fps(listEvents())).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(fps(listEvents({ order: 'asc' }))).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('filters by bot, since (inclusive) and types', () => {
    expect(fps(listEvents({ botId: 'votemax' }))).toEqual(['e4', 'e2', 'e1']);
    expect(fps(listEvents({ since: 300 }))).toEqual(['e4', 'e3']);
    expect(fps(listEvents({ types: ['order_created', 'fatal'] }))).toEqual(['e4', 'e3', 'e2']);
    expect(fps(listEvents({ botId: 'votemax', since: 150, types: ['order_created'] }))).toEqual(['e4']);
  });

  it('treats an empty type list as "nothing"', () => {
    expect(listEvents({ types: [] })).toEqual([]);
  });

  it('applies limit after ordering', () => {
    expect(fps(listEvents({ limit: 2 }))).toEqual(['e4', 'e3']);
    expect(fps(listEvents({ limit: 2, order: 'asc' }))).toEqual(['e1', 'e2']);
    expect(listEvents({ limit: 0 })).toEqual([]);
  });
});

describe('pruneBotEvents', () => {
  const NOW = 2_000_000_000_000;
  const at = (ms: number): number => NOW - ms;
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps order_created/order_canceled 365 days and every other type 90 days', () => {
    const types: BotEventType[] = [
      'startup',
      'fatal',
      'process_died',
      'order_failed',
      'error',
      'identity_changed',
      'unreachable',
      'recovered',
    ];
    const events: BotEvent[] = [];
    for (const type of types) {
      events.push(event({ type, at: at(89 * DAY), fingerprint: `${type}-fresh` }));
      events.push(event({ type, at: at(91 * DAY), fingerprint: `${type}-old` }));
    }
    for (const type of ['order_created', 'order_canceled'] as const) {
      events.push(event({ type, at: at(91 * DAY), fingerprint: `${type}-91d` }));
      events.push(event({ type, at: at(364 * DAY), fingerprint: `${type}-364d` }));
      events.push(event({ type, at: at(366 * DAY), fingerprint: `${type}-366d` }));
    }
    insertEvents(events);

    const deleted = pruneBotEvents(NOW);

    expect(deleted).toBe(types.length + 2);
    const kept = new Set(listEvents().map((e) => e.fingerprint));
    for (const type of types) {
      expect(kept.has(`${type}-fresh`)).toBe(true);
      expect(kept.has(`${type}-old`)).toBe(false);
    }
    for (const type of ['order_created', 'order_canceled']) {
      expect(kept.has(`${type}-91d`)).toBe(true);
      expect(kept.has(`${type}-364d`)).toBe(true);
      expect(kept.has(`${type}-366d`)).toBe(false);
    }
  });

  it('applies the boundaries exactly (cutoff is exclusive of the retained instant)', () => {
    insertEvents([
      event({ type: 'error', at: NOW - SHORT_EVENT_RETENTION_MS, fingerprint: 'edge-short' }),
      event({ type: 'error', at: NOW - SHORT_EVENT_RETENTION_MS - 1, fingerprint: 'past-short' }),
      event({ type: 'order_created', at: NOW - LONG_EVENT_RETENTION_MS, fingerprint: 'edge-long' }),
      event({ type: 'order_created', at: NOW - LONG_EVENT_RETENTION_MS - 1, fingerprint: 'past-long' }),
    ]);
    pruneBotEvents(NOW);
    expect(new Set(listEvents().map((e) => e.fingerprint))).toEqual(new Set(['edge-short', 'edge-long']));
  });
});
