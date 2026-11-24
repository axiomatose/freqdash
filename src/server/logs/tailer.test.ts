import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogTailer, type LogCursor, type LogTailerOptions, type TailPoll } from './tailer';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const HOUR = 3_600_000;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freqdash-tailer-'));
  path = join(dir, 'votemax.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function line(msg: string, level = 'INFO', sec = 0): string {
  return `2026-09-28 04:00:${String(sec % 60).padStart(2, '0')},000 - freqtrade.test - ${level} - ${msg}\n`;
}

function lines(prefix: string, count: number, level = 'INFO'): string {
  return Array.from({ length: count }, (_, i) => line(`${prefix}${i + 1}`, level, i)).join('');
}

function tailer(overrides: Partial<LogTailerOptions> = {}): LogTailer {
  return new LogTailer({ botId: 'votemax', path, backfillHours: 24, now: () => NOW, ...overrides });
}

const messages = (r: TailPoll): string[] => r.records.map((x) => x.message);

function setMtime(file: string, msAgo: number): void {
  const t = new Date(NOW - msAgo);
  utimesSync(file, t, t);
}

/** Polls until the tailer reports nothing more; returns everything read plus the final cursor. */
async function drain(t: LogTailer, start: LogCursor | null, maxPolls = 100) {
  const all: string[] = [];
  let cursor = start;
  let polls = 0;
  for (; polls < maxPolls; polls++) {
    const r = await t.poll(cursor);
    expect(r.error).toBeUndefined();
    all.push(...messages(r));
    cursor = r.cursor;
    if (!r.more) {
      polls++;
      break;
    }
  }
  return { all, cursor, polls };
}

describe('missing or unreadable files', () => {
  it('reports an error instead of throwing and leaves the cursor alone', async () => {
    const t = tailer();
    const first = await t.poll(null);
    expect(first).toMatchObject({ records: [], cursor: null, rotated: false, more: false });
    expect(first.error).toMatch(/ENOENT/);

    const cursor: LogCursor = { file: path, headHash: 'abc', offset: 42 };
    const again = await t.poll(cursor);
    expect(again.cursor).toBe(cursor);
    expect(again.error).toBeDefined();
  });

  it('recovers once the file appears', async () => {
    const t = tailer();
    expect((await t.poll(null)).error).toBeDefined();
    writeFileSync(path, line('hello'));
    const r = await t.poll(null);
    expect(r.error).toBeUndefined();
    expect(messages(r)).toEqual(['hello']);
  });

  it('reports a directory in place of the log file as an error', async () => {
    mkdirSync(path);
    const r = await tailer().poll(null);
    expect(r.error).toBeDefined();
    expect(r.records).toEqual([]);
  });
});

