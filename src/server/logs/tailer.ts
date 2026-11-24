import 'server-only';
import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { BotId, Ms } from '@/shared/types/domain';
import { describeError } from '../log';
import { parseLogChunk, type LogRecord } from './parser';

// Log file tailer (docs/PLAN.md section 6.2). Polling (`stat` + positional reads), no inotify: Docker Desktop bind mounts
// do not deliver file events. The cursor is `{file, headHash, offset}` and is persisted by the caller (`log_cursors`):
//  * `offset` always ends on a line boundary, so a partial trailing line is simply re-read on the next poll (nothing to
//    carry across restarts);
//  * `headHash` = sha1 of the file's first 256 bytes (or of the consumed prefix while that is shorter) identifies the
//    file across rotation renames (`x.log` -> `x.log.1`) and stays stable while a young file grows;
//  * `file` is the file the cursor is in (a rotated `x.log.N` while catching up).
// Events are deduplicated by fingerprint downstream, so re-reading after an unclear rotation is harmless.

export interface LogCursor {
  file: string;
  headHash: string;
  offset: number;
}

export interface LogTailerOptions {
  botId: BotId;
  /** Absolute path of the live log file (e.g. /ftlogs/votemax.log). Rotated files are `<path>.1`, `<path>.2`, ... */
  path: string;
  /** First run only: rotated files modified within this many hours are read before the live file. */
  backfillHours: number;
  /** Cap on bytes read per poll (default 4 MiB). */
  maxBytesPerPoll?: number;
  now?: () => Ms;
}

export interface TailPoll {
  records: LogRecord[];
  /** Persist this. On error it is the cursor that was passed in (unchanged). */
  cursor: LogCursor | null;
  /** A rotation, truncation or an unknown cursor was handled during this poll. */
  rotated: boolean;
  /** The byte cap stopped this poll early: poll again soon instead of waiting a full interval. */
  more: boolean;
  /** Set when the file is missing or unreadable. The poll never throws. */
  error?: string;
}

export const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const HEAD_BYTES = 256;
/** freqtrade keeps 10 backups; looking a little further costs nothing. */
const MAX_ROTATED_FILES = 20;
const HOUR_MS = 3_600_000;

interface Source {
  path: string;
  offset: number;
  /** The live file can still grow; a rotated file cannot, so its trailing partial line is final. */
  live: boolean;
}

interface Head {
  size: number;
  head: Buffer;
}

