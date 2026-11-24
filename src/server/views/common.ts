import { CADENCE_MS, MONITOR_STALLED_MS, toFreshness } from '@/shared/constants';
import type { BotStatusPill, FindingLite, OrderMatch, SummaryResponse } from '@/shared/types/api';
import type { BotEvent, BotId, BotOrder, Freshness, KrakenOrder, Ms, Severity, SourceKey } from '@/shared/types/domain';
import type { Finding } from '@/shared/types/findings';
import type { AppState, BotRuntime } from '@/shared/types/state';
import { clusterStarts } from '../checks/util';
import { DEFAULT_CHECK_CONFIG } from '../checks/config';
import { getConfig } from '../config';
import { getMetaNumber } from '../db';
import { killswitchStatus } from '../killswitch/service';
import type { KillswitchInfo } from '@/shared/types/api';
import { krakenMode, type Mode } from '../poller/mode';
import { getStore } from '../state/store';

// Shared pieces of the API views (docs/PLAN.md section 5.3). Views are functions of a ViewContext, so tests can hand
// them a seeded state; the route handlers build the real one with currentViewContext().

export interface ViewContext {
  state: Readonly<AppState>;
  now: Ms;
  kraken: { configured: boolean; tier: string; reconStartAt: Ms | null };
  killswitchMode: 'off' | 'dry-run' | 'armed';
}

export function currentViewContext(): ViewContext {
  const cfg = getConfig();
  return {
    state: getStore().get(),
    now: Date.now(),
    kraken: {
      configured: cfg.kraken.enabled,
      tier: cfg.kraken.tier,
      reconStartAt: cfg.reconStartAt ?? getMetaNumber('recon_start_at'),
    },
    killswitchMode: cfg.killswitch.mode,
  };
}

export function modeOf(ctx: ViewContext): { mode: Mode; reason: string | null } {
  return krakenMode(ctx.state, ctx.now);
}

/** Freshness of the sources whose key satisfies `filter` (all of them by default), computed at response time. */
export function freshnessOf(ctx: ViewContext, filter: (key: SourceKey) => boolean = () => true): Freshness[] {
  return Object.values(ctx.state.sources)
    .filter((s) => filter(s.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((s) => toFreshness(s.key, s.label, { ...s }, ctx.now));
}

export function botSourceKeys(botId: BotId): (key: SourceKey) => boolean {
  return (key) => key.startsWith(`bot:${botId}:`) || key === `logtail:${botId}`;
}

export function botSources(ctx: ViewContext, botId: BotId): SourceKey[] {
  return Object.keys(ctx.state.sources).filter(botSourceKeys(botId)).sort();
}

const STARTING_MS = 2 * 60_000;
const DOWN_MS = 30_000;

/** auth_error > down (unreachable >= 30 s) > restarting (startup < 2 min or a restart loop) > stale > stopped > running. */
export function botStatus(bot: BotRuntime, now: Ms, restartLoop: boolean): BotStatusPill {
  const h = bot.health;
  if (h === null) return 'unknown';
  if (h.authFailed) return 'auth_error';
  if (!h.reachable) return h.unreachableSince !== null && now - h.unreachableSince >= DOWN_MS ? 'down' : 'restarting';
  if (restartLoop || (h.botStartupAt !== null && now - h.botStartupAt < STARTING_MS)) return 'restarting';
  if (h.lastProcessAt !== null && now - h.lastProcessAt > DEFAULT_CHECK_CONFIG.staleProcessWarnMs) return 'stale';
  if (bot.config !== null && bot.config.state !== 'running') return 'stopped';
  return 'running';
}

export const isLoopFinding = (f: Finding, botId: BotId): boolean =>
  f.rule === 'BOT_RESTART_LOOP' && f.subject.botId === botId && f.status === 'active';

export function toLite(f: Finding): FindingLite {
  return {
    id: f.id,
    rule: f.rule,
    severity: f.severity,
    title: f.title,
    subject: f.subject,
    activeSince: f.activeSince,
  };
}

const RANK: Record<Severity, number> = { critical: 2, warning: 1, info: 0 };

/** Open (active) findings the app shows: not pending, not resolved. Most severe first. */
export function shownFindings(active: readonly Finding[]): { open: Finding[]; silenced: Finding[] } {
  const open: Finding[] = [];
  const silenced: Finding[] = [];
  for (const f of active) {
    if (f.status !== 'active') continue;
    (f.silenced === null ? open : silenced).push(f);
  }
  const bySeverity = (a: Finding, b: Finding): number =>
    RANK[b.severity] - RANK[a.severity] || b.lastSeenAt - a.lastSeenAt;
  return { open: open.sort(bySeverity), silenced: silenced.sort(bySeverity) };
}

export function countBySeverity(findings: readonly Finding[]): { critical: number; warning: number; info: number } {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

export function monitorOf(ctx: ViewContext): SummaryResponse['monitor'] {
  const m = ctx.state.monitor;
  return {
    startedAt: m.startedAt,
    lastCycleAt: m.lastCycleAt,
    lastEvalAt: m.lastEvalAt,
    stalled: m.lastCycleAt === null || ctx.now - m.lastCycleAt > MONITOR_STALLED_MS,
  };
}

/** Distinct restarts of a bot in the last 24 h: startup events closer than the cluster gap are one restart. */
export function restarts24h(events: readonly BotEvent[], botId: BotId, now: Ms): number {
  const times = events
    .filter((e) => e.botId === botId && e.type === 'startup' && now - e.at <= 24 * 3_600_000)
    .map((e) => e.at);
  return clusterStarts(times, DEFAULT_CHECK_CONFIG.restartClusterMs).length;
}

/** Bot order against Kraken (docs/PLAN.md section 5.3 `OrderMatch`). `unknown` without Kraken data. */
export function matchOrder(
  order: BotOrder,
  kraken: ReadonlyMap<string, KrakenOrder> | null,
  reconStartAt: Ms | null,
): OrderMatch {
  if (kraken === null) return 'unknown';
  const k = kraken.get(order.orderId);
  if (k === undefined) {
    if (order.filled <= 0 || order.placedAt === null) return 'unknown';
    // Orders from before reconciliation started are not in the persisted list on purpose.
    return reconStartAt !== null && order.placedAt >= reconStartAt ? 'missing' : 'unknown';
  }
  const tolerance = Math.max(1e-7, 0.002 * k.vol);
  if (Math.abs(order.filled - k.volExec) > tolerance) return 'mismatch';
  if (order.isOpen && (k.status === 'closed' || k.status === 'canceled' || k.status === 'expired')) return 'mismatch';
  return 'matched';
}

export const cadence = CADENCE_MS;

export function killswitchOf(ctx: ViewContext): KillswitchInfo {
  const s = killswitchStatus(ctx.killswitchMode);
  const t = s.tripped;
  return {
    mode: s.mode,
    resetAt: s.resetAt,
    tripped:
      t === null
        ? null
        : {
            at: t.at,
            dryRun: t.dryRun,
            rule: t.rule,
            pair: t.pair,
            count: t.count,
            max: t.max,
            windowMs: t.windowMs,
            bots: Object.entries(t.bots).map(([botId, b]) => ({
              botId,
              container: b.container,
              status: b.status,
              attempts: b.attempts,
              message: b.message,
            })),
          },
  };
}
