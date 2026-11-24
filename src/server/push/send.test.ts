import { createECDH } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generateVapidKeys } from './crypto';
import { isAllowedPushEndpoint, sendPush } from './send';

const ua = createECDH('prime256v1');
ua.generateKeys();
const target = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-token-123',
  p256dh: ua.getPublicKey().toString('base64url'),
  auth: Buffer.alloc(16, 1).toString('base64url'),
};
const options = {
  keys: generateVapidKeys(),
  subject: 'mailto:a@example.com',
  ttlSec: 600,
  urgency: 'high' as const,
  now: 1_700_000_000_000,
};

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('allows %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilpush.apple.com/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])('refuses %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(false));
});

describe('sendPush', () => {
  it('POSTs the encrypted body with VAPID, TTL, urgency and topic headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    const res = await sendPush(target, '{"title":"x"}', { ...options, topic: 'finding-abc' }, fetchImpl);
    expect(res).toEqual({ ok: true, status: 201, gone: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(target.endpoint);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('600');
    expect(headers.Urgency).toBe('high');
    expect(headers.Topic).toBe('finding-abc');
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${options.keys.publicKey}$`));
    expect((init?.body as Uint8Array).length).toBeGreaterThan(86);
  });

  it('reports 404/410 as gone, other statuses and network errors as failures', async () => {
    for (const [status, gone] of [
      [410, true],
      [404, true],
      [429, false],
      [500, false],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      expect(await sendPush(target, 'x', options, fetchImpl)).toMatchObject({ ok: false, status, gone });
    }
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    expect(await sendPush(target, 'x', options, failing)).toMatchObject({ ok: false, status: null, gone: false });
  });

  it('never contacts an endpoint outside the push services, and drops undecryptable subscriptions', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await sendPush({ ...target, endpoint: 'https://10.0.0.1/x' }, 'x', options, fetchImpl)).toMatchObject({
      ok: false,
      gone: true,
    });
    expect(await sendPush({ ...target, p256dh: 'AAAA' }, 'x', options, fetchImpl)).toMatchObject({
      ok: false,
      gone: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
