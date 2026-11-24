import 'server-only';
import type { Asset, KrakenBalanceEntry, Ms } from '@/shared/types/domain';
import { getDb } from '../client';

// 5-minute account equity snapshots (`equity_snapshots`), kept forever (docs/PLAN.md section 5.1).

export const EQUITY_BUCKET_MS = 5 * 60 * 1000;

export interface EquitySnapshotInput {
  /** Floored to the 5-minute bucket by the repo; a second snapshot in the same bucket replaces the first. */
  at: Ms;
  source: 'kraken' | 'bot-wallet';
  totalUsd: number;
  usdCash: number;
  botPositionsUsd?: number | null;
  untrackedUsd?: number | null;
  holdings: readonly KrakenBalanceEntry[];
  unpricedAssets?: readonly Asset[];
}

/** A snapshot without its (large) holdings, which is all a chart needs. */
export interface EquityPoint {
  at: Ms;
  source: 'kraken' | 'bot-wallet';
  totalUsd: number;
  usdCash: number;
  botPositionsUsd: number | null;
  untrackedUsd: number | null;
}

interface EquityRow {
  at: number;
  source: string;
  total_usd: number;
  usd_cash: number;
  bot_positions_usd: number | null;
  untracked_usd: number | null;
}

const POINT_COLUMNS = 'at, source, total_usd, usd_cash, bot_positions_usd, untracked_usd';

function toPoint(row: EquityRow): EquityPoint {
  return {
    at: row.at,
    source: row.source as EquityPoint['source'],
    totalUsd: row.total_usd,
    usdCash: row.usd_cash,
    botPositionsUsd: row.bot_positions_usd,
    untrackedUsd: row.untracked_usd,
  };
}

export function floorToBucket(at: Ms): Ms {
  return Math.floor(at / EQUITY_BUCKET_MS) * EQUITY_BUCKET_MS;
}

export function insertEquitySnapshot(snapshot: EquitySnapshotInput): void {
  getDb()
    .prepare(
      `INSERT INTO equity_snapshots (at, source, total_usd, usd_cash, bot_positions_usd, untracked_usd, holdings_json, unpriced_json)
       VALUES (@at, @source, @totalUsd, @usdCash, @botPositionsUsd, @untrackedUsd, @holdingsJson, @unpricedJson)
       ON CONFLICT(at) DO UPDATE SET
         source = excluded.source, total_usd = excluded.total_usd, usd_cash = excluded.usd_cash,
         bot_positions_usd = excluded.bot_positions_usd, untracked_usd = excluded.untracked_usd,
         holdings_json = excluded.holdings_json, unpriced_json = excluded.unpriced_json`,
    )
    .run({
      at: floorToBucket(snapshot.at),
      source: snapshot.source,
      totalUsd: snapshot.totalUsd,
      usdCash: snapshot.usdCash,
      botPositionsUsd: snapshot.botPositionsUsd ?? null,
      untrackedUsd: snapshot.untrackedUsd ?? null,
      holdingsJson: JSON.stringify(snapshot.holdings),
      unpricedJson: JSON.stringify(snapshot.unpricedAssets ?? []),
    });
}

/**
 * Snapshots with `at >= since`, oldest first, downsampled to at most `maxPoints`.
 *
 * Downsampling keeps the first snapshot and, for the rest of the range split into `maxPoints - 1` equal time
 * buckets, the LAST snapshot of every non-empty bucket, so the newest point is always present and the line keeps
 * its true shape. Fewer than `maxPoints` rows are returned untouched.
 */
export function listEquity(since: Ms, maxPoints: number): EquityPoint[] {
  const limit = Math.floor(maxPoints);
  if (!(limit >= 1)) return [];
  const db = getDb();
  const range = db
    .prepare('SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM equity_snapshots WHERE at >= ?')
    .get(since) as { n: number; first: number | null; last: number | null };
  if (range.n === 0 || range.first === null || range.last === null) return [];

  if (range.n <= limit) {
    const rows = db
      .prepare(`SELECT ${POINT_COLUMNS} FROM equity_snapshots WHERE at >= ? ORDER BY at`)
      .all(since) as EquityRow[];
    return rows.map(toPoint);
  }
  if (limit === 1) {
    const row = db.prepare(`SELECT ${POINT_COLUMNS} FROM equity_snapshots WHERE at = ?`).get(range.last) as EquityRow;
    return [toPoint(row)];
  }

  // CAST: better-sqlite3 binds large JS numbers as REAL, which would turn the integer bucket division into a
  // fractional one.
  const rows = db
    .prepare(
      `SELECT ${POINT_COLUMNS} FROM equity_snapshots
       WHERE at = @first OR at IN (
         SELECT MAX(at) FROM equity_snapshots WHERE at > @first
         GROUP BY CAST(((at - @first) * @buckets) / (@span + 1) AS INTEGER)
       )
       ORDER BY at`,
    )
    .all({ first: range.first, buckets: limit - 1, span: range.last - range.first }) as EquityRow[];
  return rows.map(toPoint);
}
