import { CADENCE_MS, sourceKey } from '@/shared/constants';
import type { BotEvent, BotId, Ms } from '@/shared/types/domain';
import { getMetaNumber, insertEvents, markOrdersSeen, setMeta } from '../../db';
import type { FtResult } from '../../freqtrade/client';
import {
  markUnreachable,
  normalizeConfig,
  normalizeHealth,
  normalizeLocks,
  normalizeTrades,
  normalizeWallet,
  normalizeWhitelist,
} from '../../freqtrade/normalize';
import { withPnl, pickMark } from '../../accounting';
import { eventFingerprint } from '../../logs/events';
import { describeError, log } from '../../log';
import { announceTrades } from '../../push/trades';
import { pricesOf, type PollerContext } from '../context';

// Freqtrade polling jobs (docs/PLAN.md section 6.4). They never throw for an unreachable bot: the health job is the
// detector and must keep its 10 s cadence while a bot restarts, so a failure is recorded on the source instead.

type JobKind = 'health' | 'status' | 'trades' | 'balance' | 'config' | 'whitelist' | 'plot_config' | 'locks';

const CADENCE: Record<JobKind, Ms> = {
  health: CADENCE_MS['ft.health'],
  status: CADENCE_MS['ft.status'],
  trades: CADENCE_MS['ft.trades'],
  balance: CADENCE_MS['ft.balance'],
  config: CADENCE_MS['ft.config'],
  whitelist: CADENCE_MS['ft.whitelist'],
  plot_config: CADENCE_MS['ft.plot_config'],
  locks: CADENCE_MS['ft.locks'],
};

export const jobName = (kind: JobKind, botId: BotId): string => `ft.${kind}:${botId}`;

function persistEvents(events: readonly BotEvent[]): void {
  if (events.length === 0) return;
  try {
    insertEvents(events);
  } catch (err) {
    log.warn('could not store bot events', { err: describeError(err) });
  }
}

function botEvent(botId: BotId, type: BotEvent['type'], at: Ms, discriminator: string, message?: string): BotEvent {
  const event: BotEvent = {
    botId,
    at,
    type,
    source: 'health',
    fingerprint: eventFingerprint(botId, type, at, discriminator),
  };
  if (message !== undefined) event.message = message;
  return event;
}

/** Runs one GET, applies it, and records the outcome on the source. Returns whether the data was applied. */
async function poll<T>(
  ctx: PollerContext,
  botId: BotId,
  kind: JobKind,
  call: () => Promise<FtResult<T>>,
  apply: (data: T, fetchedAt: Ms) => void,
): Promise<boolean> {
  const bot = ctx.store.get().bots[botId];
  if (bot === undefined) return false;
  const key = sourceKey.bot(botId, kind);
  const label = `${bot.name} ${kind}`;
  const res = await call();
  if (!res.ok) {
    ctx.recordFail(key, label, CADENCE[kind], res.error.message);
    ctx.touchCycle();
    return false;
  }
  try {
    apply(res.data, res.fetchedAt);
  } catch (err) {
    ctx.recordFail(key, label, CADENCE[kind], `unexpected response: ${describeError(err)}`);
    ctx.touchCycle();
    return false;
  }
  ctx.recordOk(key, label, CADENCE[kind]);
  ctx.touchCycle();
  return true;
}

export async function healthJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  const bot = ctx.store.get().bots[botId];
  if (client === undefined || bot === undefined) return;
  const key = sourceKey.bot(botId, 'health');
  const label = `${bot.name} health`;
  const res = await client.health();
  const at = ctx.now();

  if (!res.ok) {
    const wasReachable = bot.health === null || bot.health.reachable;
    const authFailed = res.error.kind === 'auth';
    ctx.store.update((s) => {
      const b = s.bots[botId];
      if (b === undefined) return;
      b.health = markUnreachable(b.health, at, authFailed);
      b.firstFailureAt ??= at;
    });
    if (wasReachable) persistEvents([botEvent(botId, 'unreachable', at, res.error.kind, res.error.message)]);
    ctx.recordFail(key, label, CADENCE.health, res.error.message);
    ctx.touchCycle();
    ctx.store.requestRecheck();
    return;
  }

  let health;
  try {
    health = normalizeHealth(res.data);
  } catch (err) {
    ctx.recordFail(key, label, CADENCE.health, `unexpected response: ${describeError(err)}`);
    ctx.touchCycle();
    return;
  }

  const events: BotEvent[] = [];
  const prev = bot.health;
  if (prev !== null && !prev.reachable) events.push(botEvent(botId, 'recovered', at, 'health'));

  const startupKey = `bot:${botId}:startup_at`;
  const startKey = `bot:${botId}:start_at`;
  const prevStartup = getMetaNumber(startupKey) ?? prev?.botStartupAt ?? null;
  const prevStart = getMetaNumber(startKey) ?? prev?.botStartAt ?? null;
  let restarted = false;
  if (health.botStartupAt !== null && prevStartup !== null && health.botStartupAt !== prevStartup) {
    events.push(botEvent(botId, 'startup', health.botStartupAt, 'health'));
    restarted = true;
  }
  if (health.botStartAt !== null && prevStart !== null && health.botStartAt !== prevStart) {
    events.push(botEvent(botId, 'identity_changed', at, `start_at:${health.botStartAt}`, 'bot_start_ts changed'));
  }
  try {
    if (health.botStartupAt !== null) setMeta(startupKey, health.botStartupAt);
    if (health.botStartAt !== null) setMeta(startKey, health.botStartAt);
  } catch (err) {
    log.warn('could not persist bot start markers', { err: describeError(err) });
  }
  persistEvents(events);

  ctx.store.update((s) => {
    const b = s.bots[botId];
    if (b === undefined) return;
    b.health = health;
    b.firstFailureAt = null;
  });
  ctx.recordOk(key, label, CADENCE.health);
  ctx.touchCycle();
  ctx.store.requestRecheck();

  if (restarted) {
    for (const kind of ['config', 'whitelist', 'plot_config', 'locks'] as const) ctx.trigger(jobName(kind, botId));
    ctx.trigger(jobName('status', botId));
    ctx.trigger(jobName('trades', botId));
  }
}

