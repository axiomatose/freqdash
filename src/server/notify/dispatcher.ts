import type { Ms, Severity } from '@/shared/types/domain';
import type { NotificationIntent } from '@/shared/types/findings';
import type { StateStore } from '@/shared/types/state';
import { logNotification } from '../db';
import { describeError, log, redactSecrets } from '../log';
import type { DeliverySummary, TradePushEvent } from '../push/service';
import { DISCORD_MAX_EMBEDS, sendDiscord, type DiscordEmbed, type SendResult } from './discord';

// Notification dispatcher (docs/PLAN.md section 8.2 point 6): at most 5 messages per minute per channel, several
// intents batched into one Discord message (up to 10 embeds), every message prefixed
// `[freqdash]`. Excess intents wait in a queue and go out when the window frees up (flush()).
//
// Web Push is the third channel: findings (batched like Discord, filtered per device by its preferences), trade
// entries and exits (push only), killswitch alerts (every device) and system messages. It is "configured" as soon as
// one device has subscribed. A push delivery counts as failed only when no device accepted it and a device errored
// (a subscription the push service reports gone is removed, not a failure).

export const CHANNEL_CAP_PER_MIN = 5;
const WINDOW_MS = 60_000;
const PREFIX = '[freqdash]';

type Channel = 'discord' | 'push';

/** The part of PushService the dispatcher uses (an interface, so tests can pass a fake). */
export interface PushChannel {
  hasSubscribers(): boolean;
  sendFindings(intents: readonly NotificationIntent[]): Promise<DeliverySummary>;
  sendTrades(events: readonly TradePushEvent[]): Promise<DeliverySummary>;
  sendAlert(title: string, detail: string): Promise<DeliverySummary>;
  sendSystem(title: string, detail: string, everyone?: boolean): Promise<DeliverySummary>;
}

export interface DispatcherOptions {
  discordWebhookUrl: string | null;
  store: StateStore;
  /** Web Push, or null/undefined to leave it out. */
  push?: PushChannel | null;
  now?: () => Ms;
  fetchImpl?: typeof fetch;
}

function pushResult(summary: DeliverySummary): SendResult {
  if (summary.delivered > 0 || summary.failed === 0) return { ok: true };
  return { ok: false, error: summary.error ?? 'push delivery failed' };
}

interface Queued {
  intent: NotificationIntent;
}

const KIND_LABEL: Record<NotificationIntent['kind'], string> = {
  opened: 'OPENED',
  escalated: 'ESCALATED',
  grew: 'GREW',
  resolved: 'RESOLVED',
};

const ICON: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };

function toEmbed(intent: NotificationIntent): DiscordEmbed {
  return {
    title: `${ICON[intent.severity]} ${KIND_LABEL[intent.kind]} · ${intent.title}`,
    description: intent.detail,
    severity: intent.severity,
  };
}

export class Dispatcher {
  readonly #o: DispatcherOptions;
  readonly #now: () => Ms;
  readonly #fetch: typeof fetch;
  readonly #sent: Record<Channel, Ms[]> = { discord: [], push: [] };
  readonly #queue: Record<Channel, Queued[]> = { discord: [], push: [] };
  #flushing = false;

  constructor(options: DispatcherOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    options.store.update((s) => {
      s.notifier.discord = options.discordWebhookUrl !== null;
    });
  }

  get configured(): boolean {
    return this.#o.discordWebhookUrl !== null || this.#pushReady();
  }

