import { CADENCE_MS, sourceKey } from '@/shared/constants';
import type { BotEvent, BotId } from '@/shared/types/domain';
import { getCursor, getKnownOrders, insertEvents, saveCursor } from '../../db';
import { createParserState, extractEvents } from '../../logs/events';
import { parseApiLogs, type LogRecord } from '../../logs/parser';
import { describeError, log } from '../../log';
import type { PollerContext } from '../context';

// Log ingestion (docs/PLAN.md section 6.2): tail the bot's logfile every 5 s; without a readable file fall back to the
// `/logs` API every 20 s (the LOG_TAIL_UNAVAILABLE rule reports the degraded mode).

export const jobName = (botId: BotId): string => `logtail:${botId}`;
const FALLBACK_LIMIT = 1000;

function ingest(ctx: PollerContext, botId: BotId, records: LogRecord[], source: BotEvent['source']): void {
  const now = ctx.now();
  const result = extractEvents(botId, records, source, ctx.parserStates.get(botId) ?? createParserState());
  ctx.parserStates.set(botId, result.state);
  if (result.events.length > 0) {
    try {
      insertEvents(result.events);
    } catch (err) {
      log.warn('could not store log events', { botId, err: describeError(err) });
    }
  }
  ctx.store.update((s) => {
    const b = s.bots[botId];
    if (b === undefined) return;
    b.logTail.lastLineAt = result.lastLineAt ?? b.logTail.lastLineAt;
    b.logTail.lastWalletSyncAt = result.lastWalletSyncAt ?? b.logTail.lastWalletSyncAt;
    b.logTail.lastHeartbeatAt = result.lastHeartbeatAt ?? b.logTail.lastHeartbeatAt;
    if (b.wallet !== null && result.lastWalletSyncAt !== null) b.wallet.lastWalletSyncAt = result.lastWalletSyncAt;
  });

  // An order the bot logged but has not shown in its API yet: refresh the API state and ask Kraken about it now.
  const created = result.events.filter(
    (e) => e.type === 'order_created' && e.orderId !== undefined && now - e.at < 10 * 60_000,
  );
  if (created.length > 0) {
    const known = knownOrderIds(ctx);
    const unknown = created.flatMap((e) => (e.orderId !== undefined && !known.has(e.orderId) ? [e.orderId] : []));
    if (unknown.length > 0) {
      ctx.trigger(`ft.status:${botId}`);
      for (const id of unknown) ctx.queryQueue.add(id);
      if (ctx.kraken !== null) ctx.trigger('kraken.queryOrders');
    }
  }
  if (result.events.length > 0) ctx.store.requestRecheck();
}

function knownOrderIds(ctx: PollerContext): Set<string> {
  const ids = new Set<string>();
  try {
    for (const id of Object.keys(getKnownOrders())) ids.add(id);
  } catch (err) {
    log.warn('could not read known orders', { err: describeError(err) });
  }
  for (const bot of Object.values(ctx.store.get().bots)) {
    for (const trade of [...bot.openTrades, ...bot.closedTrades]) for (const o of trade.orders) ids.add(o.orderId);
  }
  return ids;
}

async function fallback(ctx: PollerContext, botId: BotId, reason: string | null): Promise<void> {
  const client = ctx.ft.get(botId);
  const key = sourceKey.logtail(botId);
  const label = `${ctx.store.get().bots[botId]?.name ?? botId} log tail`;
  if (client === undefined) return;
  const res = await client.logs(FALLBACK_LIMIT);
  if (!res.ok) {
    ctx.recordFail(key, label, CADENCE_MS['logtail.fallback'], res.error.message);
    ctx.store.update((s) => {
      const b = s.bots[botId];
      if (b !== undefined) b.logTail.error = reason ?? res.error.message;
    });
    return;
  }
  ingest(ctx, botId, parseApiLogs(res.data), 'api-logs');
  ctx.store.update((s) => {
    const b = s.bots[botId];
    if (b === undefined) return;
    b.logTail.available = false;
    b.logTail.error = reason;
  });
  ctx.recordOk(key, label, CADENCE_MS['logtail.fallback']);
}

const lastFallbackAt = new Map<BotId, number>();

export async function logtailJob(ctx: PollerContext, botId: BotId): Promise<void> {
  const tailer = ctx.tailers.get(botId);
  const key = sourceKey.logtail(botId);
  const label = `${ctx.store.get().bots[botId]?.name ?? botId} log tail`;

  if (tailer === undefined) {
    const now = ctx.now();
    if (now - (lastFallbackAt.get(botId) ?? 0) >= CADENCE_MS['logtail.fallback']) {
      lastFallbackAt.set(botId, now);
      await fallback(ctx, botId, null);
    }
    ctx.touchCycle();
    return;
  }

  const poll = await tailer.poll(getCursor(botId));
  if (poll.error !== undefined) {
    ctx.store.update((s) => {
      const b = s.bots[botId];
      if (b === undefined) return;
      b.logTail.available = false;
      b.logTail.error = poll.error ?? null;
    });
    ctx.recordFail(key, label, CADENCE_MS.logtail, poll.error);
    const now = ctx.now();
    if (now - (lastFallbackAt.get(botId) ?? 0) >= CADENCE_MS['logtail.fallback']) {
      lastFallbackAt.set(botId, now);
      await fallback(ctx, botId, poll.error);
    }
    ctx.touchCycle();
    return;
  }

  ingest(ctx, botId, poll.records, 'logfile');
  if (poll.cursor !== null) {
    try {
      saveCursor({ botId, ...poll.cursor }, ctx.now());
    } catch (err) {
      log.warn('could not save log cursor', { botId, err: describeError(err) });
    }
  }
  ctx.store.update((s) => {
    const b = s.bots[botId];
    if (b === undefined) return;
    b.logTail.available = true;
    b.logTail.error = null;
  });
  ctx.recordOk(key, label, CADENCE_MS.logtail);
  ctx.touchCycle();
  if (poll.more) ctx.trigger(jobName(botId));
}

export function registerLogJobs(ctx: PollerContext): void {
  let n = 0;
  for (const botId of ctx.ft.keys()) {
    ctx.scheduler.add({
      name: jobName(botId),
      cadenceMs: CADENCE_MS.logtail,
      startDelayMs: 200 + n * 100,
      run: () => logtailJob(ctx, botId),
    });
    n += 1;
  }
}
