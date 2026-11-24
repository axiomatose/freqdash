import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTempDb, type TempDb } from '../testing';
import { getCursor, saveCursor } from './logCursors';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

describe('log cursors', () => {
  it('returns null for an unknown bot', () => {
    expect(getCursor('votemax')).toBeNull();
  });

  it('saves and reads a cursor, stamping updatedAt from the clock argument', () => {
    saveCursor({ botId: 'votemax', file: '/ftlogs/votemax.log', headHash: 'abc123', offset: 1_048_576 }, 5000);
    expect(getCursor('votemax')).toEqual({
      botId: 'votemax',
      file: '/ftlogs/votemax.log',
      headHash: 'abc123',
      offset: 1_048_576,
      updatedAt: 5000,
    });
  });

  it('replaces the cursor of the same bot (rotation) and leaves other bots alone', () => {
    saveCursor({ botId: 'votemax', file: '/ftlogs/votemax.log', headHash: 'old', offset: 900 }, 1);
    saveCursor({ botId: 'dca', file: '/ftlogs/dca.log', headHash: 'dca-hash', offset: 10 }, 2);
    saveCursor({ botId: 'votemax', file: '/ftlogs/votemax.log', headHash: 'new', offset: 0 }, 3);

    expect(getCursor('votemax')).toMatchObject({ headHash: 'new', offset: 0, updatedAt: 3 });
    expect(getCursor('dca')).toMatchObject({ headHash: 'dca-hash', offset: 10, updatedAt: 2 });
  });
});
