// Shared fixtures for the auth tests. Every value here is a made-up test value, never a real credential.
import { NextRequest } from 'next/server';
import { parseConfig, type AppConfig } from '@/server/config';
import { getDb, insertSession } from '@/server/db';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE } from './session';

/** The temporary password of the fixture accounts `admin` and `partner` (src/server/db/testing.ts). */
export { TEST_USER_PASSWORD as SEED_PASSWORD } from '@/server/db/testing';
export const TEST_SECRET = 'test-session-secret-0123456789-abcdefgh';
export const TEST_ORIGIN = 'http://dash.test:8043';
export const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    SESSION_SECRET: TEST_SECRET,
    APP_ORIGINS: 'http://alt.test:8043',
    FT_BOT_1_ID: 'votemax',
    FT_BOT_1_URL: 'http://freqtrade-votemax:8080',
    FT_BOT_1_USERNAME: 'test-bot-user',
    FT_BOT_1_PASSWORD: 'test-bot-password',
    ...overrides,
  });
}

export interface TokenOptions {
  /** Default 1 (the fixture `admin`). */
  uid?: number;
  /** When the session started, default NOW. */
  createdAt?: number;
  /** Idle expiry, default 30 days after createdAt. */
  expiresAt?: number;
  /** Absolute expiry, default 90 days after createdAt. */
  absoluteExpiresAt?: number;
  label?: string | null;
}

/**
 * Creates a session row in the current (test) database and returns its cookie token. Its last activity is `createdAt`.
 */
export function tokenFor(options: TokenOptions = {}): string {
  const createdAt = options.createdAt ?? NOW;
  const token = generateSessionToken();
  insertSession({
    tokenHash: hashSessionToken(token),
    userId: options.uid ?? 1,
    now: createdAt,
    expiresAt: options.expiresAt ?? createdAt + 30 * DAY,
    absoluteExpiresAt: options.absoluteExpiresAt ?? createdAt + 90 * DAY,
    label: options.label ?? null,
    ip: null,
  });
  return token;
}

/** A token of the right shape that belongs to no session (the proxy only checks the shape). */
export function wellFormedToken(): string {
  return generateSessionToken();
}

/** Marks the seeded users' passwords as permanent in the current database, so their sessions reach every route. */
export function activateSeededUsers(): void {
  getDb().prepare('UPDATE users SET must_change_password = 0').run();
}

export function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

type Init = ConstructorParameters<typeof NextRequest>[1];

export function request(path: string, init: Init & { headers?: Record<string, string> } = {}): NextRequest {
  // Plain concatenation (not `new URL(path, base)`), so a path like "//host/x" stays a path.
  return new NextRequest(path.startsWith('/') ? `${TEST_ORIGIN}${path}` : path, init);
}

/** Headers a same-origin browser fetch to a mutating route would send. */
export const JSON_SAME_ORIGIN = {
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  host: 'dash.test:8043',
} as const;
