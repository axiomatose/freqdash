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
import { closeDb } from '@/server/db/client';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { getStore, resetStoreForTests } from '@/server/state/store';
import { seededBot } from '@/server/views/testing';
import * as acks from './acks/route';
import * as ack from './acks/[id]/route';
import * as bot from './bots/[botId]/route';
import * as equity from './equity/route';
import * as findings from './findings/route';
import * as silence from './findings/[id]/silence/route';
import * as unsilence from './findings/[id]/unsilence/route';
import * as krakenOrders from './kraken/orders/route';
import * as notifyTest from './notify/test/route';
import * as ksReset from './killswitch/reset/route';
import * as overview from './overview/route';
import * as positions from './positions/route';
import * as status from './status/route';
import * as summary from './summary/route';
import * as trades from './trades/route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

let temp: TempDb;
const cookie = () => ({ cookie: cookieHeader(tokenFor()) });
const json = { 'content-type': 'application/json', origin: TEST_ORIGIN, host: 'dash.test:8043' };
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = (h: unknown, req: NextRequest, params: Record<string, string> = {}) =>
  (h as Handler)(req, { params: Promise.resolve(params) as Promise<never> });

beforeEach(() => {
  state.cfg = testConfig();
  temp = installTempDb();
  activateSeededUsers();
  resetStoreForTests();
  getStore().update((s) => {
    s.bots.votemax = seededBot('votemax', 'VoteMax');
    s.monitor.lastCycleAt = Date.now();
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
  closeDb();
  resetStoreForTests();
  clearRegisteredSecrets();
});

describe('authentication', () => {
  const gets: [string, unknown, string, Record<string, string>?][] = [
    ['summary', summary.GET, '/api/v1/summary'],
    ['overview', overview.GET, '/api/v1/overview'],
    ['positions', positions.GET, '/api/v1/positions'],
    ['status', status.GET, '/api/v1/status'],
    ['bot', bot.GET, '/api/v1/bots/votemax', { botId: 'votemax' }],
    ['trades', trades.GET, '/api/v1/trades'],
    ['kraken orders', krakenOrders.GET, '/api/v1/kraken/orders'],
    ['findings', findings.GET, '/api/v1/findings'],
    ['acks', acks.GET, '/api/v1/acks'],
    ['equity', equity.GET, '/api/v1/equity?range=7d'],
  ];

  it.each(gets)('%s: 401 without a session, 200 with one, never cached', async (_n, handler, path, params) => {
    const denied = await call(handler, request(path), params);
    expect(denied.status).toBe(401);
    const res = await call(handler, request(path, { headers: cookie() }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  const posts: [string, unknown, string, Record<string, string>?, string?][] = [
    [
      'acks POST',
      acks.POST,
      '/api/v1/acks',
      undefined,
      JSON.stringify({ kind: 'asset', subjects: ['SHIB'], label: 'manual' }),
    ],
    ['acks DELETE', ack.DELETE, '/api/v1/acks/1', { id: '1' }],
    ['silence', silence.POST, '/api/v1/findings/1/silence', { id: '1' }, '{}'],
    ['unsilence', unsilence.POST, '/api/v1/findings/1/unsilence', { id: '1' }],
    ['notify test', notifyTest.POST, '/api/v1/notify/test'],
    ['killswitch reset', ksReset.POST, '/api/v1/killswitch/reset'],
  ];

  it.each(posts)(
    '%s: 401 without a session, 415 for non-JSON, 403 cross-origin',
    async (_n, handler, path, params, body) => {
      const method = _n === 'acks DELETE' ? 'DELETE' : 'POST';
      expect(
        (await call(handler, request(path, { method, headers: json, ...(body ? { body } : {}) }), params)).status,
      ).toBe(401);
      expect(
        (
          await call(
            handler,
            request(path, { method, headers: { ...cookie(), origin: TEST_ORIGIN, host: 'dash.test:8043' } }),
            params,
          )
        ).status,
      ).toBe(415);
      const cross = { ...cookie(), 'content-type': 'application/json', origin: 'https://evil.example' };
      expect(
        (await call(handler, request(path, { method, headers: cross, ...(body ? { body } : {}) }), params)).status,
      ).toBe(403);
    },
  );
});

describe('handlers', () => {
  it('validates queries with a 400', async () => {
    for (const path of [
      '/api/v1/trades?status=bogus',
      '/api/v1/trades?limit=abc',
      '/api/v1/findings?severity=x',
      '/api/v1/equity?range=1y',
      '/api/v1/kraken/orders?match=z',
    ]) {
      const handler = path.includes('trades')
        ? trades.GET
        : path.includes('findings')
          ? findings.GET
          : path.includes('equity')
            ? equity.GET
            : krakenOrders.GET;
      const res = await call(handler, request(path, { headers: cookie() }));
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad_request');
    }
  });

  it('answers 404 for an unknown or malformed bot id', async () => {
    expect((await call(bot.GET, request('/api/v1/bots/nope', { headers: cookie() }), { botId: 'nope' })).status).toBe(
      404,
    );
    expect((await call(bot.GET, request('/api/v1/bots/X', { headers: cookie() }), { botId: '../x' })).status).toBe(404);
  });

  it('creates acks, lists them, revokes one and triggers a recheck', async () => {
    const recheck = vi.fn();
    getStore().onRecheck(recheck);
    const body = JSON.stringify({
      kind: 'kraken_order',
      subjects: ['OORUYZ-2BWGK-SAYX6T', 'O3OVJH-YNYDT-L5RGHT'],
      label: 'manual',
      note: 'mine',
    });
    const created = await call(
      acks.POST,
      request('/api/v1/acks', { method: 'POST', headers: { ...cookie(), ...json }, body }),
    );
    expect(created.status).toBe(200);
    const { acks: list } = (await created.json()) as { acks: { id: number; createdBy: string | null }[] };
    expect(list).toHaveLength(2);
    expect(list[0]?.createdBy).toBe('admin');
    expect(recheck).toHaveBeenCalledTimes(1);

    const got = (await (await call(acks.GET, request('/api/v1/acks', { headers: cookie() }))).json()) as {
      acks: unknown[];
    };
    expect(got.acks).toHaveLength(2);

    const id = String(list[0]?.id);
    const del = await call(
      ack.DELETE,
      request(`/api/v1/acks/${id}`, { method: 'DELETE', headers: { ...cookie(), ...json } }),
      { id },
    );
    expect(del.status).toBe(204);
    const again = await call(
      ack.DELETE,
      request(`/api/v1/acks/${id}`, { method: 'DELETE', headers: { ...cookie(), ...json } }),
      { id },
    );
    expect(again.status).toBe(404);
  });

  it('rejects an invalid ack body', async () => {
    for (const body of ['{}', JSON.stringify({ kind: 'asset', subjects: [], label: 'manual' }), 'not json']) {
      const res = await call(
        acks.POST,
        request('/api/v1/acks', { method: 'POST', headers: { ...cookie(), ...json }, body }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('answers 404 when silencing an unknown finding', async () => {
    const res = await call(
      silence.POST,
      request('/api/v1/findings/9/silence', { method: 'POST', headers: { ...cookie(), ...json }, body: '{}' }),
      { id: '9' },
    );
    expect(res.status).toBe(404);
    const bad = await call(
      unsilence.POST,
      request('/api/v1/findings/x/unsilence', { method: 'POST', headers: { ...cookie(), ...json } }),
      { id: 'x' },
    );
    expect(bad.status).toBe(404);
  });

  it('reports "no channel" from the notify test when none is configured', async () => {
    const res = await call(
      notifyTest.POST,
      request('/api/v1/notify/test', { method: 'POST', headers: { ...cookie(), ...json } }),
    );
    expect(await res.json()).toEqual({ ok: false, error: 'no notification channel is configured' });
  });

  it('resets the killswitch latch', async () => {
    const { setMeta, getMeta } = await import('@/server/db');
    setMeta('killswitch_state', JSON.stringify({ tripped: { at: 1 }, resetAt: null }));
    const res = await call(
      ksReset.POST,
      request('/api/v1/killswitch/reset', { method: 'POST', headers: { ...cookie(), ...json } }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(getMeta('killswitch_state') ?? '{}')).toMatchObject({ tripped: null, resetAt: NOW });
  });
});
