import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM without types
import { createAgent, isUnconfigured } from './agent.mjs';

const TOKEN = 'a-long-test-token-0123456789abcdef';
let server: ReturnType<typeof createAgent> | null = null;

async function start(stop = vi.fn(async () => 204)) {
  server = createAgent({ token: TOKEN, allowed: ['bot-a', 'bot-b'], stop });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const post = (body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
    fetch(`${base}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  return { base, post, stop };
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

describe('killswitch agent', () => {
  it('stops an allowlisted container', async () => {
    const { post, stop } = await start();
    const res = await post({ container: 'bot-a' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: 'stopped' });
    expect(stop).toHaveBeenCalledWith('bot-a');
  });

  it('reports an already stopped container as success', async () => {
    const { post } = await start(vi.fn(async () => 304));
    expect(await (await post({ container: 'bot-b' })).json()).toMatchObject({ ok: true, result: 'already-stopped' });
  });

  it('refuses without or with a wrong token, and never calls docker', async () => {
    const { post, stop } = await start();
    expect((await post({ container: 'bot-a' }, null)).status).toBe(401);
    expect((await post({ container: 'bot-a' }, 'Bearer nope')).status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
  });

  it('refuses containers outside the allowlist, including look-alikes', async () => {
    const { post, stop } = await start();
    for (const c of ['freqdash', 'bot-a2', 'bot-a/../x', '', 5, null])
      expect((await post({ container: c })).status).toBe(403);
    expect(stop).not.toHaveBeenCalled();
  });

  it('answers 502 when docker fails or the container is missing', async () => {
    expect((await (await start(vi.fn(async () => 404))).post({ container: 'bot-a' })).status).toBe(502);
    await new Promise<void>((r) => server!.close(() => r()));
    const failing = await start(vi.fn(async () => Promise.reject(new Error('socket gone'))));
    const res = await failing.post({ container: 'bot-a' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('rejects malformed input and other routes; needs a real token and allowlist to start', async () => {
    const { base } = await start();
    expect(
      (await fetch(`${base}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'not json' }))
        .status,
    ).toBe(400);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(() => createAgent({ token: 'short', allowed: ['a'], stop: async () => 204 })).toThrow();
    expect(() => createAgent({ token: TOKEN, allowed: [], stop: async () => 204 })).toThrow();
  });

  it('idles only when neither the token nor the allowlist is set', () => {
    expect(isUnconfigured({})).toBe(true);
    expect(isUnconfigured({ KILLSWITCH_TOKEN: '', KILLSWITCH_ALLOWED: ' ' })).toBe(true);
    expect(isUnconfigured({ KILLSWITCH_TOKEN: TOKEN })).toBe(false);
    expect(isUnconfigured({ KILLSWITCH_ALLOWED: 'bot-a' })).toBe(false);
  });
});
