import type { BotId, Ms } from '@/shared/types/domain';
import type { PollerContext } from '../poller/context';
import { krakenMode } from '../poller/mode';
import { getMeta, listAcks, listKrakenOrders, setMeta } from '../db';
import { describeError, log } from '../log';
import { stopContainer, type StopResult } from './agentClient';
import { detectBurst, type Trip } from './detect';

// Killswitch (docs/RUNBOOK.md "Killswitch"). Watches the Kraken order stream for a runaway buyer; on a trip it latches,
// sends a critical push and (when armed) asks the killswitch agent to stop the bots' containers. It never starts a
// container again: after a trip a person decides when to reset and restart.

const STATE_KEY = 'killswitch_state';
export const MAX_STOP_ATTEMPTS = 5;
const RETRY_GAP_MS = 5_000;

export type BotStopStatus = 'pending' | 'stopped' | 'failed' | 'not-stoppable';

export interface BotStop {
  container: string | null;
  status: BotStopStatus;
  attempts: number;
  lastAttemptAt: Ms | null;
  message: string | null;
}

export interface TripRecord {
  at: Ms;
  dryRun: boolean;
  rule: Trip['rule'];
  pair: string;
  count: number;
  max: number;
  windowMs: Ms;
  txids: string[];
  bots: Record<BotId, BotStop>;
}

export interface KillswitchState {
  tripped: TripRecord | null;
  resetAt: Ms | null;
}

export function loadState(): KillswitchState {
  try {
    const raw = getMeta(STATE_KEY);
    if (raw === null) return { tripped: null, resetAt: null };
    const parsed = JSON.parse(raw) as Partial<KillswitchState>;
    return { tripped: parsed.tripped ?? null, resetAt: parsed.resetAt ?? null };
  } catch {
    return { tripped: null, resetAt: null };
  }
}

function saveState(state: KillswitchState): void {
  setMeta(STATE_KEY, JSON.stringify(state));
}

/** Clears the latch. Only orders opened after this moment count towards the next trip. Bots stay stopped. */
export function resetKillswitch(now: Ms): void {
  saveState({ tripped: null, resetAt: now });
}

export interface KillswitchStatus {
  mode: 'off' | 'dry-run' | 'armed';
  tripped: TripRecord | null;
  resetAt: Ms | null;
}

export function killswitchStatus(mode: KillswitchStatus['mode']): KillswitchStatus {
  const s = loadState();
  return { mode, tripped: s.tripped, resetAt: s.resetAt };
}

export type StopFn = (container: string) => Promise<StopResult>;

/** Bots that trade `pair` (whitelist or an open trade); every bot when none is attributable. */
export function targetBots(ctx: PollerContext, pair: string): BotId[] {
  const bots = Object.values(ctx.store.get().bots);
  const trading = bots.filter((b) => b.whitelist.includes(pair) || b.openTrades.some((t) => t.pair === pair));
  return (trading.length > 0 ? trading : bots).map((b) => b.botId);
}

function describeTrip(t: TripRecord): string {
  const window = t.windowMs >= 60_000 ? `${Math.round(t.windowMs / 60_000)} min` : `${Math.round(t.windowMs / 1000)} s`;
  return `${t.count} buys of ${t.pair} on Kraken within ${window} (limit ${t.max}).`;
}

function outcome(t: TripRecord): string {
  if (t.dryRun) return 'DRY RUN: nothing was stopped.';
  return Object.entries(t.bots)
    .map(
      ([id, b]) =>
        `${id}: ${b.status === 'not-stoppable' ? 'no container configured, stop it yourself' : b.status}${b.message && b.status === 'failed' ? ` (${b.message})` : ''}`,
    )
    .join('; ');
}