interface ReadResult {
  records: LogRecord[];
  cursor: LogCursor;
  bytesRead: number;
  /** All bytes that existed when we looked were read (the cap did not cut this file short). */
  finished: boolean;
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

async function readExactly(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

async function readHead(fh: FileHandle, size: number): Promise<Buffer> {
  return readExactly(fh, 0, Math.min(HEAD_BYTES, size));
}

export class LogTailer {
  readonly #path: string;
  readonly #backfillMs: number;
  readonly #maxBytes: number;
  readonly #now: () => Ms;
  /**
   * A trailing ERROR/CRITICAL record may still be receiving its traceback (`Fatal exception!` is followed by ~40 lines).
   * It is held back (cursor stays at its first byte) until the file has not grown between two polls.
   */
  #held: { path: string; end: number } | null = null;

  constructor(options: LogTailerOptions) {
    this.#path = options.path;
    this.#backfillMs = Math.max(0, options.backfillHours) * HOUR_MS;
    this.#maxBytes = options.maxBytesPerPoll ?? DEFAULT_MAX_BYTES_PER_POLL;
    this.#now = options.now ?? Date.now;
  }

  async poll(cursor: LogCursor | null): Promise<TailPoll> {
    try {
      return await this.#poll(cursor);
    } catch (err) {
      return { records: [], cursor, rotated: false, more: false, error: describeError(err) };
    }
  }

  async #poll(cursor: LogCursor | null): Promise<TailPoll> {
    // Fail fast (ENOENT / EACCES / not a file) before planning anything.
    if (!(await stat(this.#path)).isFile()) throw new Error(`log path is not a regular file: ${this.#path}`);

    let rotated = false;
    let plan: Source[];
    if (cursor === null || !this.#isOwnFile(cursor.file)) {
      plan = await this.#backfillPlan();
    } else {
      const found = await this.#locate(cursor);
      if (found === null) {
        // The file the cursor pointed at is gone or was rewritten: start over, dedup absorbs the overlap.
        rotated = true;
        plan = await this.#backfillPlan();
      } else if (found.index === 0) {
        if (found.size < cursor.offset) {
          rotated = true; // truncated in place (copytruncate)
          plan = [{ path: this.#path, offset: 0, live: true }];
        } else {
          plan = [{ path: this.#path, offset: cursor.offset, live: true }];
        }
      } else {
        // Rotated since the last poll: finish the old file from our offset, then everything newer from 0.
        rotated = true;
        plan = [{ path: this.#rotatedPath(found.index), offset: cursor.offset, live: false }];
        for (let n = found.index - 1; n >= 1; n--) plan.push({ path: this.#rotatedPath(n), offset: 0, live: false });
        plan.push({ path: this.#path, offset: 0, live: true });
      }
    }

    const records: LogRecord[] = [];
    let last: LogCursor | null = cursor;
    let remaining = this.#maxBytes;
    let more = false;
    for (const source of plan) {
      if (remaining <= 0) {
        more = true;
        break;
      }
      const result = await this.#readSource(source, remaining);
      if (result === null) continue; // a rotated file vanished under us
      for (const record of result.records) records.push(record);
      remaining -= result.bytesRead;
      last = result.cursor;
      if (!result.finished) {
        more = true;
        break;
      }
    }
    return { records, cursor: last, rotated, more };
  }

  #rotatedPath(n: number): string {
    return `${this.#path}.${n}`;
  }

  #isOwnFile(file: string): boolean {
    return (
      file === this.#path || (file.startsWith(`${this.#path}.`) && /^\d+$/.test(file.slice(this.#path.length + 1)))
    );
  }

  /** Rotated files inside the backfill window, oldest first, then the live file (first run / unknown cursor). */
  async #backfillPlan(): Promise<Source[]> {
    const rotated: Source[] = [];
    if (this.#backfillMs > 0) {
      const cutoff = this.#now() - this.#backfillMs;
      for (let n = 1; n <= MAX_ROTATED_FILES; n++) {
        const path = this.#rotatedPath(n);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(path)).mtimeMs;
        } catch (err) {
          if (isNotFound(err)) break;
          throw err;
        }
        if (mtimeMs < cutoff) break; // higher numbers are older still
        rotated.push({ path, offset: 0, live: false });
      }
    }
    rotated.reverse();
    rotated.push({ path: this.#path, offset: 0, live: true });
    return rotated;
  }

  async #headOf(path: string): Promise<Head | null> {
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      const { size } = await fh.stat();
      return { size, head: await readHead(fh, size) };
    } finally {
      await fh.close();
    }
  }

  /** Finds the file the cursor belongs to among the live file and its rotated siblings, by head hash. */
  async #locate(cursor: LogCursor): Promise<{ index: number; size: number } | null> {
    for (let n = 0; n <= MAX_ROTATED_FILES; n++) {
      const info = await this.#headOf(n === 0 ? this.#path : this.#rotatedPath(n));
      if (info === null) {
        if (n === 0) continue;
        break;
      }
      // The stored hash covers min(256, offset) bytes, so it stays valid while a young file grows.
      const length = Math.min(HEAD_BYTES, cursor.offset);
      if (info.head.length >= length && sha1(info.head.subarray(0, length)) === cursor.headHash) {
        return { index: n, size: info.size };
      }
    }
    return null;
  }

  async #readSource(source: Source, budget: number): Promise<ReadResult | null> {
    let fh: FileHandle;
    try {
      fh = await open(source.path, 'r');
    } catch (err) {
      if (!source.live && isNotFound(err)) return null;
      throw err;
    }
    try {
      const { size } = await fh.stat();
      const head = await readHead(fh, size);
      const offset = Math.min(source.offset, size);
      const buf = await readExactly(fh, offset, Math.min(size - offset, budget));
      const atEof = offset + buf.length >= size;

      // Only whole lines are consumed. A rotated file never grows again, so its final partial line is complete.
      const lastNewline = buf.lastIndexOf(0x0a);
      let consumed = 0;
      let text = '';
      if (atEof && !source.live) {
        consumed = buf.length;
        text = buf.toString('utf8');
        if (consumed > 0 && buf[consumed - 1] !== 0x0a) text += '\n';
      } else if (lastNewline >= 0) {
        consumed = lastNewline + 1;
        text = buf.subarray(0, consumed).toString('utf8');
      } else if (!atEof && buf.length > 0) {
        // A single line longer than the whole cap: split it rather than stall forever.
        consumed = buf.length;
        text = `${buf.toString('utf8')}\n`;
      }

      const parsed = parseLogChunk(text);
      const records = parsed.records;
      const trailing = records[records.length - 1];
      let hold = false;
      if (source.live && trailing && (trailing.level === 'ERROR' || trailing.level === 'CRITICAL')) {
        const end = offset + consumed;
        const alreadyHeld = this.#held !== null && this.#held.path === source.path && this.#held.end === end;
        // Hold only if we make progress (record does not fill the whole chunk) or the file simply ends there.
        hold = !alreadyHeld && (parsed.lastRecordStart > 0 || atEof);
        this.#held = hold ? { path: source.path, end } : null;
        if (hold) {
          records.pop();
          consumed = Buffer.byteLength(text.slice(0, parsed.lastRecordStart), 'utf8');
        }
      } else if (source.live) {
        this.#held = null;
      }

      const newOffset = offset + consumed;
      return {
        records,
        cursor: {
          file: source.path,
          headHash: sha1(head.subarray(0, Math.min(HEAD_BYTES, newOffset))),
          offset: newOffset,
        },
        bytesRead: buf.length,
        finished: atEof,
      };
    } finally {
      await fh.close();
    }
  }
}
