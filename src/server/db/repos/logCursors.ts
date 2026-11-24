import 'server-only';
import type { BotId, Ms } from '@/shared/types/domain';
import { getDb } from '../client';

// Where the log tailer stopped reading each bot's file (`log_cursors`). `headHash` fingerprints the first bytes of
// the file so a rotation (same path, new content) is detected and the offset is not applied to the wrong file.

export interface LogCursor {
  botId: BotId;
  file: string;
  headHash: string;
  /** Byte offset of the next unread byte. */
  offset: number;
  updatedAt: Ms;
}

interface LogCursorRow {
  bot_id: string;
  file: string;
  head_hash: string;
  offset: number;
  updated_at: number;
}

export function getCursor(botId: BotId): LogCursor | null {
  const row = getDb().prepare('SELECT * FROM log_cursors WHERE bot_id = ?').get(botId) as LogCursorRow | undefined;
  if (row === undefined) return null;
  return { botId: row.bot_id, file: row.file, headHash: row.head_hash, offset: row.offset, updatedAt: row.updated_at };
}

/** Upserts the cursor of one bot; `now` becomes `updatedAt`. */
export function saveCursor(cursor: Omit<LogCursor, 'updatedAt'>, now: Ms): void {
  getDb()
    .prepare(
      `INSERT INTO log_cursors (bot_id, file, head_hash, offset, updated_at)
       VALUES (@botId, @file, @headHash, @offset, @now)
       ON CONFLICT(bot_id) DO UPDATE SET
         file = excluded.file, head_hash = excluded.head_hash, offset = excluded.offset, updated_at = excluded.updated_at`,
    )
    .run({ botId: cursor.botId, file: cursor.file, headHash: cursor.headHash, offset: cursor.offset, now });
}
