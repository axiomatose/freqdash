import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationIntent } from '@/shared/types/findings';
import { closeDb } from '../db/client';
import { listNotifications } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { createLogger } from '../log';
import { createStore } from '../state/store';
import type { DeliverySummary } from '../push/service';
import { Dispatcher, type PushChannel } from './dispatcher';

const WEBHOOK = 'https://discord.com/api/webhooks/123456/SECRETTOKEN-abc';

function intent(n: number, severity: NotificationIntent['severity'] = 'critical'): NotificationIntent {
  return { fingerprint: `F:${n}`, findingId: n, kind: 'opened', severity, title: `finding ${n}`, detail: 'detail' };
}

describe('Dispatcher', () => {
  let temp: TempDb;
  let clock = 1_000_000;
  beforeEach(() => {
    temp = installTempDb();
    clock = 1_000_000;
  });
  afterEach(() => {
    temp.cleanup();
    closeDb();
  });

  function make(opts: { ok?: boolean } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: opts.ok === false ? 500 : 204 });
    }) as unknown as typeof fetch;
    const store = createStore();
    const d = new Dispatcher({
      discordWebhookUrl: WEBHOOK,
      store,
      now: () => clock,
      fetchImpl,
    });
    return { d, calls, store };
  }

  it('batches several intents into one Discord message with a [freqdash] prefix', async () => {
    const { d, calls } = make();
    await d.dispatch([intent(1), intent(2), intent(3)]);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.init.body as string) as { content: string; embeds: unknown[] };
    expect(body.content).toBe('[freqdash] 3 findings changed');
    expect(body.embeds).toHaveLength(3);
  });

  it('caps at 10 embeds per message and 5 messages per minute, then flushes later', async () => {
    const { d, calls } = make();
    for (let i = 0; i < 7; i++) await d.dispatch(Array.from({ length: 10 }, (_, j) => intent(i * 10 + j)));
    expect(calls).toHaveLength(5);
    expect(d.pending()).toBe(20);
    clock += 61_000;
    await d.flush();
    expect(calls).toHaveLength(7);
    expect(d.pending()).toBe(0);
  });

  it('logs every attempt and never lets the webhook URL reach the log or the state', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed for ${WEBHOOK}`);
    }) as unknown as typeof fetch;
    const store = createStore();
    const d = new Dispatcher({
      discordWebhookUrl: WEBHOOK,
      store,
      now: () => clock,
      fetchImpl,
    });
    createLogger();
    await d.dispatch([intent(1)]);
    spy.mockRestore();
    expect(lines.join('')).not.toContain('SECRETTOKEN');
    expect(store.get().notifier.lastError).not.toContain('SECRETTOKEN');
    expect(store.get().notifier.consecutiveFailures).toBe(1);
    const rows = listNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error ?? '').not.toContain('SECRETTOKEN');
  });

  it('resets the failure counter after a success and sendTest reports the outcome', async () => {
    const bad = make({ ok: false });
    expect((await bad.d.sendTest()).ok).toBe(false);
    expect(bad.store.get().notifier.consecutiveFailures).toBe(1);
    const good = make();
    expect(await good.d.sendTest()).toEqual({ ok: true });
    expect(good.store.get().notifier.lastSentAt).toBe(clock);
  });

  it('reports "not configured" for the test button without channels', async () => {
    const store = createStore();
    const d = new Dispatcher({ discordWebhookUrl: null, store });
    expect(d.configured).toBe(false);
    expect((await d.sendTest()).ok).toBe(false);
  });
});

describe('Dispatcher with Web Push', () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = installTempDb();
  });
  afterEach(() => {
    temp.cleanup();
    closeDb();
  });

  const summary = (over: Partial<DeliverySummary> = {}): DeliverySummary => ({
    attempted: 1,
    delivered: 1,
    failed: 0,
    error: null,
    ...over,
  });

  function make(subscribers = true) {
    const push = {
      hasSubscribers: vi.fn(() => subscribers),
      sendFindings: vi.fn(async (_i: readonly NotificationIntent[]) => summary()),
      sendTrades: vi.fn(async () => summary()),
      sendAlert: vi.fn(async () => summary()),
      sendSystem: vi.fn(async (_t: string, _d: string, _everyone?: boolean) => summary()),
    } satisfies PushChannel;
    const store = createStore();
    const d = new Dispatcher({ discordWebhookUrl: null, store, push });
    return { d, push, store };
  }

  it('counts as configured once a device subscribed', () => {
    expect(make(true).d.configured).toBe(true);
    expect(make(false).d.configured).toBe(false);
  });

  it('hands findings batches, trades, alerts and system messages to push', async () => {
    const { d, push } = make();
    await d.dispatch([intent(1), intent(2, 'warning')]);
    expect(push.sendFindings).toHaveBeenCalledOnce();
    expect(push.sendFindings.mock.calls[0]?.[0]).toHaveLength(2);

    await d.notifyTrades([
      { key: 'k', botId: 'votemax', kind: 'entry', at: 1, title: 't', body: 'b', short: 's', url: '/bots/votemax' },
    ]);
    expect(push.sendTrades).toHaveBeenCalledOnce();

    expect(await d.alert('Killswitch', 'tripped')).toBe(true);
    expect(push.sendAlert).toHaveBeenCalledWith('Killswitch', 'tripped');

    await d.sendStartup();
    expect(push.sendSystem).toHaveBeenLastCalledWith('freqdash started', 'Monitoring is running.', false);
    expect(await d.sendTest()).toEqual({ ok: true });
    expect(push.sendSystem).toHaveBeenLastCalledWith('test notification', expect.any(String), true);
    expect(listNotifications({ channel: 'push' }).length).toBeGreaterThanOrEqual(4);
  });

  it('skips push entirely without subscribers', async () => {
    const { d, push } = make(false);
    await d.dispatch([intent(1)]);
    await d.notifyTrades([
      { key: 'k', botId: 'votemax', kind: 'exit', at: 1, title: 't', body: 'b', short: 's', url: '/' },
    ]);
    expect(push.sendFindings).not.toHaveBeenCalled();
    expect(push.sendTrades).not.toHaveBeenCalled();
    expect(await d.sendTest()).toEqual({ ok: false, error: 'no notification channel is configured' });
  });

  it('a push failure counts only when no device accepted it', async () => {
    const { d, push, store } = make();
    push.sendAlert.mockResolvedValueOnce(
      summary({ attempted: 2, delivered: 1, failed: 1, error: 'push service responded 500' }),
    );
    expect(await d.alert('a', 'b')).toBe(true);
    expect(store.get().notifier.consecutiveFailures).toBe(0);
    push.sendAlert.mockResolvedValueOnce(summary({ delivered: 0, failed: 1, error: 'push service responded 500' }));
    expect(await d.alert('a', 'b')).toBe(false);
    expect(store.get().notifier.consecutiveFailures).toBe(1);
    expect(store.get().notifier.lastError).toBe('push service responded 500');
  });
});
