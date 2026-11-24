import 'server-only';
import { createHash } from 'node:crypto';
import type { Ms, Severity } from '@/shared/types/domain';
import type { NotificationIntent } from '@/shared/types/findings';
import type { PushPayload, PushPrefs } from '@/shared/types/push';
import { getConfig } from '../config';
import {
  deletePushSubscription,
  getMeta,
  listPushSubscriptions,
  recordPushResult,
  setMeta,
  type PushSubscriptionRecord,
} from '../db';
import { describeError, log, redactSecrets } from '../log';
import { decryptSecret, encryptSecret } from '../settings/crypto';
import { generateVapidKeys, vapidKeysMatch, type VapidKeys } from './crypto';
import { sendPush, type PushOptions } from './send';

// Web Push delivery (VAPID). One instance per process. Each device (subscription) has its own preferences; every
// message is filtered and composed per device, then sent straight to the browser's push service. Subscriptions the
// push service reports as gone (404/410) are deleted.
//
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment, otherwise a pair generated on first use and kept in
// the database (private key encrypted with SESSION_SECRET). Subscriptions are bound to the key they were made with, so
// whenever the key changes every stored subscription is dropped and devices re-enable push from Settings.

const pushLog = log.child('push');
const KEYS_META = 'push_vapid_keys';
const KEY_ID_META = 'push_vapid_public';
const DEVICE_CAP_PER_MIN = 30;
const BODY_MAX = 600;
/** Above this many events for one device in one go, a single summary is sent instead. */
const COLLAPSE_ABOVE = 3;

export interface TradePushEvent {
  key: string;
  botId: string;
  kind: 'entry' | 'exit';
  at: Ms;
  title: string;
  body: string;
  /** One-line form used in summaries. */
  short: string;
  url: string;
}

export interface DeliverySummary {
  /** Devices the message was meant for. */
  attempted: number;
  delivered: number;
  failed: number;
  /** First failure, redacted. */
  error: string | null;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const KIND_LABEL: Record<NotificationIntent['kind'], string> = {
  opened: 'New',
  escalated: 'Escalated',
  grew: 'Grew',
  resolved: 'Resolved',
};

const clip = (text: string, max = BODY_MAX): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Stable short id of an endpoint, for the UI to recognise its own device (the endpoint itself stays server-side). */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);
}

export function wantsFinding(prefs: PushPrefs, intent: NotificationIntent): boolean {
  if (prefs.findings === 'off') return false;
  if (intent.kind === 'resolved' && !prefs.resolved) return false;
  return RANK[intent.severity] >= RANK[prefs.findings];
}

export function wantsTrade(prefs: PushPrefs, event: TradePushEvent): boolean {
  return event.kind === 'entry' ? prefs.entries : prefs.exits;
}

/** One notification for a device's share of a findings batch. */
export function composeFindings(intents: readonly NotificationIntent[], now: Ms): PushPayload {
  const worst = intents.reduce<Severity>((acc, i) => (RANK[i.severity] > RANK[acc] ? i.severity : acc), 'info');
  if (intents.length === 1) {
    const i = intents[0] as NotificationIntent;
    return {
      title: `${SEVERITY_ICON[i.severity]} ${KIND_LABEL[i.kind]}: ${i.title}`,
      body: clip(i.detail),
      tag: `finding-${i.fingerprint}`.slice(0, 64),
      url: i.findingId !== null ? `/findings?id=${i.findingId}` : '/findings',
      severity: i.severity,
      at: now,
    };
  }
  return {
    title: `${SEVERITY_ICON[worst]} ${intents.length} findings changed`,
    body: clip(intents.map((i) => `${KIND_LABEL[i.kind]}: ${i.title}`).join('\n')),
    tag: `findings-${now}`,
    url: '/findings',
    severity: worst,
    at: now,
  };
}

/** One notification for a device's share of trade events (a summary above three). */
export function composeTrades(events: readonly TradePushEvent[], now: Ms): PushPayload {
  if (events.length <= 1) {
    const e = events[0] as TradePushEvent;
    return { title: e.title, body: clip(e.body), tag: `trade-${e.key}`.slice(0, 64), url: e.url, at: now };
  }
  const entries = events.filter((e) => e.kind === 'entry').length;
  const exits = events.length - entries;
  const parts = [
    entries > 0 ? `${entries} buy${entries === 1 ? '' : 's'}` : null,
    exits > 0 ? `${exits} sell${exits === 1 ? '' : 's'}` : null,
  ];
  const bots = new Set(events.map((e) => e.botId));
  return {
    title: `${parts.filter(Boolean).join(', ')}`,
    body: clip(events.map((e) => e.short).join('\n')),
    tag: `trades-${now}`,
    url: bots.size === 1 ? `/bots/${[...bots][0] as string}` : '/trades',
    at: now,
  };
}

