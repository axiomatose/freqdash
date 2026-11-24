import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { getDb } from '../client';

// Raw `settings` rows. Encryption and validation live in server/settings; this repo stores what it is given.

export interface SettingRow {
  key: string;
  value: string;
  secret: boolean;
  updatedAt: Ms;
  updatedBy: string | null;
}

interface Row {
  key: string;
  value: string;
  secret: number;
  updated_at: number;
  updated_by: string | null;
}

const toRow = (r: Row): SettingRow => ({
  key: r.key,
  value: r.value,
  secret: r.secret === 1,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

export function listSettingRows(): SettingRow[] {
  return (getDb().prepare('SELECT * FROM settings ORDER BY key').all() as Row[]).map(toRow);
}

export function getSettingRow(key: string): SettingRow | null {
  const row = getDb().prepare('SELECT * FROM settings WHERE key = ?').get(key) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

export function putSettingRow(row: { key: string; value: string; secret: boolean; by: string | null }, now: Ms): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, secret, updated_at, updated_by) VALUES (@key, @value, @secret, @now, @by)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run({ key: row.key, value: row.value, secret: row.secret ? 1 : 0, now, by: row.by });
}

export function deleteSettingRow(key: string): boolean {
  return getDb().prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
}
