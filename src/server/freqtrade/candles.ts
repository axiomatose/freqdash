import type { Candle, Ms, Pair } from '@/shared/types/domain';
import { ftPairCandlesSchema } from './schemas';
import { secondsToMs } from './normalize';

// `/pair_candles` (F7): up to ~719 analyzed rows, the last row is the last CLOSED candle, NaN arrives as null,
// `enter_long` is null / 0 / 1.0 and helper columns such as `at_support` are real booleans.

export interface PairCandles {
  strategy: string | null;
  pair: Pair | null;
  timeframe: string | null;
  timeframeMs: number | null;
  /** Column names in `data` order, including the helper columns (`__date_ts`, `_enter_long_signal_close`, ...). */
  columns: string[];
  /** One object per data row keyed by column name; values are passed through untouched (booleans, nulls, strings). */
  rows: Record<string, unknown>[];
  /** UTC seconds (open time), rows without a usable time or a finite OHLC are dropped. Ascending. */
  candles: Candle[];
  /** SECONDS in the API (F4), ms here. */
  lastAnalyzedAt: Ms | null;
  dataStartAt: Ms | null;
  dataStopAt: Ms | null;
}

export interface CandleSignal {
  /** UTC seconds, same clock as Candle.time. */
  time: number;
  enter: boolean;
  exit: boolean;
  enterTag: string | null;
  exitTag: string | null;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Candle open time in UTC seconds. `__date_ts` (ms) is authoritative; only an ISO date that carries an explicit zone is
 * accepted as a fallback. Zone-less freqtrade date strings are never parsed.
 */
function rowTimeSeconds(row: Record<string, unknown>): number | null {
  const ts = finite(row.__date_ts);
  if (ts !== null && ts > 0) return Math.floor(ts / 1000);
  const date = row.date;
  if (typeof date === 'string' && ISO_WITH_ZONE.test(date)) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

export function parsePairCandles(raw: unknown): PairCandles {
  const p = ftPairCandlesSchema.parse(raw);
  const rows: Record<string, unknown>[] = p.data.map((values) => {
    const row: Record<string, unknown> = {};
    p.columns.forEach((name, i) => {
      row[name] = values[i] ?? null;
    });
    return row;
  });

  const candles: Candle[] = [];
  for (const row of rows) {
    const time = rowTimeSeconds(row);
    const open = finite(row.open);
    const high = finite(row.high);
    const low = finite(row.low);
    const close = finite(row.close);
    if (time === null || open === null || high === null || low === null || close === null) continue;
    candles.push({ time, open, high, low, close, volume: finite(row.volume) ?? 0 });
  }
  if (candles.some((c, i) => i > 0 && c.time < (candles[i - 1] as Candle).time))
    candles.sort((a, b) => a.time - b.time);

  const dataStart = finite(p.data_start_ts);
  const dataStop = finite(p.data_stop_ts);
  return {
    strategy: p.strategy ?? null,
    pair: p.pair ?? null,
    timeframe: p.timeframe ?? null,
    timeframeMs: finite(p.timeframe_ms),
    columns: p.columns,
    rows,
    candles,
    lastAnalyzedAt: secondsToMs(p.last_analyzed_ts),
    dataStartAt: dataStart !== null && dataStart > 0 ? dataStart : null,
    dataStopAt: dataStop !== null && dataStop > 0 ? dataStop : null,
  };
}

/** `enter_long` / `exit_long` arrive as null, 0, 1.0 or (other strategies) true. */
export function isSignalOn(v: unknown): boolean {
  return v === true || (typeof v === 'number' && Number.isFinite(v) && v > 0);
}

function tagOf(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Long-side signals per row (spot bots only), in row order. Rows without a usable time are skipped. */
export function candleSignals(rows: readonly Record<string, unknown>[]): CandleSignal[] {
  const out: CandleSignal[] = [];
  for (const row of rows) {
    const time = rowTimeSeconds(row);
    if (time === null) continue;
    out.push({
      time,
      enter: isSignalOn(row.enter_long),
      exit: isSignalOn(row.exit_long),
      enterTag: tagOf(row.enter_tag),
      exitTag: tagOf(row.exit_tag),
    });
  }
  return out;
}
