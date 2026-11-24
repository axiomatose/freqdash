import 'server-only';
import type { BotEvent, BotEventType, BotId, Ms } from '@/shared/types/domain';
import { clipText, getDb, placeholders } from '../client';

// Bot events parsed from log files / health diffs (`bot_events`). Idempotent by `fingerprint`, so re-reading a log
// window (after a restart, a rotation, or the LOG_BACKFILL_HOURS backfill) never duplicates rows.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Event types the reconciliation checks look 30 days back for, so they are kept for a year. */
export const LONG_RETAINED_EVENT_TYPES: readonly BotEventType[] = ['order_created', 'order_canceled'];
export const LONG_EVENT_RETENTION_MS = 365 * DAY_MS;
export const SHORT_EVENT_RETENTION_MS = 90 * DAY_MS;

interface BotEventRow {
  bot_id: string;
  at: number;
  type: string;
  source: string;
  order_id: string | null;
  pair: string | null;
  price: number | null;
  stake_usd: number | null;
  message: string | null;
  fingerprint: string;
}

/**
 * Inserts events, skipping any whose fingerprint already exists. Returns the number of NEW rows.
 * `message` is free text: the CALLER must pass it through `redactSecrets` (server/log.ts) first. Clipped to
 * MAX_TEXT_LENGTH.
 */
export function insertEvents(events: readonly BotEvent[]): number {
  if (events.length === 0) return 0;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO bot_events (bot_id, at, type, source, order_id, pair, price, stake_usd, message, fingerprint)
     VALUES (@botId, @at, @type, @source, @orderId, @pair, @price, @stakeUsd, @message, @fingerprint)
     ON CONFLICT(fingerprint) DO NOTHING`,
  );
  return db.transaction((): number => {
    let inserted = 0;
    for (const event of events) {
      inserted += insert.run({
        botId: event.botId,
        at: event.at,
        type: event.type,
        source: event.source,
        orderId: event.orderId ?? null,
        pair: event.pair ?? null,
        price: event.price ?? null,
        stakeUsd: event.stakeUsd ?? null,
        message: clipText(event.message),
        fingerprint: event.fingerprint,
      }).changes;
    }
    return inserted;
  })();
}

export interface ListEventsOptions {
  botId?: BotId;
  /** Inclusive lower bound on `at`. */
  since?: Ms;
  /** Empty array matches nothing; omit for all types. */
  types?: readonly BotEventType[];
  limit?: number;
  /** Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
}

function toEvent(row: BotEventRow): BotEvent {
  const event: BotEvent = {
    botId: row.bot_id,
    at: row.at,
    type: row.type as BotEventType,
    source: row.source as BotEvent['source'],
    fingerprint: row.fingerprint,
  };
  if (row.order_id !== null) event.orderId = row.order_id;
  if (row.pair !== null) event.pair = row.pair;
  if (row.price !== null) event.price = row.price;
  if (row.stake_usd !== null) event.stakeUsd = row.stake_usd;
  if (row.message !== null) event.message = row.message;
  return event;
}

export function listEvents(options: ListEventsOptions = {}): BotEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.botId !== undefined) {
    where.push('bot_id = ?');
    params.push(options.botId);
  }
  if (options.since !== undefined) {
    where.push('at >= ?');
    params.push(options.since);
  }
  if (options.types !== undefined) {
    if (options.types.length === 0) return [];
    where.push(`type IN (${placeholders(options.types.length)})`);
    params.push(...options.types);
  }
  const direction = options.order === 'asc' ? 'ASC' : 'DESC';
  let sql = `SELECT * FROM bot_events${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ${direction}, id ${direction}`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(options.limit)));
  }
  return (
    getDb()
      .prepare(sql)
      .all(...params) as BotEventRow[]
  ).map(toEvent);
}

/** Retention: order_created/order_canceled 365 days, every other type 90 days. Returns the rows deleted. */
export function pruneBotEvents(now: Ms): number {
  const long = LONG_RETAINED_EVENT_TYPES;
  return getDb()
    .prepare(
      `DELETE FROM bot_events WHERE
         (type IN (${placeholders(long.length)}) AND at < ?) OR (type NOT IN (${placeholders(long.length)}) AND at < ?)`,
    )
    .run(...long, now - LONG_EVENT_RETENTION_MS, ...long, now - SHORT_EVENT_RETENTION_MS).changes;
}
