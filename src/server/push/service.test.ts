import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import type { NotificationIntent } from '@/shared/types/findings';
import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@/shared/types/push';
import { testConfig } from '../auth/test-support';
import { getMeta, getPushSubscription, listPushSubscriptions, upsertPushSubscription } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { clearRegisteredSecrets } from '../log';
import { generateVapidKeys } from './crypto';
import { composeFindings, composeTrades, PushService, wantsFinding, type TradePushEvent } from './service';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

const NOW = 1_800_000_000_000;

function intent(over: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    fingerprint: 'ORPHAN:abc',
    findingId: 7,
    kind: 'opened',
    severity: 'critical',
    title: 'Orphan Kraken order',
    detail: 'buy ETH',
    ...over,
  };
}

function tradeEvent(over: Partial<TradePushEvent> = {}): TradePushEvent {
  return {
    key: 'entry:votemax:o1',
    botId: 'votemax',
    kind: 'entry',
    at: NOW,
    title: 'VoteMax bought ETH/USD',
    body: '0.02 ETH',
    short: 'VoteMax bought ETH/USD · $50.00',
    url: '/bots/votemax',
    ...over,
  };
}

let n = 0;
function subscribe(userId: number, prefs: Partial<PushPrefs> = {}) {
  n += 1;
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return upsertPushSubscription(
    {
      userId,
      endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, n).toString('base64url'),
      label: `device ${n}`,
      prefs: { ...DEFAULT_PUSH_PREFS, ...prefs },
    },
    NOW,
  );
}

describe('preference filters and composition', () => {
  it('filters findings by severity and the resolved switch', () => {
    const p = { ...DEFAULT_PUSH_PREFS, findings: 'warning' as const, resolved: false };
    expect(wantsFinding(p, intent({ severity: 'info' }))).toBe(false);
    expect(wantsFinding(p, intent({ severity: 'warning' }))).toBe(true);
    expect(wantsFinding(p, intent({ kind: 'resolved' }))).toBe(false);
    expect(wantsFinding({ ...p, findings: 'off' }, intent())).toBe(false);
  });

  it('one finding links to it; several become a summary', () => {
    expect(composeFindings([intent()], NOW)).toMatchObject({
      title: '🔴 New: Orphan Kraken order',
      body: 'buy ETH',
      tag: 'finding-ORPHAN:abc',
      url: '/findings?id=7',
      severity: 'critical',
    });
    const many = composeFindings(
      [intent(), intent({ severity: 'warning', title: 'Bot restarted', kind: 'resolved' })],
      NOW,
    );
    expect(many.title).toBe('🔴 2 findings changed');
    expect(many.body).toBe('New: Orphan Kraken order\nResolved: Bot restarted');
  });

  it('several trades become one summary pointing at the bot', () => {
    const summary = composeTrades(
      [tradeEvent(), tradeEvent({ key: 'b' }), tradeEvent({ key: 'c', kind: 'exit', short: 'VoteMax sold' })],
      NOW,
    );
    expect(summary).toMatchObject({ title: '2 buys, 1 sell', url: '/bots/votemax' });
    expect(composeTrades([tradeEvent(), tradeEvent({ botId: 'dca' })], NOW).url).toBe('/trades');
  });
});

describe('PushService', () => {
  let temp: TempDb;
  let sent: { url: string; init: RequestInit }[];
  let status: number;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const service = () => new PushService({ now: () => NOW, fetchImpl });

  beforeEach(() => {
    temp = installTempDb();
    state.cfg = testConfig();
    sent = [];
    status = 201;
  });
  afterEach(() => {
    temp.cleanup();
    clearRegisteredSecrets();
  });

  it('generates a key pair once and keeps it (private key encrypted at rest)', () => {
    const key = service().publicKey();
    expect(key).toMatch(/^[\w-]{87}$/);
    expect(service().publicKey()).toBe(key);
    expect(getMeta('push_vapid_keys')).toMatch(/^v1:/);
    expect(getMeta('push_vapid_keys')).not.toContain(key!);
  });

  it('uses keys from the environment, and drops every subscription when the key changes', () => {
    service().publicKey();
    subscribe(1);
    const env = generateVapidKeys();
    state.cfg = testConfig({ VAPID_PUBLIC_KEY: env.publicKey, VAPID_PRIVATE_KEY: env.privateKey });
    expect(service().publicKey()).toBe(env.publicKey);
    expect(listPushSubscriptions()).toEqual([]);
  });

  it('refuses mismatched environment keys', () => {
    const a = generateVapidKeys();
    state.cfg = testConfig({ VAPID_PUBLIC_KEY: a.publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey });
    expect(service().publicKey()).toBeNull();
  });

  it('sends each device only what it asked for', async () => {
    const svc = service();
    svc.publicKey();
    const all = subscribe(1, { findings: 'info' });
    const quiet = subscribe(2, { findings: 'critical', entries: false });
    const off = subscribe(2, { findings: 'off', exits: false });

    const warn = await svc.sendFindings([intent({ severity: 'warning' })]);
    expect(warn).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(sent.map((s) => s.url)).toEqual([all.endpoint]);

    sent = [];
    await svc.sendTrades([tradeEvent()]);
    expect(sent.map((s) => s.url).sort()).toEqual([all.endpoint, off.endpoint].sort());

    sent = [];
    await svc.sendAlert('Killswitch tripped', 'stopped');
    expect(sent).toHaveLength(3);
    expect((sent[0]?.init.headers as Record<string, string>).Urgency).toBe('high');

    sent = [];
    await svc.sendSystem('freqdash started', 'up');
    expect(sent).toHaveLength(0);
    await svc.sendSystem('test', 'up', true);
    expect(sent).toHaveLength(3);
    expect(getPushSubscription(quiet.id)?.lastOkAt).toBe(NOW);
  });

  it('sends up to three trade events one by one, more as a single summary', async () => {
    const svc = service();
    svc.publicKey();
    subscribe(1);
    await svc.sendTrades([tradeEvent({ key: 'a' }), tradeEvent({ key: 'b' })]);
    expect(sent).toHaveLength(2);
    sent = [];
    await svc.sendTrades(['a', 'b', 'c', 'd'].map((key) => tradeEvent({ key })));
    expect(sent).toHaveLength(1);
  });

  it('deletes a subscription the push service reports gone; records other failures', async () => {
    const svc = service();
    svc.publicKey();
    const a = subscribe(1);
    status = 410;
    expect(await svc.sendAlert('x', 'y')).toMatchObject({ attempted: 1, delivered: 0, failed: 0 });
    expect(getPushSubscription(a.id)).toBeNull();

    const b = subscribe(1);
    status = 500;
    expect(await svc.sendAlert('x', 'y')).toMatchObject({ failed: 1, error: 'push service responded 500' });
    expect(getPushSubscription(b.id)).toMatchObject({ failures: 1, lastError: 'push service responded 500' });
  });

  it('caps each device at 30 messages a minute (tests bypass the cap)', async () => {
    const svc = service();
    svc.publicKey();
    const a = subscribe(1);
    for (let i = 0; i < 32; i += 1) await svc.sendAlert('x', String(i));
    expect(sent).toHaveLength(30);
    expect((await svc.sendTestTo(a)).delivered).toBe(1);
  });
});
