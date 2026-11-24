import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '../client';
import { installTempDb, type TempDb } from '../testing';
import { loadSourceStates, saveSourceState } from './sourceState';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

describe('source state', () => {
  it('starts empty', () => {
    expect(loadSourceStates()).toEqual({});
  });

  it('round-trips a source, including a JSON payload', () => {
    saveSourceState(
      {
        source: 'kraken:closedOrders',
        lastOkAt: 1000,
        lastAttemptAt: 2000,
        consecutiveFailures: 2,
        lastError: 'EAPI:Invalid nonce',
        payload: { cursorSec: 1790000000, seen: ['a', 'b'] },
      },
      3000,
    );

    expect(loadSourceStates()).toEqual({
      'kraken:closedOrders': {
        source: 'kraken:closedOrders',
        lastOkAt: 1000,
        lastAttemptAt: 2000,
        consecutiveFailures: 2,
        lastError: 'EAPI:Invalid nonce',
        payload: { cursorSec: 1790000000, seen: ['a', 'b'] },
        updatedAt: 3000,
      },
    });
  });

  it('upserts by source and keys the result by source', () => {
    const base = { lastOkAt: null, lastAttemptAt: null, consecutiveFailures: 0, lastError: null };
    saveSourceState({ ...base, source: 'bot:votemax:status' }, 1);
    saveSourceState({ ...base, source: 'bot:dca:status', consecutiveFailures: 1 }, 2);
    saveSourceState({ ...base, source: 'bot:votemax:status', lastOkAt: 50 }, 3);

    const all = loadSourceStates();
    expect(Object.keys(all).sort()).toEqual(['bot:dca:status', 'bot:votemax:status']);
    expect(all['bot:votemax:status']).toMatchObject({ lastOkAt: 50, updatedAt: 3, payload: null });
    expect(all['bot:dca:status']).toMatchObject({ consecutiveFailures: 1, updatedAt: 2 });
  });

  it('keeps the stored payload when it is omitted and clears it on null', () => {
    const base = { source: 'logtail:dca', lastOkAt: 1, lastAttemptAt: 1, consecutiveFailures: 0, lastError: null };
    saveSourceState({ ...base, payload: { keep: true } }, 1);

    saveSourceState({ ...base, lastOkAt: 2 }, 2);
    expect(loadSourceStates()['logtail:dca']).toMatchObject({ lastOkAt: 2, payload: { keep: true } });

    saveSourceState({ ...base, payload: null }, 3);
    expect(loadSourceStates()['logtail:dca']?.payload).toBeNull();
  });

  it('clips very long error text', () => {
    saveSourceState(
      {
        source: 'market:ticker',
        lastOkAt: null,
        lastAttemptAt: 1,
        consecutiveFailures: 1,
        lastError: 'x'.repeat(MAX_TEXT_LENGTH + 500),
      },
      1,
    );
    expect(loadSourceStates()['market:ticker']?.lastError).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('tolerates a corrupt payload cell', () => {
    saveSourceState(
      { source: 's', lastOkAt: null, lastAttemptAt: null, consecutiveFailures: 0, lastError: null, payload: { a: 1 } },
      1,
    );
    temp.db.prepare("UPDATE source_state SET payload_json = '{broken'").run();
    expect(loadSourceStates()['s']?.payload).toBeNull();
  });
});
