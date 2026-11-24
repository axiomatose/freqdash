import 'server-only';
import type { Clock, KrakenPrivateMethod, KrakenTier, Sleep } from './types';

/** Kraken's per-key call counter per verification tier (docs/PLAN.md section 6.3). */
export const KRAKEN_TIER_LIMITS: Readonly<Record<KrakenTier, { max: number; decayPerSec: number }>> = {
  starter: { max: 15, decayPerSec: 0.33 },
  intermediate: { max: 20, decayPerSec: 0.5 },
  pro: { max: 20, decayPerSec: 1 },
};

/** Points we never spend, so a bot-side burst on a shared account (or our own estimate drifting) cannot trip Kraken. */
export const RATE_LIMIT_RESERVE = 3;
export const BACKOFF_INITIAL_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;

/** Ledgers costs 2, every other allowlisted method 1. */
export function krakenCost(method: KrakenPrivateMethod): number {
  return method === 'Ledgers' ? 2 : 1;
}

export interface KrakenRateLimiterOptions {
  tier: KrakenTier;
  reserve?: number;
  now?: Clock;
  sleep?: Sleep;
}

const EPSILON = 1e-9;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Local mirror of Kraken's counter: every call adds its cost, the counter decays continuously, and Kraken rejects
 * calls that would push it past `max`. We stay `reserve` points below that.
 */
export class KrakenRateLimiter {
  readonly max: number;
  readonly decayPerSec: number;
  readonly reserve: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private counter = 0;
  private counterAt: number;
  private backoffUntil = 0;
  private penalties = 0;

  constructor(options: KrakenRateLimiterOptions) {
    const limits = KRAKEN_TIER_LIMITS[options.tier];
    if (!limits) throw new RangeError(`unknown Kraken tier: ${String(options.tier)}`);
    this.max = limits.max;
    this.decayPerSec = limits.decayPerSec;
    this.reserve = options.reserve ?? RATE_LIMIT_RESERVE;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.counterAt = this.now();
  }

  /** Highest counter value we allow ourselves. */
  get budget(): number {
    return this.max - this.reserve;
  }

  /** The counter as of now (after decay). */
  level(): number {
    this.decay(this.now());
    return this.counter;
  }

  /** Milliseconds left of a rate-limit back-off, 0 when none is active. */
  backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  /**
   * Resolves once `cost` points fit under the budget, then spends them. Waits out an active back-off first.
   * Safe to call concurrently: the check-and-spend step is synchronous.
   */
  async acquire(cost = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) throw new RangeError(`invalid rate-limit cost: ${cost}`);
    // A cost above the whole budget could never be satisfied; clamp instead of waiting forever.
    const spend = Math.min(cost, this.budget);
    for (;;) {
      const t = this.now();
      const backoff = this.backoffUntil - t;
      if (backoff > 0) {
        await this.sleep(backoff);
        continue;
      }
      this.decay(t);
      if (this.counter + spend <= this.budget + EPSILON) {
        this.counter += spend;
        return;
      }
      const missing = this.counter + spend - this.budget;
      await this.sleep(Math.max(1, Math.ceil((missing / this.decayPerSec) * 1000)));
    }
  }

  /**
   * Kraken said we are over the limit. Starts (or extends) a back-off of 30 s, doubling on every consecutive
   * penalty up to 5 min, and assumes Kraken's counter is full. Returns the back-off applied in ms.
   */
  penalize(): number {
    const t = this.now();
    const ms = Math.min(BACKOFF_INITIAL_MS * 2 ** this.penalties, BACKOFF_MAX_MS);
    this.penalties += 1;
    this.backoffUntil = t + ms;
    this.counter = this.max;
    this.counterAt = t;
    return ms;
  }

  /** A call succeeded: the next penalty starts again at 30 s. */
  noteSuccess(): void {
    this.penalties = 0;
  }

  private decay(t: number): void {
    // A clock that moved backwards must not refill the bucket.
    const elapsedSec = Math.max(0, t - this.counterAt) / 1000;
    this.counter = Math.max(0, this.counter - elapsedSec * this.decayPerSec);
    this.counterAt = t;
  }
}