async function attemptStops(ctx: PollerContext, record: TripRecord, stop: StopFn): Promise<void> {
  for (const [botId, b] of Object.entries(record.bots)) {
    if (b.status === 'stopped' || b.status === 'not-stoppable' || b.container === null) continue;
    if (b.attempts >= MAX_STOP_ATTEMPTS) continue;
    if (b.lastAttemptAt !== null && ctx.now() - b.lastAttemptAt < RETRY_GAP_MS) continue;
    const res = await stop(b.container);
    record.bots[botId] = {
      ...b,
      attempts: b.attempts + 1,
      lastAttemptAt: ctx.now(),
      status: res.ok ? 'stopped' : 'failed',
      message: res.message,
    };
  }
}

/** One evaluation. Safe to call often; single trip per latch. */
export async function evaluateKillswitch(ctx: PollerContext, stop?: StopFn): Promise<void> {
  const ks = ctx.cfg.killswitch;
  if (ks.mode === 'off') return;
  const stopper: StopFn = stop ?? ((container) => stopContainer(ks.agentUrl ?? '', ks.token ?? '', container));
  const state = loadState();

  if (state.tripped !== null) {
    const t = state.tripped;
    if (ks.mode === 'armed' && !t.dryRun) {
      const before = JSON.stringify(t.bots);
      await attemptStops(ctx, t, stopper);
      if (JSON.stringify(t.bots) !== before) {
        saveState(state);
        const done = Object.values(t.bots).every(
          (b) => b.status === 'stopped' || b.status === 'not-stoppable' || b.attempts >= MAX_STOP_ATTEMPTS,
        );
        if (done) await ctx.dispatcher.alert('Killswitch: stop result', outcome(t));
      }
    }
    return;
  }

  const now = ctx.now();
  const s = ctx.store.get();
  // Kraken is the source of truth. Without fresh Kraken data the killswitch is blind; the KRAKEN_ERROR and mode
  // banners already say so.
  if (krakenMode(s, now).mode !== 'kraken') return;

  const floor = Math.max(ctx.reconStartAt, state.resetAt ?? 0, now - ks.windowLongMs - 60_000);
  const byTxid = new Map(listKrakenOrders({ since: floor }).map((o) => [o.txid, o]));
  for (const o of s.kraken.openOrders ?? []) if (o.openedAt >= floor) byTxid.set(o.txid, o);
  const acked = new Set(listAcks(now, { kind: 'kraken_order' }).map((a) => a.subject));

  const trips = detectBurst([...byTxid.values()], ks, (o) => acked.has(o.txid) || o.openedAt < floor);
  const trip = trips[0];
  if (trip === undefined) return;

  const dryRun = ks.mode === 'dry-run';
  const bots: Record<BotId, BotStop> = {};
  for (const id of targetBots(ctx, trip.pair)) {
    const container = ctx.cfg.bots.find((b) => b.id === id)?.container ?? null;
    bots[id] = {
      container,
      status: container === null ? 'not-stoppable' : 'pending',
      attempts: 0,
      lastAttemptAt: null,
      message: null,
    };
  }
  const record: TripRecord = {
    at: now,
    dryRun,
    rule: trip.rule,
    pair: trip.pair,
    count: trip.count,
    max: trip.max,
    windowMs: trip.windowMs,
    txids: trip.txids,
    bots,
  };
  // Latch first: even if everything after this fails, the trip is recorded and not repeated.
  saveState({ tripped: record, resetAt: state.resetAt });
  log.error('killswitch tripped', { pair: trip.pair, count: trip.count, rule: trip.rule, dryRun });

  await ctx.dispatcher.alert(
    dryRun ? 'Killswitch would trip (dry run)' : 'KILLSWITCH TRIPPED: stopping bots',
    `${describeTrip(record)} Bots: ${Object.keys(bots).join(', ') || 'none'}.`,
  );
  if (!dryRun) {
    try {
      await attemptStops(ctx, record, stopper);
    } catch (err) {
      log.error('killswitch stop failed', { err: describeError(err) });
    }
    saveState({ tripped: record, resetAt: state.resetAt });
    await ctx.dispatcher.alert('Killswitch: stop result', outcome(record));
  }
  ctx.store.requestRecheck();
}
