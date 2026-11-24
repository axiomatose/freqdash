import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { getDb } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import {
  activateSeededUsers,
  cookieHeader,
  DAY,
  NOW,
  request,
  testConfig,
  TEST_SECRET,
  tokenFor,
} from '@/server/auth/test-support';
import { GET } from './route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const ctx = { params: Promise.resolve({}) };
const get = (headers: Record<string, string> = {}) => GET(request('/api/auth/session', { headers }), ctx);

let temp: TempDb;

beforeEach(() => {
  state.cfg = testConfig();
  temp = installTempDb();
  activateSeededUsers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
  clearRegisteredSecrets();
});

describe('GET /api/auth/session', () => {
  it('returns the username and expiry (Ms) of the session', async () => {
    // Last used two days ago: this request slides the idle end to 30 days from now.
    const res = await get({ cookie: cookieHeader(tokenFor({ uid: 2, createdAt: NOW - 2 * DAY })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'partner', expiresAt: NOW + 30 * DAY, mustChangePassword: false });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('still answers while the password is temporary, and says so', async () => {
    getDb().prepare('UPDATE users SET must_change_password = 1 WHERE id = 1').run();
    const res = await get({ cookie: cookieHeader(tokenFor()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'admin', expiresAt: NOW + 30 * DAY, mustChangePassword: true });
  });

  it('answers 401 without a session, with an expired one, or with a forged one', async () => {
    const forged = 'A'.repeat(43);
    const attempts: Record<string, string>[] = [
      {},
      { cookie: cookieHeader(tokenFor({ createdAt: NOW - 31 * DAY })) },
      { cookie: cookieHeader(forged) },
    ];
    for (const headers of attempts) {
      const res = await get(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('does not expose the secret', async () => {
    const res = await get({ cookie: cookieHeader(tokenFor()) });
    expect(await res.text()).not.toContain(TEST_SECRET);
  });
});
