import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { ftLogsSchema } from '../freqtrade/schemas';
import { redactSecrets } from '../log';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface LogRecord {
  /** Epoch ms parsed from the UTC log timestamp. Records are NOT guaranteed to be time ordered (F11 / Addendum). */
  at: Ms;
  logger: string;
  level: LogLevel;
  /** First line of the message, already passed through redactSecrets. */
  message: string;
  /** Continuation lines (traceback, multi-line messages), redacted. */
  continuation: string[];
}

/** Freqtrade log line: `YYYY-MM-DD HH:MM:SS,mmm - logger - LEVEL - message`, UTC (docs/PLAN.md F11 / 6.2). */
export const LOG_LINE_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) - (\S+) - (DEBUG|INFO|WARNING|ERROR|CRITICAL) - (.*)$/;

const LEVELS: ReadonlySet<string> = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

export interface ParsedChunk {
  records: LogRecord[];
  /** Partial trailing line (no newline yet); pass it back as `carry` with the next chunk. */
  carry: string;
  /**
   * Index in `carry + text` where the last record's header line starts, or -1 when the chunk holds no header line.
   * That record may still receive continuation lines in the next chunk.
   */
  lastRecordStart: number;
}

/**
 * Parses complete lines of `carry + text` into records. Lines that do not match the header pattern are continuation
 * lines of the previous record (dropped when no record precedes them, i.e. the chunk started mid-traceback).
 * Every stored string goes through redactSecrets, DEBUG records included.
 */
export function parseLogChunk(text: string, carry = ''): ParsedChunk {
  const combined = carry + text;
  const lastNewline = combined.lastIndexOf('\n');
  const rest = combined.slice(lastNewline + 1);
  const records: LogRecord[] = [];
  let current: LogRecord | null = null;
  let lastRecordStart = -1;

  let pos = 0;
  while (pos <= lastNewline) {
    const end = combined.indexOf('\n', pos);
    let line = combined.slice(pos, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const m = LOG_LINE_RE.exec(line);
    if (m) {
      current = {
        at: Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6]),
          Number(m[7]),
        ),
        logger: m[8] as string,
        level: m[9] as LogLevel,
        message: redactSecrets(m[10] as string),
        continuation: [],
      };
      records.push(current);
      lastRecordStart = pos;
    } else if (current) {
      current.continuation.push(redactSecrets(line));
    }
    pos = end + 1;
  }
  return { records, carry: rest, lastRecordStart };
}

/**
 * Records from freqtrade's `/logs` buffer (fallback source, F10). Rows are `[asctime, created_ms, logger, level, message]`;
 * the message may carry the traceback after a newline. `created_ms` is a float (epoch ms), the asctime is never read.
 * Malformed rows are skipped; the function does not throw.
 */
export function parseApiLogs(raw: unknown): LogRecord[] {
  const parsed = ftLogsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const records: LogRecord[] = [];
  for (const row of parsed.data.logs) {
    const [, createdMs, logger, level, message] = row;
    if (typeof createdMs !== 'number' || !Number.isFinite(createdMs) || createdMs <= 0) continue;
    if (typeof logger !== 'string' || typeof level !== 'string' || !LEVELS.has(level)) continue;
    const [first = '', ...rest] = (typeof message === 'string' ? message : '').split('\n');
    records.push({
      at: Math.floor(createdMs),
      logger,
      level: level as LogLevel,
      message: redactSecrets(first.replace(/\r$/, '')),
      continuation: rest.map((l) => redactSecrets(l.replace(/\r$/, ''))),
    });
  }
  return records;
}
