import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { clipText, getDb } from '../client';

// Server-side sessions (`sessions`). Tokens are hashed by the caller (server/auth/sessions.ts); this repo never sees
// a raw token.

export interface SessionRecord {
  id: number;
  userId: number;
  createdAt: Ms;
  lastSeenAt: Ms;
  /** Idle expiry; slides forward while the session is used. */
  expiresAt: Ms;
  /** Hard end, however active the session is. */
  absoluteExpiresAt: Ms;
  label: string | null;
  ip: string | null;
}

/** A session together with the fields of its user that every request needs. */
export interface SessionWithUser extends SessionRecord {
  username: string;
  mustChangePassword: boolean;
  disabled: boolean;
}

interface Row {
  id: number;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number;
  label: string | null;
  ip: string | null;
}

interface JoinedRow extends Row {
  username: string;
  must_change_password: number;
  disabled: number;
}

const toRecord = (r: Row): SessionRecord => ({
  id: r.id,
  userId: r.user_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  absoluteExpiresAt: r.absolute_expires_at,
  label: r.label,
  ip: r.ip,
});

export interface NewSession {
  tokenHash: string;
  userId: number;
  now: Ms;
  expiresAt: Ms;
  absoluteExpiresAt: Ms;
  label: string | null;
  ip: string | null;
}

export function insertSession(s: NewSession): SessionRecord {
  const row = getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, label, ip)
       VALUES (@tokenHash, @userId, @now, @now, @expiresAt, @absoluteExpiresAt, @label, @ip) RETURNING *`,
    )
    .get({ ...s, label: clipText(s.label, 80), ip: clipText(s.ip, 64) }) as Row;
  return toRecord(row);
}

/** The session with this token hash and its user, if it has not expired at `now` (expired rows are left to prune). */
export function findSessionByTokenHash(tokenHash: string, now: Ms): SessionWithUser | null {
  const row = getDb()
    .prepare(
      `SELECT s.*, u.username, u.must_change_password, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ?`,
    )
    .get(tokenHash, now, now) as JoinedRow | undefined;
  if (row === undefined) return null;
  return {
    ...toRecord(row),
    username: row.username,
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled === 1,
  };
}

/** Records activity: last seen now, idle expiry pushed to `expiresAt`. */
export function touchSession(id: number, now: Ms, expiresAt: Ms): void {
  getDb().prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, id);
}

/** The user's live sessions, most recently used first. */
export function listUserSessions(userId: number, now: Ms): SessionRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND absolute_expires_at > ?
         ORDER BY last_seen_at DESC, id DESC`,
      )
      .all(userId, now, now) as Row[]
  ).map(toRecord);
}

/** With `userId`, only that user's session is deleted. */
export function deleteSession(id: number, userId?: number): boolean {
  const db = getDb();
  return userId === undefined
    ? db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0
    : db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** Deletes every session of the user, except `keepId` when given. Returns how many were deleted. */
export function deleteUserSessions(userId: number, keepId?: number): number {
  const db = getDb();
  return keepId === undefined
    ? db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes
    : db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepId).changes;
}

/** Retention: expired sessions are useless; delete them. */
export function pruneSessions(now: Ms): number {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at <= ? OR absolute_expires_at <= ?').run(now, now)
    .changes;
}