describe('plain tailing', () => {
  it('reads the current file from 0 on the first run and only new lines afterwards', async () => {
    writeFileSync(path, lines('a', 3));
    const t = tailer();
    const first = await t.poll(null);
    expect(messages(first)).toEqual(['a1', 'a2', 'a3']);
    expect(first).toMatchObject({ rotated: false, more: false });
    expect(first.cursor).toMatchObject({ file: path, offset: Buffer.byteLength(lines('a', 3)) });
    expect(first.cursor!.headHash).toMatch(/^[0-9a-f]{40}$/);

    const idle = await t.poll(first.cursor);
    expect(idle.records).toEqual([]);
    expect(idle.cursor).toEqual(first.cursor);

    appendFileSync(path, lines('b', 2));
    const next = await t.poll(idle.cursor);
    expect(messages(next)).toEqual(['b1', 'b2']);
    expect(next.rotated).toBe(false);
  });

  it('starts from the persisted cursor (a restart) without re-reading', async () => {
    writeFileSync(path, lines('a', 3));
    const first = await tailer().poll(null);
    appendFileSync(path, lines('b', 1));
    const restarted = await tailer().poll(first.cursor);
    expect(messages(restarted)).toEqual(['b1']);
  });

  it('carries a partial trailing line until its newline arrives', async () => {
    writeFileSync(path, lines('a', 1));
    const t = tailer();
    const r1 = await t.poll(null);
    const partial = '2026-09-28 04:00:05,000 - freqtrade.test - INFO - half a li';
    appendFileSync(path, partial);
    const r2 = await t.poll(r1.cursor);
    expect(r2.records).toEqual([]);
    expect(r2.cursor!.offset).toBe(r1.cursor!.offset); // the partial bytes were not consumed

    appendFileSync(path, 'ne\n');
    const r3 = await t.poll(r2.cursor);
    expect(messages(r3)).toEqual(['half a line']);
  });

  it('keeps a file that is still shorter than 256 bytes from looking rotated when it grows', async () => {
    writeFileSync(path, line('x'));
    const t = tailer();
    const r1 = await t.poll(null);
    expect(r1.cursor!.offset).toBeLessThan(256);
    appendFileSync(path, lines('y', 8));
    const r2 = await t.poll(r1.cursor);
    expect(r2.rotated).toBe(false);
    expect(messages(r2)).toHaveLength(8);
  });

  it('reads multi-byte characters intact', async () => {
    writeFileSync(path, line('naïve café ₿'));
    expect(messages(await tailer().poll(null))).toEqual(['naïve café ₿']);
  });

  it('attaches traceback continuation lines to their record', async () => {
    writeFileSync(path, line('start') + line('bad', 'WARNING') + 'Traceback\nValueError: x\n' + line('after'));
    const r = await tailer().poll(null);
    expect(r.records.map((x) => [x.message, x.continuation])).toEqual([
      ['start', []],
      ['bad', ['Traceback', 'ValueError: x']],
      ['after', []],
    ]);
  });
});