export interface PushServiceOptions {
  now?: () => Ms;
  fetchImpl?: typeof fetch;
  /** Overrides for tests; default from the configuration. */
  keys?: VapidKeys;
  subject?: string;
}

export class PushService {
  readonly #now: () => Ms;
  readonly #fetch: typeof fetch;
  readonly #subject: string | undefined;
  #keys: VapidKeys | null;
  readonly #sent = new Map<number, Ms[]>();

  constructor(options: PushServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#keys = options.keys ?? null;
    this.#subject = options.subject;
  }

  /** The VAPID key pair, loading or creating it on first use. Null when it cannot be had (logged). */
  keys(): VapidKeys | null {
    if (this.#keys !== null) return this.#keys;
    try {
      const cfg = getConfig();
      let keys = cfg.notify.vapid;
      if (keys !== null && !vapidKeysMatch(keys)) {
        pushLog.error('VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY; web push is off');
        return null;
      }
      if (keys === null) {
        const stored = getMeta(KEYS_META);
        const plain = stored === null ? null : decryptSecret(stored, cfg.auth.sessionSecret);
        const parsed = plain === null ? null : (JSON.parse(plain) as VapidKeys);
        if (parsed !== null && vapidKeysMatch(parsed)) {
          keys = parsed;
        } else {
          keys = generateVapidKeys();
          setMeta(KEYS_META, encryptSecret(JSON.stringify(keys), cfg.auth.sessionSecret));
          pushLog.info('generated a VAPID key pair for web push');
        }
      }
      // Subscriptions belong to the key they were created with.
      const previous = getMeta(KEY_ID_META);
      if (previous !== keys.publicKey) {
        const stale = listPushSubscriptions();
        for (const s of stale) deletePushSubscription(s.id);
        if (previous !== null && stale.length > 0) {
          pushLog.warn('VAPID key changed: removed every push subscription; re-enable push on each device', {
            removed: stale.length,
          });
        }
        setMeta(KEY_ID_META, keys.publicKey);
      }
      this.#keys = keys;
      return keys;
    } catch (err) {
      pushLog.error('web push keys unavailable', { err: describeError(err) });
      return null;
    }
  }

  publicKey(): string | null {
    return this.keys()?.publicKey ?? null;
  }

  hasSubscribers(): boolean {
    try {
      return listPushSubscriptions().length > 0;
    } catch {
      return false;
    }
  }

  /** Findings batch: each device gets the intents it wants, as one notification. */
  sendFindings(intents: readonly NotificationIntent[]): Promise<DeliverySummary> {
    return this.#fanOut(
      (prefs) => {
        const mine = intents.filter((i) => wantsFinding(prefs, i));
        return mine.length === 0 ? [] : [composeFindings(mine, this.#now())];
      },
      (p) => ({ urgency: p.severity === 'critical' ? 'high' : 'normal', ttlSec: 24 * 3600 }),
    );
  }

  /** Entries and exits: each device gets the kinds it wants; more than three at once become one summary. */
  sendTrades(events: readonly TradePushEvent[]): Promise<DeliverySummary> {
    return this.#fanOut(
      (prefs) => {
        const mine = events.filter((e) => wantsTrade(prefs, e));
        const now = this.#now();
        return mine.length > COLLAPSE_ABOVE ? [composeTrades(mine, now)] : mine.map((e) => composeTrades([e], now));
      },
      () => ({ urgency: 'normal', ttlSec: 6 * 3600 }),
    );
  }

  /** Safety alert (the killswitch): every device, regardless of preferences, high urgency. */
  sendAlert(title: string, detail: string): Promise<DeliverySummary> {
    const payload: PushPayload = {
      title: `🔴 ${title}`,
      body: clip(detail),
      tag: `alert-${this.#now()}`,
      url: '/',
      severity: 'critical',
      at: this.#now(),
    };
    return this.#fanOut(
      () => [payload],
      () => ({ urgency: 'high', ttlSec: 24 * 3600 }),
    );
  }

