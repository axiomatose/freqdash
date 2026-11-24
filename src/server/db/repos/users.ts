import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { getDb } from '../client';

// User accounts (`users`). Password hashing lives in server/auth/password; this repo stores what it is given.

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: Ms;
  passwordChangedAt: Ms | null;
  lastLoginAt: Ms | null;
}

interface Row {
  id: number;
  username: string;
  password_hash: string;
  must_change_password: number;
  disabled: number;
  created_at: number;
  password_changed_at: number | null;
  last_login_at: number | null;
}

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  username: r.username,
  passwordHash: r.password_hash,
  mustChangePassword: r.must_change_password === 1,
  disabled: r.disabled === 1,
  createdAt: r.created_at,
  passwordChangedAt: r.password_changed_at,
  lastLoginAt: r.last_login_at,
});

export function getUserById(id: number): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
  return row === undefined ? null : toUser(row);
}

/** Case-insensitive (the column is COLLATE NOCASE). */
export function getUserByUsername(username: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined;
  return row === undefined ? null : toUser(row);
}

export function listUsers(): UserRecord[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY id').all() as Row[]).map(toUser);
}

export function recordLogin(id: number, now: Ms): void {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
}

/**
 * Stores a new password hash; `mustChange` marks it temporary. Returns the updated user, or null when it does not
 * exist. Ending the user's sessions is the caller's decision (server/auth/sessions.ts).
 */
export function setUserPassword(id: number, passwordHash: string, mustChange: boolean, now: Ms): UserRecord | null {
  const changed = getDb()
    .prepare(
      `UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, updated_at = ?
         WHERE id = ?`,
    )
    .run(passwordHash, mustChange ? 1 : 0, now, now, id).changes;
  return changed === 0 ? null : getUserById(id);
}

/** Creates an account. `mustChange` marks the password temporary. Throws if the name is taken (case-insensitive). */
export function createUser(username: string, passwordHash: string, mustChange: boolean, now: Ms): UserRecord {
  const { lastInsertRowid } = getDb()
    .prepare(
      `INSERT INTO users (username, password_hash, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    )
    .run(username, passwordHash, mustChange ? 1 : 0, now, now);
  const user = getUserById(Number(lastInsertRowid));
  if (user === null) throw new Error('created user not found');
  return user;
}
