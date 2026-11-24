import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { getDb, getUserById } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { verifyPassword } from '@/server/auth/password';
import { configureLoginRuntimeForTests, LoginRateLimiter } from '@/server/auth/ratelimit';
import { sessionFromCookieHeader } from '@/server/auth/guard';
import {
  cookieHeader,
  JSON_SAME_ORIGIN,
  NOW,
  request,
  SEED_PASSWORD,
  testConfig,
  tokenFor,
} from '@/server/auth/test-support';
import { POST } from './route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const NEW = 'orange river lantern 42';
const ctx = { params: Promise.resolve({}) };
let temp: TempDb;

function change(body: unknown, token = tokenFor({ uid: 2 })): Promise<Response> {
  return POST(
    request('/api/auth/password', {
      method: 'POST',
      headers: { ...JSON_SAME_ORIGIN, cookie: cookieHeader(token) },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

beforeEach(() => {
  state.cfg = testConfig();
  temp = installTempDb();
  configureLoginRuntimeForTests({ limiter: new LoginRateLimiter(), sleep: () => Promise.resolve() });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureLoginRuntimeForTests(null);
  clearRegisteredSecrets();
  temp.cleanup();
});

describe('POST /api/auth/password', () => {
  it('replaces a temporary password, ends every session of the user and starts a fresh one here', async () => {
    const current = tokenFor({ uid: 2 });
    const otherDevice = tokenFor({ uid: 2 });
    const admins = tokenFor({ uid: 1 });
    const res = await change({ currentPassword: SEED_PASSWORD, newPassword: NEW }, current);
    expect(res.status).toBe(204);
    const partner = getUserById(2)!;
    expect(partner.mustChangePassword).toBe(false);
    expect(await verifyPassword(NEW, partner.passwordHash)).toBe(true);

    const token = /fd_session=([^;]+)/.exec(res.headers.getSetCookie()[0]!)![1]!;
    expect(token).not.toBe(current);
    expect(sessionFromCookieHeader(cookieHeader(token), NOW)).toMatchObject({ uid: 2, n: 'partner', pc: false });
    expect(sessionFromCookieHeader(cookieHeader(current), NOW)).toBeNull();
    expect(sessionFromCookieHeader(cookieHeader(otherDevice), NOW)).toBeNull();
    expect(sessionFromCookieHeader(cookieHeader(admins), NOW)).not.toBeNull();

    // The old cookie no longer works.
    expect((await change({ currentPassword: NEW, newPassword: 'another long password' }, current)).status).toBe(401);
  });

  it('requires the current password, under the login rate limiter', async () => {
    const wrong = await change({ currentPassword: 'not-the-password', newPassword: NEW });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ message: 'The current password is not correct.' });
    for (let i = 0; i < 4; i += 1) await change({ currentPassword: 'not-the-password', newPassword: NEW });
    expect((await change({ currentPassword: SEED_PASSWORD, newPassword: NEW })).status).toBe(429);
    expect(getUserById(2)?.mustChangePassword).toBe(true);
  });

  it.each([
    ['too short', 'short-one', /at least 12/],
    ['the same as the current one', SEED_PASSWORD, /different/],
    ['containing the username', 'partner-is-the-best-2026', /username/],
  ])('refuses a new password that is %s', async (_label, newPassword, message) => {
    const res = await change({ currentPassword: SEED_PASSWORD, newPassword });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(message);
    expect(getUserById(2)?.mustChangePassword).toBe(true);
  });

  it('works for a permanent password too, and needs a session, JSON and the same origin', async () => {
    getDb().prepare('UPDATE users SET must_change_password = 0').run();
    expect((await change({ currentPassword: SEED_PASSWORD, newPassword: NEW }, tokenFor())).status).toBe(204);
    const anonymous = await POST(
      request('/api/auth/password', { method: 'POST', headers: JSON_SAME_ORIGIN, body: '{}' }),
      ctx,
    );
    expect(anonymous.status).toBe(401);
    const cross = await POST(
      request('/api/auth/password', {
        method: 'POST',
        headers: {
          ...JSON_SAME_ORIGIN,
          'sec-fetch-site': 'cross-site',
          cookie: cookieHeader(tokenFor({ uid: 2 })),
        },
        body: JSON.stringify({ currentPassword: SEED_PASSWORD, newPassword: NEW }),
      }),
      ctx,
    );
    expect(cross.status).toBe(403);
  });

  it('400 for a malformed body', async () => {
    expect((await change({ currentPassword: SEED_PASSWORD })).status).toBe(400);
  });
});