describe('rotation', () => {
  it('finishes <file>.1 from the old offset, then reads the new file from 0, without loss', async () => {
    writeFileSync(path, lines('old', 3));
    const t = tailer();
    const r1 = await t.poll(null);

    appendFileSync(path, line('old4-written-before-rotation'));
    renameSync(path, `${path}.1`);
    writeFileSync(path, lines('new', 2));

    const r2 = await t.poll(r1.cursor);
    expect(messages(r2)).toEqual(['old4-written-before-rotation', 'new1', 'new2']);
    expect(r2.rotated).toBe(true);
    expect(r2.cursor!.file).toBe(path);

    const r3 = await t.poll(r2.cursor);
    expect(r3).toMatchObject({ records: [], rotated: false });
    appendFileSync(path, line('new3'));
    expect(messages(await t.poll(r3.cursor))).toEqual(['new3']);
  });

  it('follows the cursor file through several rotations between two polls', async () => {
    writeFileSync(path, lines('a', 2));
    const t = tailer();
    const r1 = await t.poll(null);

    appendFileSync(path, line('a3'));
    renameSync(path, `${path}.1`);
    writeFileSync(path, lines('b', 2));
    // second rotation before the next poll: a -> .2, b -> .1
    renameSync(`${path}.1`, `${path}.2`);
    renameSync(path, `${path}.1`);
    writeFileSync(path, lines('c', 2));

    const r2 = await t.poll(r1.cursor);
    expect(messages(r2)).toEqual(['a3', 'b1', 'b2', 'c1', 'c2']);
    expect(r2.rotated).toBe(true);
  });

  it('consumes the final line of a rotated file even without a trailing newline', async () => {
    writeFileSync(path, lines('a', 1));
    const t = tailer();
    const r1 = await t.poll(null);
    appendFileSync(path, '2026-09-28 04:00:09,000 - freqtrade.test - INFO - last words');
    renameSync(path, `${path}.1`);
    writeFileSync(path, lines('n', 1));
    expect(messages(await t.poll(r1.cursor))).toEqual(['last words', 'n1']);
  });

  it('treats a changed head hash without a rotated sibling as a new file and re-reads from 0', async () => {
    writeFileSync(path, lines('old', 5));
    const t = tailer();
    const r1 = await t.poll(null);
    // replaced in place (no rename), and longer than the old offset, so only the head hash gives it away
    writeFileSync(path, lines('replacement', 9));
    const r2 = await t.poll(r1.cursor);
    expect(r2.rotated).toBe(true);
    expect(messages(r2)).toHaveLength(9);
    expect(messages(r2)[0]).toBe('replacement1');
  });

  it('detects in-place truncation (size < offset) and restarts at 0', async () => {
    writeFileSync(path, lines('a', 20));
    const t = tailer();
    const r1 = await t.poll(null);
    const head = Buffer.byteLength(lines('a', 20).split('\n').slice(0, 6).join('\n') + '\n');
    truncateSync(path, head); // same first bytes (same head hash), far shorter than the offset
    const r2 = await t.poll(r1.cursor);
    expect(r2.rotated).toBe(true);
    expect(messages(r2)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('ignores a cursor that belongs to another file and starts a normal first run', async () => {
    writeFileSync(path, lines('a', 2));
    const foreign: LogCursor = { file: join(dir, 'dca.log'), headHash: 'deadbeef', offset: 5 };
    const r = await tailer().poll(foreign);
    expect(r.rotated).toBe(false);
    expect(messages(r)).toEqual(['a1', 'a2']);
  });
});

describe('first-run backfill window', () => {
  function makeRotatedSet(): void {
    writeFileSync(`${path}.3`, lines('ancient', 1));
    writeFileSync(`${path}.2`, lines('older', 2));
    writeFileSync(`${path}.1`, lines('old', 2));
    writeFileSync(path, lines('cur', 2));
    setMtime(`${path}.3`, 300 * HOUR);
    setMtime(`${path}.2`, 30 * HOUR);
    setMtime(`${path}.1`, 2 * HOUR);
    setMtime(path, 0);
  }

  it('reads rotated files modified within the window (oldest first), then the current file', async () => {
    makeRotatedSet();
    const r = await tailer({ backfillHours: 48 }).poll(null);
    expect(messages(r)).toEqual(['older1', 'older2', 'old1', 'old2', 'cur1', 'cur2']);
    expect(r.cursor!.file).toBe(path);
    expect(r.rotated).toBe(false);
  });

  it('honours a narrow window and a zero window', async () => {
    makeRotatedSet();
    expect(messages(await tailer({ backfillHours: 24 }).poll(null))).toEqual(['old1', 'old2', 'cur1', 'cur2']);
    expect(messages(await tailer({ backfillHours: 0 }).poll(null))).toEqual(['cur1', 'cur2']);
  });

  it('stops at the first missing rotated file', async () => {
    writeFileSync(`${path}.2`, lines('gap', 1)); // no .1
    writeFileSync(path, lines('cur', 1));
    setMtime(`${path}.2`, HOUR);
    expect(messages(await tailer({ backfillHours: 48 }).poll(null))).toEqual(['cur1']);
  });
});

describe('per-poll byte cap', () => {
  it('spreads a big file over several polls without loss or duplication', async () => {
    writeFileSync(path, lines('m', 60));
    const size = Buffer.byteLength(lines('m', 60));
    const { all, polls, cursor } = await drain(tailer({ maxBytesPerPoll: 400 }), null);
    expect(all).toEqual(Array.from({ length: 60 }, (_, i) => `m${i + 1}`));
    expect(polls).toBeGreaterThan(size / 400);
    expect(cursor!.offset).toBe(size);
  });

  it('reports more=true while data is left and never reads more than the cap in one poll', async () => {
    writeFileSync(path, lines('m', 60));
    const r = await tailer({ maxBytesPerPoll: 400 }).poll(null);
    expect(r.more).toBe(true);
    expect(r.cursor!.offset).toBeLessThanOrEqual(400);
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records.length).toBeLessThan(60);
  });

  it('carries the backfill across rotated files over multiple polls', async () => {
    writeFileSync(`${path}.1`, lines('r', 30));
    writeFileSync(path, lines('c', 30));
    setMtime(`${path}.1`, HOUR);
    const { all } = await drain(tailer({ maxBytesPerPoll: 500 }), null);
    expect(all).toEqual([
      ...Array.from({ length: 30 }, (_, i) => `r${i + 1}`),
      ...Array.from({ length: 30 }, (_, i) => `c${i + 1}`),
    ]);
  });

  it('splits a single line that is longer than the whole cap instead of stalling', async () => {
    writeFileSync(path, line('x'.repeat(2_000)) + line('tail'));
    const { all } = await drain(tailer({ maxBytesPerPoll: 300 }), null);
    expect(all.at(-1)).toBe('tail');
  });
});

describe('records that may still be growing', () => {
  const fatalHeader = '2026-09-28 04:00:30,000 - freqtrade - ERROR - Fatal exception!\n';

  it('holds a trailing ERROR record until the file stops growing, then emits it with its traceback', async () => {
    writeFileSync(path, lines('a', 2) + fatalHeader + 'Traceback (most recent call last):\n');
    const t = tailer();
    const r1 = await t.poll(null);
    expect(messages(r1)).toEqual(['a1', 'a2']); // the ERROR record is held back
    expect(r1.cursor!.offset).toBe(Buffer.byteLength(lines('a', 2)));

    appendFileSync(path, "ValueError: invalid literal for int() with base 10: ''\n");
    const r2 = await t.poll(r1.cursor); // grew since the hold: still held
    expect(r2.records).toEqual([]);

    const r3 = await t.poll(r2.cursor); // quiet: released
    expect(r3.records).toHaveLength(1);
    expect(r3.records[0]).toMatchObject({ level: 'ERROR', message: 'Fatal exception!' });
    expect(r3.records[0]!.continuation.at(-1)).toBe("ValueError: invalid literal for int() with base 10: ''");
    expect(r3.cursor!.offset).toBe(
      Buffer.byteLength(lines('a', 2) + fatalHeader) +
        Buffer.byteLength(
          'Traceback (most recent call last):\n' + "ValueError: invalid literal for int() with base 10: ''\n",
        ),
    );

    const r4 = await t.poll(r3.cursor);
    expect(r4.records).toEqual([]);
  });

  it('releases the ERROR record immediately once a later record closes it', async () => {
    writeFileSync(path, fatalHeader + 'Traceback\nKeyError: 1\n' + lines('after', 1));
    const r = await tailer().poll(null);
    expect(r.records.map((x) => [x.level, x.message])).toEqual([
      ['ERROR', 'Fatal exception!'],
      ['INFO', 'after1'],
    ]);
    expect(r.records[0]!.continuation).toEqual(['Traceback', 'KeyError: 1']);
  });

  it('handles an ERROR record that is the only content of the file', async () => {
    writeFileSync(path, fatalHeader + 'ValueError: x\n');
    const t = tailer();
    const r1 = await t.poll(null);
    expect(r1.records).toEqual([]);
    expect(r1.cursor!.offset).toBe(0);
    const r2 = await t.poll(r1.cursor);
    expect(r2.records).toHaveLength(1);
    expect(r2.records[0]!.continuation).toEqual(['ValueError: x']);
  });

  it('does not hold WARNING or INFO records', async () => {
    writeFileSync(path, line('w', 'WARNING'));
    expect(messages(await tailer().poll(null))).toEqual(['w']);
  });

  it('emits a held record for good when its file is rotated away', async () => {
    writeFileSync(path, lines('a', 1));
    const t = tailer();
    const r1 = await t.poll(null);
    appendFileSync(path, fatalHeader + 'ValueError: y\n');
    const r2 = await t.poll(r1.cursor); // held
    expect(r2.records).toEqual([]);
    renameSync(path, `${path}.1`);
    writeFileSync(path, lines('n', 1));
    const r3 = await t.poll(r2.cursor);
    expect(r3.rotated).toBe(true);
    expect(r3.records.map((x) => x.message)).toEqual(['Fatal exception!', 'n1']);
    expect(r3.records[0]!.continuation).toEqual(['ValueError: y']);
  });
});
