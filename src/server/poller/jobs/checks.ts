import { CADENCE_MS, SCHEDULER } from '@/shared/constants';
import type { Asset, BotEvent, Ms } from '@/shared/types/domain';
import type { CheckInput, KrakenCheckView } from '../../checks/types';
import { DEFAULT_CHECK_CONFIG } from '../../checks/config';
import { evaluateDetailed } from '../../checks/engine';
import { applyLifecycle } from '../../checks/lifecycle';
import { coveredByAcks } from '../../checks/util';
import {
  deleteFindings,
  getKnownOrders,
  listAcks,
  listEvents,
  listFindings,
  listKrakenOrders,
  saveLifecycle,
} from '../../db';
import { describeError, log } from '../../log';
import { pricesOf, type PollerContext } from '../context';
import { krakenMode } from '../mode';

// checks.evaluate (docs/PLAN.md section 6.4): builds the CheckInput from the store and the database, runs the rules,
// applies the lifecycle, persists it and hands the notification intents to the dispatcher.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function buildCheckInput(ctx: PollerContext, now: Ms): CheckInput {
  const s = ctx.store.get();
  const { mode } = krakenMode(s, now);

  const known: CheckInput['knownOrders'] = { ...getKnownOrders() };
  for (const bot of Object.values(s.bots)) {
    for (const t of [...bot.openTrades, ...bot.closedTrades]) {
      for (const o of t.orders) known[o.orderId] = { botId: bot.botId, tradeId: t.tradeId };
    }
  }

  const events = new Map<string, BotEvent>();
  for (const e of listEvents({ since: now - 2 * HOUR })) events.set(e.fingerprint, e);
  for (const e of listEvents({ since: now - 30 * DAY, types: ['order_created', 'order_canceled'] })) {
    events.set(e.fingerprint, e);
  }

  let kraken: KrakenCheckView | null = null;
  if (mode === 'kraken' && s.kraken.balances !== null && s.kraken.balancesAt !== null) {
    const orders = new Map(listKrakenOrders({ since: ctx.reconStartAt }).map((o) => [o.txid, o]));
    const open = s.kraken.openOrders ?? [];
    for (const o of open) orders.set(o.txid, o);
    kraken = {
      balances: s.kraken.balances,
      balancesAt: s.kraken.balancesAt,
      openOrders: open,
      openOrdersAt: s.kraken.openOrdersAt ?? s.kraken.balancesAt,
      orders: [...orders.values()],
      backfillComplete: s.kraken.backfillComplete,
      feeTier: s.kraken.feeTier,
      errors: s.kraken.errors,
      permissionDenied: s.kraken.permissionDenied,
    };
  }

  const prices: Record<Asset, number> = pricesOf(s);
  return {
    now,
    cfg: DEFAULT_CHECK_CONFIG,
    reconStartAt: ctx.reconStartAt,
    bots: Object.values(s.bots).map((b) => ({
      botId: b.botId,
      name: b.name,
      health: b.health,
      firstFailureAt: b.firstFailureAt,
      lastStatusOkAt: b.lastStatusOkAt,
      lastTradesOkAt: b.lastTradesOkAt,
      config: b.config,
      openTrades: b.openTrades,
      closedTrades: b.closedTrades,
      wallet: b.wallet,
      whitelist: b.whitelist,
      logTail: b.logTail,
    })),
    kraken,
    prices,
    knownOrders: known,
    events: [...events.values()].sort((a, b) => a.at - b.at),
    acks: listAcks(now),
    clockSkewMs: s.market.clockSkewMs,
    notifierFailures: s.notifier.consecutiveFailures,
  };
}

export async function checksJob(ctx: PollerContext): Promise<void> {
  const now = ctx.now();
  try {
    const input = buildCheckInput(ctx, now);
    const evaluation = evaluateDetailed(input);
    const prev = [
      ...listFindings({ status: ['pending', 'active'] }),
      ...listFindings({ resolvedSince: now - DEFAULT_CHECK_CONFIG.reopenWindowMs }),
    ];
    const result = applyLifecycle(prev, evaluation.findings, now, DEFAULT_CHECK_CONFIG, {
      notifyMinSeverity: ctx.cfg.notify.minSeverity,
      clearNow: (f) => coveredByAcks(f, input.acks, now),
    });
    const saved = saveLifecycle(result.next);
    if (result.discardIds.length > 0) deleteFindings(result.discardIds);

    const intents = result.notifications.map((n) => ({
      ...n,
      findingId: n.findingId ?? saved.newIds[n.fingerprint] ?? null,
    }));
    ctx.store.update((s) => {
      s.monitor.lastEvalAt = now;
      s.monitor.rulesEvaluated = evaluation.rulesEvaluated;
      s.monitor.lastEvalError =
        evaluation.errors.length === 0
          ? null
          : evaluation.errors
              .map((e) => `${e.rule}: ${e.message}`)
              .join('; ')
              .slice(0, 300);
    });
    if (evaluation.errors.length > 0) log.warn('rules failed', { errors: evaluation.errors });
    await ctx.dispatcher.dispatch(intents);
  } catch (err) {
    const message = describeError(err);
    ctx.store.update((s) => {
      s.monitor.lastEvalError = message.slice(0, 300);
    });
    throw err;
  } finally {
    ctx.touchCycle();
  }
}

/** Registers the periodic evaluation and the debounced re-check after state changes. Returns the unsubscribe. */
export function registerChecksJob(ctx: PollerContext): () => void {
  ctx.scheduler.add({
    name: 'checks.evaluate',
    cadenceMs: CADENCE_MS['checks.evaluate'],
    startDelayMs: 4000,
    run: () => checksJob(ctx),
  });
  let pending = false;
  return ctx.store.onRecheck(() => {
    if (pending) return;
    pending = true;
    // Debounce: many state changes arrive in bursts (a poll cycle), one evaluation is enough.
    setTimeout(() => {
      pending = false;
      ctx.trigger('checks.evaluate');
    }, SCHEDULER.checksDebounceMs).unref?.();
  });
}
