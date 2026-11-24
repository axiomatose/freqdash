import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AppConfig } from '@/server/config';
import { sessionFromCookieHeader } from '@/server/auth/guard';
import {
  activateSeededUsers,
  cookieHeader,
  DAY,
  NOW,
  request,
  testConfig,
  tokenFor,
  TEST_ORIGIN,
} from '@/server/auth/test-support';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import type { SessionsResponse } from '@/shared/types/api';
import * as list from './route';
import * as one from './[id]/route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const AGENT_TOKEN = 'agent-token-for-tests-0123456789-abcdef';
const json = { 'content-type': 'application/json', origin: TEST_ORIGIN, host: 'dash.test:8043' };
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = (h: unknown, req: NextRequest, params: Record<string, string> = {}) =>
  (h as Handler)(req, { params: Promise.resolve(params) as Promise<never> });
const del = (path: string, token: string) =>
  request(path, { method: 'DELETE', headers: { ...json, cookie: cookieHeader(token) }, body: '{}' });
const live = (token: string) => sessionFromCookieHeader(cookieHeader(token), NOW) !== null;

let temp: TempDb;
beforeEach(() => {
  state.cfg = testConfig({ AGENT_API_TOKEN: AGENT_TOKEN });
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

describe('/api/v1/sessions', () => {
  it("lists only the user's live sessions, marks the current one, and never exposes tokens", async () => {
    const mine = tokenFor({ label: 'Windows · Chrome' });
    const phone = tokenFor({ label: 'iPhone · Safari', createdAt: NOW - DAY });
    tokenFor({ createdAt: NOW - 40 * DAY }); // expired
    tokenFor({ uid: 2 }); // partner's
    const res = await call(list.GET, request('/api/v1/sessions', { headers: { cookie: cookieHeader(mine) } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(mine);
    expect(text).not.toContain(phone);
    const body = JSON.parse(text) as SessionsResponse;
    expect(body.sessions.map((s) => [s.label, s.current])).toEqual([
      ['Windows · Chrome', true],
      ['iPhone · Safari', false],
    ]);
  });

  it('needs a user session; the read-only agent token is refused', async () => {
    expect((await call(list.GET, request('/api/v1/sessions'))).status).toBe(401);
    const agent = request('/api/v1/sessions', { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    expect((await call(list.GET, agent)).status).toBe(403);
  });

  it('ends one of your own sessions, not somebody else’s', async () => {
    const mine = tokenFor();
    const phone = tokenFor();
    const tims = tokenFor({ uid: 2 });
    const ids = (
      (await (
        await call(list.GET, request('/api/v1/sessions', { headers: { cookie: cookieHeader(mine) } }))
      ).json()) as SessionsResponse
    ).sessions;
    const phoneId = ids.find((s) => !s.current)!.id;

    expect((await call(one.DELETE, del(`/api/v1/sessions/${phoneId}`, tims), { id: String(phoneId) })).status).toBe(
      404,
    );
    const res = await call(one.DELETE, del(`/api/v1/sessions/${phoneId}`, mine), { id: String(phoneId) });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(live(phone)).toBe(false);
    expect(live(mine)).toBe(true);
    expect((await call(one.DELETE, del('/api/v1/sessions/abc', mine), { id: 'abc' })).status).toBe(404);
  });

  it('ending the current session signs this browser out', async () => {
    const mine = tokenFor();
    const id = (
      (await (
        await call(list.GET, request('/api/v1/sessions', { headers: { cookie: cookieHeader(mine) } }))
      ).json()) as SessionsResponse
    ).sessions[0]!.id;
    const res = await call(one.DELETE, del(`/api/v1/sessions/${id}`, mine), { id: String(id) });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toMatch(/^fd_session=; Path=\/; Max-Age=0/);
    expect(live(mine)).toBe(false);
  });

  it('signs out everywhere else', async () => {
    const mine = tokenFor();
    const a = tokenFor();
    const b = tokenFor();
    const tims = tokenFor({ uid: 2 });
    const res = await call(list.DELETE, del('/api/v1/sessions', mine));
    expect(await res.json()).toEqual({ ended: 2 });
    expect([live(mine), live(a), live(b), live(tims)]).toEqual([true, false, false, true]);
  });

  it('mutations need JSON and the same origin', async () => {
    const mine = tokenFor();
    const cross = request('/api/v1/sessions', {
      method: 'DELETE',
      headers: { ...json, 'sec-fetch-site': 'cross-site', cookie: cookieHeader(mine) },
    });
    expect((await call(list.DELETE, cross)).status).toBe(403);
  });
});
