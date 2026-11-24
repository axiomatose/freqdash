import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { sessionFromCookieHeader } from '@/server/auth/guard';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import {
  activateSeededUsers,
  cookieHeader,
  JSON_SAME_ORIGIN,
  NOW,
  request,
  testConfig,
  tokenFor,
} from '@/server/auth/test-support';
import { POST } from './route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const ctx = { params: Promise.resolve({}) };
const logout = (headers: Record<string, string>) => POST(request('/api/auth/logout', { method: 'POST', headers }), ctx);
let temp: TempDb;
let token: string;
let signedIn: { cookie: string };

beforeEach(() => {
  temp = installTempDb();
  activateSeededUsers();
  token = tokenFor();
  signedIn = { cookie: cookieHeader(token) };
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // the CSRF warning is expected in some tests
  state.cfg = testConfig();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearRegisteredSecrets();
  temp.cleanup();
});

describe('POST /api/auth/logout', () => {
  it('answers 204 and expires the cookie', async () => {
    const res = await logout({ ...JSON_SAME_ORIGIN, ...signedIn });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.getSetCookie()).toEqual(['fd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('ends the session on the server, so a copy of the cookie stops working too', async () => {
    const other = tokenFor();
    expect((await logout({ ...JSON_SAME_ORIGIN, ...signedIn })).status).toBe(204);
    expect(sessionFromCookieHeader(cookieHeader(token), NOW)).toBeNull();
    expect(sessionFromCookieHeader(cookieHeader(other), NOW)).not.toBeNull();
    expect((await logout({ ...JSON_SAME_ORIGIN, ...signedIn })).status).toBe(401);
  });

  it('keeps the Secure flag on the clearing cookie behind https', async () => {
    const res = await logout({ ...JSON_SAME_ORIGIN, ...signedIn, 'x-forwarded-proto': 'https' });
    expect(res.headers.getSetCookie()[0]).toMatch(/Max-Age=0;.*; Secure$/);
  });

  it('requires a session', async () => {
    const res = await logout(JSON_SAME_ORIGIN);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('is a mutating route: 415 for non-JSON and 403 for cross-site requests', async () => {
    expect((await logout({ ...signedIn, 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' })).status).toBe(
      415,
    );
    const cross = await logout({ ...JSON_SAME_ORIGIN, ...signedIn, 'sec-fetch-site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect(cross.headers.getSetCookie()).toEqual([]);
  });
});
