import 'server-only';
import { getDb } from '../client';

// Key/value settings (`meta` table). Known keys (docs/PLAN.md section 5.1): schema_version (owned by the migrations,
// never write it here), kraken_nonce, kraken_backfill_complete, kraken_closed_cursor_sec, recon_start_at,
// bot:<id>:startup_at, bot:<id>:start_at, bot:<id>:max_closed_trades, last_vacuum_at.

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Numeric view of a meta value; null when missing or not a finite number. */
export function getMetaNumber(key: string): number | null {
  const raw = getMeta(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Numbers are stored as their decimal text. */
export function setMeta(key: string, value: string | number): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