  /** freqdash started and similar: devices with "system" on. `everyone` ignores preferences (a test). */
  sendSystem(title: string, detail: string, everyone = false): Promise<DeliverySummary> {
    const payload: PushPayload = {
      title,
      body: clip(detail),
      tag: `system-${this.#now()}`,
      url: '/status',
      at: this.#now(),
    };
    return this.#fanOut(
      (prefs) => (everyone || prefs.system ? [payload] : []),
      () => ({ urgency: 'low', ttlSec: 3600 }),
    );
  }

  /** Test button for one device (the owner's). */
  async sendTestTo(subscription: PushSubscriptionRecord): Promise<DeliverySummary> {
    const payload: PushPayload = {
      title: 'freqdash test',
      body: 'Notifications work on this device.',
      tag: 'test',
      url: '/',
      at: this.#now(),
    };
    const summary: DeliverySummary = { attempted: 0, delivered: 0, failed: 0, error: null };
    if (this.keys() !== null)
      await this.#deliver(subscription, payload, { urgency: 'normal', ttlSec: 600 }, summary, true);
    return summary;
  }

  async #fanOut(
    compose: (prefs: PushPrefs) => PushPayload[],
    delivery: (p: PushPayload) => Pick<PushOptions, 'urgency' | 'ttlSec'>,
  ): Promise<DeliverySummary> {
    const summary: DeliverySummary = { attempted: 0, delivered: 0, failed: 0, error: null };
    if (this.keys() === null) return summary;
    let subs: PushSubscriptionRecord[];
    try {
      subs = listPushSubscriptions();
    } catch (err) {
      pushLog.warn('could not list push subscriptions', { err: describeError(err) });
      return summary;
    }
    await Promise.all(
      subs.map(async (sub) => {
        // Sequential per device keeps the order (a buy before the sell that closed it).
        for (const payload of compose(sub.prefs)) {
          if (!(await this.#deliver(sub, payload, delivery(payload), summary, false))) break;
        }
      }),
    );
    return summary;
  }

  async #deliver(
    sub: PushSubscriptionRecord,
    payload: PushPayload,
    options: Pick<PushOptions, 'urgency' | 'ttlSec'>,
    summary: DeliverySummary,
    bypassCap: boolean,
  ): Promise<boolean> {
    const keys = this.keys();
    if (keys === null) return false;
    const now = this.#now();
    const recent = (this.#sent.get(sub.id) ?? []).filter((t) => now - t < 60_000);
    if (!bypassCap && recent.length >= DEVICE_CAP_PER_MIN) {
      pushLog.warn('push rate cap reached for a device; message dropped', { device: sub.id });
      return true;
    }
    this.#sent.set(sub.id, [...recent, now]);
    summary.attempted += 1;
    const result = await sendPush(
      sub,
      JSON.stringify(payload),
      { keys, subject: this.#subject ?? getConfig().notify.vapidSubject, now, ...options },
      this.#fetch,
    );
    try {
      if (result.ok) {
        summary.delivered += 1;
        recordPushResult(sub.id, true, null, now);
      } else if (result.gone) {
        // Unsubscribed in the browser, expired, or not ours to send to: forget it. Not a delivery failure.
        deletePushSubscription(sub.id);
        this.#sent.delete(sub.id);
        pushLog.info('removed a push subscription the push service no longer knows', {
          device: sub.id,
          status: result.status,
        });
        return false;
      } else {
        summary.failed += 1;
        const error = redactSecrets(result.error ?? 'unknown error');
        summary.error ??= error;
        recordPushResult(sub.id, false, error, now);
      }
    } catch (err) {
      pushLog.warn('could not record a push result', { err: describeError(err) });
    }
    return true;
  }
}

const KEY = Symbol.for('freqdash.push');
type GlobalWithPush = typeof globalThis & { [KEY]?: PushService };

/** The process-wide push service (shared by the poller's dispatcher and the API routes). */
export function getPushService(): PushService {
  const g = globalThis as GlobalWithPush;
  g[KEY] ??= new PushService();
  return g[KEY];
}

export function setPushServiceForTests(service: PushService | null): void {
  const g = globalThis as GlobalWithPush;
  if (service === null) delete g[KEY];
  else g[KEY] = service;
}
