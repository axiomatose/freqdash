import type { BotId, Freshness, FreshnessState, Ms, SourceKey } from './types/domain';

export const APP_NAME = 'freqdash';
// Keep in sync with package.json (asserted in constants.test.ts).
export const APP_VERSION = '0.1.0';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Poller job cadences (docs/PLAN.md section 6.4 and the Kraken table in 6.3). */
export const CADENCE_MS = {
  'ft.health': 10 * SECOND,
  'ft.status': 15 * SECOND,
  'ft.trades': 60 * SECOND,
  'ft.balance': 60 * SECOND,
  'ft.config': 5 * MINUTE,
  'ft.whitelist': 10 * MINUTE,
  'ft.plot_config': 10 * MINUTE,
  'ft.locks': 5 * MINUTE,
  logtail: 5 * SECOND,
  'logtail.fallback': 20 * SECOND,
  'kraken.openOrders': 15 * SECOND,
  'kraken.balance': 30 * SECOND,
  'kraken.closedOrders': 30 * SECOND,
  'kraken.tradeVolume': 6 * HOUR,
  'kraken.ledgers': 30 * MINUTE,
  'market.ticker': 20 * SECOND,
  'market.time': 10 * MINUTE,
  'market.catalog': 24 * HOUR,
  'checks.evaluate': 10 * SECOND,
  'equity.snapshot': 5 * MINUTE,
  'signals.record': 5 * MINUTE,
  maintenance: 6 * HOUR,
} as const satisfies Record<string, Ms>;

export type JobName = keyof typeof CADENCE_MS;

/** Scheduler behaviour shared by every job: setTimeout chain with jitter and capped exponential backoff. */
export const SCHEDULER = {
  /** +-10 % on every delay. */
  jitterRatio: 0.1,
  /** Failure backoff is cadence * 2^failures, capped here. */
  maxBackoffMs: 5 * MINUTE,
  /** checks.evaluate runs this long after the last state change (and at least every CADENCE_MS['checks.evaluate']). */
  checksDebounceMs: 2 * SECOND,
} as const;

/** Freshness state thresholds, as multiples of a source's cadence. */
export const FRESHNESS = {
  freshMultiplier: 2,
  agingMultiplier: 5,
} as const;

/** `/api/v1/summary` marks monitoring as stalled when the last poller cycle is older than this. */
export const MONITOR_STALLED_MS = 60 * SECOND;

/** Dashboard-wide polling interval for the browser (TanStack Query refetchInterval). */
export const CLIENT_REFETCH_MS = 10 * SECOND;

export interface FreshnessInput {
  cadenceMs: number;
  lastOkAt: Ms | null;
  lastAttemptAt: Ms | null;
  consecutiveFailures: number;
  disabled?: boolean;
}

/**
 * Freshness state, computed at response time (docs/PLAN.md section 5.2):
 * disabled if not configured; fresh if age <= 2x cadence; aging if <= 5x; stale otherwise;
 * error if the last attempt failed and age > 2x cadence. A source that never succeeded has no age: it is
 * `error` when it has failed and `stale` otherwise.
 */
export function computeFreshnessState(input: FreshnessInput, now: Ms): FreshnessState {
  if (input.disabled) return 'disabled';
  const failing = input.consecutiveFailures > 0;
  if (input.lastOkAt === null) return failing ? 'error' : 'stale';
  const age = Math.max(0, now - input.lastOkAt);
  const fresh = input.cadenceMs * FRESHNESS.freshMultiplier;
  if (age <= fresh) return 'fresh';
  if (failing) return 'error';
  return age <= input.cadenceMs * FRESHNESS.agingMultiplier ? 'aging' : 'stale';
}

export function toFreshness(
  source: SourceKey,
  label: string,
  input: FreshnessInput & { error?: string | null },
  now: Ms,
): Freshness {
  return {
    source,
    label,
    cadenceMs: input.cadenceMs,
    lastOkAt: input.lastOkAt,
    lastAttemptAt: input.lastAttemptAt,
    consecutiveFailures: input.consecutiveFailures,
    error: input.error ?? null,
    state: computeFreshnessState(input, now),
  };
}

/** Canonical SourceKey builders so the poller, the views and the UI agree on names. */
export const sourceKey = {
  bot: (
    botId: BotId,
    job: 'health' | 'status' | 'trades' | 'balance' | 'config' | 'whitelist' | 'plot_config' | 'locks',
  ): SourceKey => `bot:${botId}:${job}`,
  logtail: (botId: BotId): SourceKey => `logtail:${botId}`,
  kraken: (job: 'balance' | 'openOrders' | 'closedOrders' | 'tradeVolume' | 'ledgers'): SourceKey => `kraken:${job}`,
  market: (job: 'ticker' | 'time' | 'catalog'): SourceKey => `market:${job}`,
} as const;
