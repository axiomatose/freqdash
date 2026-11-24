import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AppConfig } from '@/server/config';
import {
  activateSeededUsers,
  cookieHeader,
  NOW,
  request,
  testConfig,
  tokenFor,
  TEST_ORIGIN,
} from '@/server/auth/test-support';
import { getPushSubscription, listPushSubscriptions } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { PushService, setPushServiceForTests } from '@/server/push/service';
import type { PushStatusResponse } from '@/shared/types/push';
import * as status from './route';
import * as subscriptions from './subscriptions/route';
import * as device from './subscriptions/[id]/route';
import * as test from './subscriptions/[id]/test/route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const AGENT_TOKEN = 'agent-token-for-tests-0123456789-abcdef';
const admin = () => ({ cookie: cookieHeader(tokenFor()) });
const partner = () => ({ cookie: cookieHeader(tokenFor({ uid: 2 })) });
const json = { 'content-type': 'application/json', origin: TEST_ORIGIN, host: 'dash.test:8043' };
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = (h: unknown, req: NextRequest, params: Record<string, string> = {}) =>
  (h as Handler)(req, { params: Promise.resolve(params) as Promise<never> });
const send = (method: string, path: string, body: unknown, who = admin()) =>
  request(path, { method, headers: { ...who, ...json }, body: JSON.stringify(body) });

const ua = createECDH('prime256v1');
ua.generateKeys();
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({
  endpoint,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
});

let temp: TempDb;
const pushed: string[] = [];

beforeEach(() => {
  state.cfg = testConfig({ AGENT_API_TOKEN: AGENT_TOKEN });
  temp = installTempDb();
  activateSeededUsers();
  pushed.length = 0;
  setPushServiceForTests(
    new PushService({
      fetchImpl: (async (url: string | URL | Request) => {
        pushed.push(String(url));
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setPushServiceForTests(null);
  temp.cleanup();
  clearRegisteredSecrets();
});

describe('/api/v1/push', () => {
  it('needs a user session; the read-only agent token is refused', async () => {
    expect((await call(status.GET, request('/api/v1/push'))).status).toBe(401);
    const agent = request('/api/v1/push', { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    expect((await call(status.GET, agent)).status).toBe(403);
    const res = await call(status.GET, request('/api/v1/push', { headers: admin() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PushStatusResponse;
    expect(body.publicKey).toMatch(/^[\w-]{87}$/);
    expect(body.devices).toEqual([]);
    expect(body.serverMinSeverity).toBe('warning');
  });

  it('registers a device with default preferences, without exposing the endpoint', async () => {
    const res = await call(
      subscriptions.POST,
      send('POST', '/api/v1/push/subscriptions', { subscription: subscription(), label: 'iPhone · Safari' }),
    );
    expect(res.status).toBe(200);
    const { device: d } = (await res.json()) as { device: Record<string, unknown> };
    expect(d).toMatchObject({ label: 'iPhone · Safari', prefs: { entries: true, exits: true, findings: 'warning' } });
    expect(JSON.stringify(d)).not.toContain('fcm.googleapis.com');
    expect(d.endpointHash).toMatch(/^[\w-]{16}$/);

    const list = (await (
      await call(status.GET, request('/api/v1/push', { headers: admin() }))
    ).json()) as PushStatusResponse;
    expect(list.devices).toHaveLength(1);
    const timList = (await (
      await call(status.GET, request('/api/v1/push', { headers: partner() }))
    ).json()) as PushStatusResponse;
    expect(timList.devices).toHaveLength(0);
  });

  it('refuses endpoints outside the browser push services and malformed keys', async () => {
    const evil = await call(
      subscriptions.POST,
      send('POST', '/api/v1/push/subscriptions', { subscription: subscription('https://192.168.1.10/hook') }),
    );
    expect(evil.status).toBe(400);
    const bad = await call(
      subscriptions.POST,
      send('POST', '/api/v1/push/subscriptions', {
        subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: 'AAAA' } },
      }),
    );
    expect(bad.status).toBe(400);
    expect(listPushSubscriptions()).toEqual([]);
  });

  it('lets only the owner change, test or remove a device', async () => {
    const res = await call(
      subscriptions.POST,
      send('POST', '/api/v1/push/subscriptions', { subscription: subscription() }),
    );
    const { device: d } = (await res.json()) as { device: { id: number } };
    const path = `/api/v1/push/subscriptions/${d.id}`;
    const params = { id: String(d.id) };

    expect((await call(device.PUT, send('PUT', path, { prefs: { entries: false } }, partner()), params)).status).toBe(
      404,
    );
    const put = await call(device.PUT, send('PUT', path, { prefs: { entries: false, findings: 'critical' } }), params);
    expect(put.status).toBe(200);
    expect(getPushSubscription(d.id)?.prefs).toMatchObject({ entries: false, exits: true, findings: 'critical' });
    expect((await call(device.PUT, send('PUT', path, { prefs: { bogus: true } }), params)).status).toBe(400);

    expect((await call(test.POST, send('POST', `${path}/test`, {}, partner()), params)).status).toBe(404);
    const tested = await call(test.POST, send('POST', `${path}/test`, {}), params);
    expect(await tested.json()).toEqual({ ok: true });
    expect(pushed).toEqual(['https://fcm.googleapis.com/fcm/send/abc']);

    expect((await call(device.DELETE, send('DELETE', path, {}, partner()), params)).status).toBe(404);
    expect((await call(device.DELETE, send('DELETE', path, {}), params)).status).toBe(204);
    expect(getPushSubscription(d.id)).toBeNull();
  });

  it('the same browser signing in as another user moves the device to that user', async () => {
    await call(subscriptions.POST, send('POST', '/api/v1/push/subscriptions', { subscription: subscription() }));
    await call(
      subscriptions.POST,
      send('POST', '/api/v1/push/subscriptions', { subscription: subscription() }, partner()),
    );
    expect(listPushSubscriptions().map((s) => s.userId)).toEqual([2]);
  });
});
