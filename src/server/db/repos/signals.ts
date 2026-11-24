import 'server-only';
import type { BotId, Ms, Pair } from '@/shared/types/domain';
import { getDb } from '../client';

// Strategy signals recorded live (`signal_history`). Freqtrade's dataframe does not keep historical signals for
// every strategy (DcaBot sets `enter_long` only on the last row, docs/PLAN.md fact F9), so the poller records what
// it observes. The row key is the candle, so recording the same candle again is harmless.

export interface SignalRecord {
  botId: BotId;
  pair: Pair;
  timeframe: string;
  /** Open time of the candle the signal belongs to. */
  candleAt: Ms;
  enter: boolean;
  exit: boolean;
  enterTag: string | null;
  exitTag: string | null;
  firstSeenAt: Ms;
}

export interface ListSignalsOptions {
  botId?: BotId;
  pair?: Pair;
  timeframe?: string;
  /** Inclusive bounds on `candleAt`. */
  since?: Ms;
  until?: Ms;
}

interface SignalRow {
  bot_id: string;
  pair: string;
  timeframe: string;
  candle_at: number;
  enter: number;
  exit: number;
  enter_tag: string | null;
  exit_tag: string | null;
  first_seen_at: number;
}

/**
 * Records signals. A candle seen again keeps its original `firstSeenAt`; `enter`/`exit` are sticky (once a signal was
 * observed on a candle it stays, even if a later dataframe no longer shows it) and a tag fills in when the stored one
 * is empty. Callers should record only candles that carry a signal.
 */
export function upsertSignals(signals: readonly SignalRecord[]): void {
  if (signals.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO signal_history (bot_id, pair, timeframe, candle_at, enter, exit, enter_tag, exit_tag, first_seen_at)
     VALUES (@botId, @pair, @timeframe, @candleAt, @enter, @exit, @enterTag, @exitTag, @firstSeenAt)
     ON CONFLICT(bot_id, pair, timeframe, candle_at) DO UPDATE SET
       enter = MAX(signal_history.enter, excluded.enter),
       exit = MAX(signal_history.exit, excluded.exit),
       enter_tag = COALESCE(signal_history.enter_tag, excluded.enter_tag),
       exit_tag = COALESCE(signal_history.exit_tag, excluded.exit_tag),
       first_seen_at = MIN(signal_history.first_seen_at, excluded.first_seen_at)`,
  );
  db.transaction(() => {
    for (const signal of signals) {
      upsert.run({
        botId: signal.botId,
        pair: signal.pair,
        timeframe: signal.timeframe,
        candleAt: signal.candleAt,
        enter: signal.enter ? 1 : 0,
        exit: signal.exit ? 1 : 0,
        enterTag: signal.enterTag,
        exitTag: signal.exitTag,
        firstSeenAt: signal.firstSeenAt,
      });
    }
  })();
}

/** Recorded signals in candle order (oldest first). */
export function listSignals(options: ListSignalsOptions = {}): SignalRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.botId !== undefined) {
    where.push('bot_id = ?');
    params.push(options.botId);
  }
  if (options.pair !== undefined) {
    where.push('pair = ?');
    params.push(options.pair);
  }
  if (options.timeframe !== undefined) {
    where.push('timeframe = ?');
    params.push(options.timeframe);
  }
  if (options.since !== undefined) {
    where.push('candle_at >= ?');
    params.push(options.since);
  }
  if (options.until !== undefined) {
    where.push('candle_at <= ?');
    params.push(options.until);
  }
  const sql = `SELECT * FROM signal_history${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY candle_at, bot_id, pair, timeframe`;
  return (
    getDb()
      .prepare(sql)
      .all(...params) as SignalRow[]
  ).map((row) => ({
    botId: row.bot_id,
    pair: row.pair,
    timeframe: row.timeframe,
    candleAt: row.candle_at,
    enter: row.enter === 1,
    exit: row.exit === 1,
    enterTag: row.enter_tag,
    exitTag: row.exit_tag,
    firstSeenAt: row.first_seen_at,
  }));
}