export async function statusJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'status',
    () => client.status(),
    (data, fetchedAt) => {
      const prices = pricesOf(ctx.store.get());
      const open = normalizeTrades(botId, data, { isOpen: true }).map((t) => withPnl(t, pickMark(t, prices)));
      const before = ctx.store.get().bots[botId]?.openTrades ?? [];
      const now = ctx.now();
      const orders = open.flatMap((t) => t.orders);
      try {
        markOrdersSeen(orders, now);
      } catch (err) {
        log.warn('could not store seen orders', { err: describeError(err) });
      }
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b === undefined) return;
        b.openTrades = open;
        b.lastStatusOkAt = fetchedAt;
      });
      const stillOpen = new Set(open.map((t) => t.tradeId));
      if (before.some((t) => !stillOpen.has(t.tradeId))) ctx.trigger(jobName('trades', botId));
      ctx.recompute();
      ctx.store.requestRecheck();
      void announceTrades(ctx.dispatcher, botId, ctx.store.get().bots[botId]?.name ?? botId, open, now);
    },
  );
}

export async function tradesJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'trades',
    () => client.trades(),
    (data, fetchedAt) => {
      const closed = normalizeTrades(botId, data, { isOpen: false }).map((t) => withPnl(t, null));
      const now = ctx.now();
      try {
        markOrdersSeen(
          closed.flatMap((t) => t.orders),
          now,
        );
        const maxKey = `bot:${botId}:max_closed_trades`;
        const max = getMetaNumber(maxKey);
        if (max !== null && closed.length < max) {
          persistEvents([
            botEvent(botId, 'identity_changed', now, `closed:${max}->${closed.length}`, 'closed-trade count decreased'),
          ]);
        }
        setMeta(maxKey, closed.length);
      } catch (err) {
        log.warn('could not track closed trades', { err: describeError(err) });
      }
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b === undefined) return;
        b.closedTrades = closed;
        b.lastTradesOkAt = fetchedAt;
      });
      ctx.recompute();
      ctx.store.requestRecheck();
      void announceTrades(ctx.dispatcher, botId, ctx.store.get().bots[botId]?.name ?? botId, closed, now);
    },
  );
}

export async function balanceJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'balance',
    () => client.balance(),
    (data, fetchedAt) => {
      const synced = ctx.store.get().bots[botId]?.logTail.lastWalletSyncAt ?? null;
      const wallet = normalizeWallet(botId, data, { fetchedAt, lastWalletSyncAt: synced });
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b !== undefined) b.wallet = wallet;
      });
      ctx.recompute();
      ctx.store.requestRecheck();
    },
  );
}

export async function configJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'config',
    () => client.showConfig(),
    (data) => {
      const config = normalizeConfig(botId, data);
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b !== undefined) b.config = config;
      });
      ctx.store.requestRecheck();
    },
  );
}

export async function whitelistJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'whitelist',
    () => client.whitelist(),
    (data) => {
      const whitelist = normalizeWhitelist(data);
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b !== undefined) b.whitelist = whitelist;
      });
      ctx.store.requestRecheck();
    },
  );
}

export async function plotConfigJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'plot_config',
    () => client.plotConfig(),
    (data) => {
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b !== undefined) b.plotConfig = data;
      });
    },
  );
}

export async function locksJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const client = ctx.ft.get(botId);
  if (client === undefined) return;
  await poll(
    ctx,
    botId,
    'locks',
    () => client.locks(),
    (data) => {
      const locks = normalizeLocks(data);
      ctx.store.update((s) => {
        const b = s.bots[botId];
        if (b !== undefined) b.locks = locks;
      });
    },
  );
}

const RUNNERS: Record<JobKind, (ctx: PollerContext, botId: BotId) => Promise<void>> = {
  health: healthJob,
  status: statusJob,
  trades: tradesJob,
  balance: balanceJob,
  config: configJob,
  whitelist: whitelistJob,
  plot_config: plotConfigJob,
  locks: locksJob,
};

/** Registers every freqtrade job of every configured bot. Config comes first so later jobs can rely on it. */
export function registerFreqtradeJobs(ctx: PollerContext): void {
  let n = 0;
  for (const botId of ctx.ft.keys()) {
    for (const kind of Object.keys(RUNNERS) as JobKind[]) {
      const run = RUNNERS[kind];
      ctx.scheduler.add({
        name: jobName(kind, botId),
        cadenceMs: CADENCE[kind],
        startDelayMs: (kind === 'health' || kind === 'config' ? 0 : 300) + (n % 10) * 50,
        run: () => run(ctx, botId),
      });
    }
    n += 1;
  }
}
