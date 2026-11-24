import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { deviceLabel } from '@/shared/device';
import { deleteSession, deleteUserSessions, findSessionByTokenHash, insertSession, touchSession } from '../db';
import { generateSessionToken, hashSessionToken, isWellFormedToken, maxAgeMsFromDays, type Session } from './session';

// Server-side sessions: creation at sign-in, lookup on every request, sliding idle expiry, and ending them.
//
//  * idle timeout = SESSION_MAX_AGE_DAYS (default 30): every use pushes the end forward;
//  * absolute lifetime = 90 days (or the idle timeout if longer): the session ends then however active it is;
//  * activity is written at most every 5 minutes per session, so reads do not turn into writes.

export const ABSOLUTE_MIN_MS = 90 * 24 * 60 * 60 * 1000;
export const TOUCH_EVERY_MS = 5 * 60_000;

export interface SessionPolicy {
  idleMs: Ms;
  absoluteMs: Ms;
}

export function sessionPolicy(sessionMaxAgeDays: number): SessionPolicy {
  const idleMs = maxAgeMsFromDays(sessionMaxAgeDays);
  return { idleMs, absoluteMs: Math.max(ABSOLUTE_MIN_MS, idleMs) };
}

export interface StartedSession {
  /** The raw token for the cookie. Never stored or logged. */
  token: string;
  session: Session;
  /** Cookie lifetime: until the absolute end. */
  cookieMaxAgeMs: Ms;
}

export interface SessionMeta {
  userAgent: string | null;
  ip: string | null;
}

export function startSession(
  user: { id: number; username: string; mustChangePassword: boolean },
  meta: SessionMeta,
  now: Ms,
  policy: SessionPolicy,
): StartedSession {
  const token = generateSessionToken();
  const absoluteExpiresAt = now + policy.absoluteMs;
  const record = insertSession({
    tokenHash: hashSessionToken(token),
    userId: user.id,
    now,
    expiresAt: Math.min(absoluteExpiresAt, now + policy.idleMs),
    absoluteExpiresAt,
    label: deviceLabel(meta.userAgent),
    ip: meta.ip === 'unknown' ? null : meta.ip,
  });
  return {
    token,
    session: {
      sid: record.id,
      uid: user.id,
      n: user.username,
      pc: user.mustChangePassword,
      exp: record.expiresAt,
    },
    cookieMaxAgeMs: policy.absoluteMs,
  };
}

/**
 * The live session for a cookie token, or null (malformed, unknown, expired, or its user is disabled). Slides the
 * idle expiry forward when the last recorded activity is older than TOUCH_EVERY_MS.
 */
export function resolveSession(token: string | null | undefined, now: Ms, policy: SessionPolicy): Session | null {
  if (!isWellFormedToken(token)) return null;
  const found = findSessionByTokenHash(hashSessionToken(token), now);
  if (found === null || found.disabled) return null;
  let expiresAt = found.expiresAt;
  if (now - found.lastSeenAt >= TOUCH_EVERY_MS) {
    expiresAt = Math.min(found.absoluteExpiresAt, now + policy.idleMs);
    touchSession(found.id, now, expiresAt);
  }
  return { sid: found.id, uid: found.userId, n: found.username, pc: found.mustChangePassword, exp: expiresAt };
}

/** Ends the session a cookie token belongs to (sign-out). */
export function endSessionByToken(token: string | null | undefined, now: Ms): void {
  if (!isWellFormedToken(token)) return;
  const found = findSessionByTokenHash(hashSessionToken(token), now);
  if (found !== null) deleteSession(found.id);
}

/** Ends every session of the user, except `keepSid`. Returns how many ended. */
export function endUserSessions(userId: number, keepSid?: number | null): number {
  return deleteUserSessions(userId, keepSid ?? undefined);
}
