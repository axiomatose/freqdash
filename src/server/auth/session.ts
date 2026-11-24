import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { Ms } from '@/shared/types/domain';

// Session tokens and the session cookie (docs/PLAN.md section 3). Pure helpers, no database: the proxy uses them too.
//
//   fd_session = base64url(32 random bytes)
//
// The cookie is an opaque bearer token. The server keeps only its SHA-256 hash (`sessions.token_hash`), so a copy of
// the database does not let anyone sign in. Sessions are looked up, slid forward and ended in server/auth/sessions.ts.

export const SESSION_COOKIE = 'fd_session';
export const MAX_NAME_LENGTH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** What a route handler knows about the caller. */
export interface Session {
  /** Session row id, or null for the read-only automation token. */
  sid: number | null;
  /** User id, or null for the read-only automation token. */
  uid: number | null;
  /** Username (at most MAX_NAME_LENGTH characters); used for attribution (acks, silences, settings). */
  n: string | null;
  /** The password is temporary: only the change-password page and its API are usable. */
  pc: boolean;
  /** When the session ends if it stays idle (or at its absolute end, whichever comes first). */
  exp: Ms;
}

/** A fresh session token (256 bits). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** What the database stores for a token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** True for something that could be a token we issued (format only; says nothing about whether it is valid). */
export function isWellFormedToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function maxAgeMsFromDays(days: number): Ms {
  return days * DAY_MS;
}

// ---- cookies ---------------------------------------------------------------------------------------------------

/** Every `fd_session` value in a Cookie request header, in the order sent (well formed or not). */
export function sessionTokensFromCookieHeader(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return [];
  const tokens: string[] = [];
  for (const piece of cookieHeader.split(';')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    if (piece.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    tokens.push(piece.slice(eq + 1).trim());
  }
  return tokens;
}

function firstListValue(value: string | null): string {
  return (value?.split(',')[0] ?? '').trim().toLowerCase();
}

/**
 * Whether the session cookie gets the `Secure` flag: always for COOKIE_SECURE=true, never for false, and for `auto`
 * only when the request arrived over https (X-Forwarded-Proto set by the tunnel; the URL scheme when the header is
 * absent), so plain-http LAN access keeps working.
 */
export function isSecureRequest(headers: Headers, url: string, cookieSecure: 'auto' | boolean): boolean {
  if (cookieSecure !== 'auto') return cookieSecure;
  const forwarded = firstListValue(headers.get('x-forwarded-proto'));
  if (forwarded !== '') return forwarded === 'https';
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `Set-Cookie` value that installs the session cookie; the browser keeps it until the session's absolute end. */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const maxAgeSec = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