  #pushReady(): boolean {
    return this.#o.push?.hasSubscribers() === true;
  }

  /** Queues the intents and sends what the rate cap allows. */
  async dispatch(intents: readonly NotificationIntent[]): Promise<void> {
    for (const intent of intents) {
      if (this.#o.discordWebhookUrl !== null) this.#queue.discord.push({ intent });
    }
    if (intents.length > 0 && this.#pushReady()) for (const intent of intents) this.#queue.push.push({ intent });
    await this.flush();
  }

  /** Trade entries and exits (Web Push only; already deduplicated and collapsed upstream). */
  async notifyTrades(events: readonly TradePushEvent[]): Promise<void> {
    const push = this.#o.push;
    if (events.length === 0 || push == null || !push.hasSubscribers()) return;
    await this.#deliver('push', 'trade', events[0]?.key ?? null, 'info', async () =>
      pushResult(await push.sendTrades(events)),
    );
  }

  async flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      await this.#flushChannel('discord');
      await this.#flushChannel('push');
    } finally {
      this.#flushing = false;
    }
  }

  pending(): number {
    return this.#queue.discord.length + this.#queue.push.length;
  }

  /** "freqdash started" on boot. Counts against the channel cap like any other message. */
  async sendStartup(): Promise<void> {
    await this.#sendDirect('started', 'freqdash started', 'Monitoring is running.', 'info', false);
  }

  /**
   * Safety alert (the killswitch): critical, to every configured channel, never queued behind the rate cap.
   * Returns true when at least one channel accepted it.
   */
  async alert(title: string, detail: string): Promise<boolean> {
    const results = await this.#sendDirect('alert', title, detail, 'critical', false);
    return results.some((r) => r.ok);
  }

  /** Test button. Bypasses the cap (a person pressed it) and reports the outcome. */
  async sendTest(): Promise<SendResult> {
    const results = await this.#sendDirect(
      'test',
      'test notification',
      'This is a test from the Status page.',
      'info',
      true,
    );
    const failed = results.find((r) => !r.ok);
    if (results.length === 0) return { ok: false, error: 'no notification channel is configured' };
    return failed ?? { ok: true };
  }

  /** `everyone`: a push goes to every device regardless of its preferences (the test button). */
  async #sendDirect(
    kind: string,
    title: string,
    detail: string,
    severity: Severity,
    everyone: boolean,
  ): Promise<SendResult[]> {
    const results: SendResult[] = [];
    const push = this.#o.push;
    if (push != null && push.hasSubscribers()) {
      results.push(
        await this.#deliver('push', kind, null, severity, async () =>
          pushResult(
            kind === 'alert' ? await push.sendAlert(title, detail) : await push.sendSystem(title, detail, everyone),
          ),
        ),
      );
    }
    if (this.#o.discordWebhookUrl !== null) {
      results.push(
        await this.#deliver('discord', kind, null, severity, () =>
          sendDiscord(
            this.#o.discordWebhookUrl as string,
            `${PREFIX} ${title}`,
            [{ title, description: detail, severity }],
            this.#fetch,
          ),
        ),
      );
    }
    return results;
  }

  #room(channel: Channel): number {
    const now = this.#now();
    const recent = this.#sent[channel].filter((t) => now - t < WINDOW_MS);
    this.#sent[channel] = recent;
    return CHANNEL_CAP_PER_MIN - recent.length;
  }

  async #flushChannel(channel: Channel): Promise<void> {
    const queue = this.#queue[channel];
    while (queue.length > 0 && this.#room(channel) > 0) {
      if (channel === 'push') {
        const push = this.#o.push;
        const intents = queue.splice(0, DISCORD_MAX_EMBEDS).map((b) => b.intent);
        if (push == null) continue;
        const worst = intents.reduce<Severity>((acc, i) => (rank(i.severity) > rank(acc) ? i.severity : acc), 'info');
        await this.#deliver('push', 'batch', intents[0]?.fingerprint ?? null, worst, async () =>
          pushResult(await push.sendFindings(intents)),
        );
      } else if (channel === 'discord') {
        const batch = queue.splice(0, DISCORD_MAX_EMBEDS);
        const intents = batch.map((b) => b.intent);
        const worst = intents.reduce<Severity>((acc, i) => (rank(i.severity) > rank(acc) ? i.severity : acc), 'info');
        const head =
          intents.length === 1 ? (intents[0] as NotificationIntent).title : `${intents.length} findings changed`;
        await this.#deliver('discord', 'batch', intents[0]?.fingerprint ?? null, worst, () =>
          sendDiscord(this.#o.discordWebhookUrl as string, `${PREFIX} ${head}`, intents.map(toEmbed), this.#fetch),
        );
      }
    }
  }

  async #deliver(
    channel: Channel,
    kind: string,
    fingerprint: string | null,
    severity: Severity,
    send: () => Promise<SendResult>,
  ): Promise<SendResult> {
    const at = this.#now();
    this.#sent[channel].push(at);
    let result: SendResult;
    try {
      result = await send();
    } catch (err) {
      result = { ok: false, error: describeError(err) };
    }
    const error = result.ok ? null : redactSecrets(result.error ?? 'unknown error');
    try {
      logNotification({ at, channel, fingerprint, kind, severity, ok: result.ok, error });
    } catch (err) {
      log.warn('could not log notification', { err: describeError(err) });
    }
    this.#o.store.update((s) => {
      if (result.ok) {
        s.notifier.lastSentAt = at;
        s.notifier.consecutiveFailures = 0;
      } else {
        s.notifier.lastError = error;
        s.notifier.consecutiveFailures += 1;
      }
    });
    if (!result.ok) {
      log.warn('notification failed', { channel, error });
    }
    return result;
  }
}

function rank(s: Severity): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}
