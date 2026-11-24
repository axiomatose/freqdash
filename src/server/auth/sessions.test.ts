import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, listUserSessions, pruneSessions } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { hashSessionToken } from './session';
import {
  ABSOLUTE_MIN_MS,
  endSessionByToken,
  endUserSessions,
  resolveSession,
  sessionPolicy,
  startSession,
  TOUCH_EVERY_MS,
} from './sessions';
import { activateSeededUsers, DAY, NOW } from './test-support';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const admin = { id: 1, username: 'admin', mustChangePassword: false };
const policy = sessionPolicy(30);
let temp: TempDb;

beforeEach(() => {
  temp = installTempDb();
  activateSeededUsers();
});
afterEach(() => temp.cleanup());

describe('sessionPolicy', () => {
  it('slides on SESSION_MAX_AGE_DAYS and ends after 90 days at most (or the idle timeout if longer)', () => {
    expect(policy).toEqual({ idleMs: 30 * DAY, absoluteMs: 90 * DAY });
    expect(sessionPolicy(365)).toEqual({ idleMs: 365 * DAY, absoluteMs: 365 * DAY });
    expect(ABSOLUTE_MIN_MS).toBe(90 * DAY);
  });
});

describe('startSession', () => {
  it('stores only the hash of the token, with a device label and the address', () => {
    const started = startSession(admin, { userAgent: IPHONE, ip: '203.0.113.9' }, NOW, policy);
    expect(started.token).toMatch(/^[\w-]{43}$/);
    expect(started.cookieMaxAgeMs).toBe(90 * DAY);
    expect(started.session).toEqual({ sid: expect.any(Number), uid: 1, n: 'admin', pc: false, exp: NOW + 30 * DAY });
    const row = getDb().prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(row.token_hash).toBe(hashSessionToken(started.token));
    expect(JSON.stringify(row)).not.toContain(started.token);
    expect(row).toMatchObject({ label: 'iPhone · Safari', ip: '203.0.113.9', absolute_expires_at: NOW + 90 * DAY });
  });

  it('does not store the placeholder address', () => {
    startSession(admin, { userAgent: null, ip: 'unknown' }, NOW, policy);
    expect(listUserSessions(1, NOW)[0]).toMatchObject({ ip: null, label: 'Device · Browser' });
  });
});

describe('resolveSession', () => {
  it('finds a live session and carries the user state', () => {
    const { token } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    expect(resolveSession(token, NOW + 1000, policy)).toMatchObject({ uid: 1, n: 'admin', pc: false });
    getDb().prepare('UPDATE users SET must_change_password = 1 WHERE id = 1').run();
    expect(resolveSession(token, NOW + 2000, policy)?.pc).toBe(true);
  });

  it('refuses malformed, unknown and disabled-user tokens', () => {
    const { token } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    expect(resolveSession('garbage', NOW, policy)).toBeNull();
    expect(resolveSession('x'.repeat(43), NOW, policy)).toBeNull();
    getDb().prepare('UPDATE users SET disabled = 1 WHERE id = 1').run();
    expect(resolveSession(token, NOW, policy)).toBeNull();
  });

  it('slides the idle expiry, writing at most every 5 minutes', () => {
    const { token, session } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    const lastSeen = () =>
      (getDb().prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(session.sid) as { last_seen_at: number })
        .last_seen_at;
    resolveSession(token, NOW + TOUCH_EVERY_MS - 1, policy);
    expect(lastSeen()).toBe(NOW);
    const later = NOW + TOUCH_EVERY_MS;
    expect(resolveSession(token, later, policy)?.exp).toBe(later + 30 * DAY);
    expect(lastSeen()).toBe(later);
  });

  it('ends after the idle timeout without use', () => {
    const { token } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    expect(resolveSession(token, NOW + 30 * DAY - 1, policy)).not.toBeNull();
    const { token: idle } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    expect(resolveSession(idle, NOW + 30 * DAY, policy)).toBeNull();
  });

  it('ends at the absolute lifetime however active it is', () => {
    const { token } = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    for (let t = NOW; t < NOW + 90 * DAY; t += 10 * DAY) expect(resolveSession(token, t, policy)).not.toBeNull();
    expect(resolveSession(token, NOW + 89 * DAY, policy)?.exp).toBe(NOW + 90 * DAY);
    expect(resolveSession(token, NOW + 90 * DAY, policy)).toBeNull();
  });
});

describe('ending sessions', () => {
  it('signs out one token, all of a user except one, or all', () => {
    const a = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    const b = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    const c = startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    const partner = startSession(
      { id: 2, username: 'partner', mustChangePassword: false },
      { userAgent: null, ip: null },
      NOW,
      policy,
    );

    endSessionByToken(a.token, NOW);
    expect(resolveSession(a.token, NOW, policy)).toBeNull();
    expect(endUserSessions(1, c.session.sid)).toBe(1);
    expect(resolveSession(b.token, NOW, policy)).toBeNull();
    expect(resolveSession(c.token, NOW, policy)).not.toBeNull();
    expect(endUserSessions(1)).toBe(1);
    expect(resolveSession(partner.token, NOW, policy)).not.toBeNull();
  });

  it('prunes expired sessions and lists only live ones', () => {
    startSession(admin, { userAgent: null, ip: null }, NOW, policy);
    startSession(admin, { userAgent: null, ip: null }, NOW - 31 * DAY, policy);
    expect(listUserSessions(1, NOW)).toHaveLength(1);
    expect(pruneSessions(NOW)).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});
