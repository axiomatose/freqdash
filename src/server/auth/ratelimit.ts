import 'server-only';
import { isIP } from 'node:net';
import type { Ms } from '@/shared/types/domain';
import type { TrustProxy } from '../config';

// In-memory login throttling (docs/PLAN.md section 3).
//  * Per IP: 5 failures within 15 min lock that IP for 15 min.
//  * Global: 20 failures within 15 min lock every client for 15 min (protects against spoofed source addresses).
// A locked client is refused before its password is even looked at, so a lock never reveals whether a guess was right.
//
// Attempts that are still being evaluated ("in flight") count against the limits, so a burst of parallel requests
// cannot get more guesses than the limit allows just because none of them has failed yet.

export const LOGIN_FAILURE_DELAY_MS = 400;
const MINUTE_MS = 60_000;

export interface RateLimiterOptions {
  perIpMaxFailures?: number;
  globalMaxFailures?: number;
  windowMs?: Ms;
  lockMs?: Ms;
  /** Upper bound on tracked addresses; the oldest entries are dropped beyond it. */
  maxTrackedIps?: number;
  now?: () => Ms;
}

export type Admission =
  | {
      allowed: true;
      /** Report the outcome exactly once (extra calls are ignored). A success forgives the address's failures. */
      finish(success: boolean): void;
      /** The password was never checked (e.g. the captcha was missing): free the slot without counting anything. */
      release(): void;
    }
  | { allowed: false; scope: 'ip' | 'global'; retryAfterSec: number };

interface IpRecord {
  failures: Ms[];
  lockedUntil: Ms;
  inFlight: number;
}

export class LoginRateLimiter {
  private readonly perIpMax: number;
  private readonly globalMax: number;
  private readonly windowMs: Ms;
  private readonly lockMs: Ms;
  private readonly maxIps: number;
  private readonly now: () => Ms;
  private readonly ips = new Map<string, IpRecord>();
  private globalFailures: Ms[] = [];
  private globalLockedUntil: Ms = 0;
  private globalInFlight = 0;
  private lastSweepAt: Ms = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.perIpMax = options.perIpMaxFailures ?? 5;
    this.globalMax = options.globalMaxFailures ?? 20;
    this.windowMs = options.windowMs ?? 15 * MINUTE_MS;
    this.lockMs = options.lockMs ?? 15 * MINUTE_MS;
    this.maxIps = options.maxTrackedIps ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Decides whether `ip` may make a password attempt now. */
  admit(ip: string): Admission {
    const now = this.now();
    this.sweep(now);
    this.globalFailures = this.recent(this.globalFailures, now);
    const record = this.ips.get(ip);
    if (record) record.failures = this.recent(record.failures, now);

    if (this.globalLockedUntil > now) return this.refuse('global', this.globalLockedUntil - now);
    if (record && record.lockedUntil > now) return this.refuse('ip', record.lockedUntil - now);
    // Attempts already in progress may still push the total over the limit; refuse for a full lock period.
    if (this.globalFailures.length + this.globalInFlight >= this.globalMax) return this.refuse('global', this.lockMs);
    if (record && record.failures.length + record.inFlight >= this.perIpMax) return this.refuse('ip', this.lockMs);

    const entry = record ?? this.track(ip);
    entry.inFlight += 1;
    this.globalInFlight += 1;
    let done = false;
    return {
      allowed: true,
      finish: (success) => {
        if (done) return;
        done = true;
        this.settle(ip, success);
      },
      release: () => {
        if (done) return;
        done = true;
        this.globalInFlight = Math.max(0, this.globalInFlight - 1);
        const entry = this.ips.get(ip);
        if (entry) entry.inFlight = Math.max(0, entry.inFlight - 1);
      },
    };
  }

  /** Number of addresses currently tracked (exposed for tests and diagnostics). */
  get trackedIps(): number {
    return this.ips.size;
  }

  private refuse(scope: 'ip' | 'global', waitMs: Ms): Admission {
    return { allowed: false, scope, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  private recent(times: Ms[], now: Ms): Ms[] {
    const cutoff = now - this.windowMs;
    return times.some((t) => t <= cutoff) ? times.filter((t) => t > cutoff) : times;
  }

  private track(ip: string): IpRecord {
    const record: IpRecord = { failures: [], lockedUntil: 0, inFlight: 0 };
    this.ips.set(ip, record);
    if (this.ips.size > this.maxIps) {
      for (const [key, candidate] of this.ips) {
        if (this.ips.size <= this.maxIps) break;
        if (key !== ip && candidate.inFlight === 0) this.ips.delete(key);
      }
    }
    return record;
  }

  private settle(ip: string, success: boolean): void {
    const now = this.now();
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const record = this.ips.get(ip);
    if (record) record.inFlight = Math.max(0, record.inFlight - 1);

    if (success) {
      if (record) {
        record.failures = [];
        if (record.inFlight === 0 && record.lockedUntil <= now) this.ips.delete(ip);
      }
      return;
    }

    this.globalFailures = [...this.recent(this.globalFailures, now), now];
    if (this.globalFailures.length >= this.globalMax) {
      this.globalLockedUntil = now + this.lockMs;
      this.globalFailures = [];
    }
    const entry = record ?? this.track(ip);
    entry.failures = [...this.recent(entry.failures, now), now];
    if (entry.failures.length >= this.perIpMax) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = [];
    }
  }

  /** Drops idle addresses; runs at most once a minute. */
  private sweep(now: Ms): void {
    if (now - this.lastSweepAt < MINUTE_MS) return;
    this.lastSweepAt = now;
    for (const [ip, record] of this.ips) {
      const idle = record.inFlight === 0 && record.lockedUntil <= now && this.recent(record.failures, now).length === 0;
      if (idle) this.ips.delete(ip);
    }
  }
}

// ---- client address --------------------------------------------------------------------------------------------

function validAddress(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value || value.length > 64 || isIP(value) === 0) return null;
  return value;
}

/**
 * Address used to key the limiter: `cf-connecting-ip` when TRUST_PROXY=cloudflare, else the first `x-forwarded-for`
 * hop, else 'unknown'. Values that are not IP addresses are ignored so garbage cannot mint unlimited buckets.
 */
export function clientIp(headers: Headers, trustProxy: TrustProxy): string {
  if (trustProxy === 'cloudflare') {
    const cf = validAddress(headers.get('cf-connecting-ip'));
    if (cf) return cf;
  }
  return validAddress(headers.get('x-forwarded-for')?.split(',')[0]) ?? 'unknown';
}

// ---- process-wide instance -------------------------------------------------------------------------------------

interface LoginRuntime {
  limiter: LoginRateLimiter;
  sleep: (ms: number) => Promise<void>;
}

// Kept on globalThis: the route bundle and the proxy bundle are separate module graphs, and a second limiter would
// silently double the allowed guesses.
const RUNTIME_KEY = Symbol.for('freqdash.auth.login');
type GlobalWithRuntime = typeof globalThis & { [RUNTIME_KEY]?: LoginRuntime };

function runtime(): LoginRuntime {
  const g = globalThis as GlobalWithRuntime;
  g[RUNTIME_KEY] ??= {
    limiter: new LoginRateLimiter(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  return g[RUNTIME_KEY];
}

export function getLoginRateLimiter(): LoginRateLimiter {
  return runtime().limiter;
}

/** Fixed pause after a wrong password, so guessing is slow even when the limiter is not yet engaged. */
export function loginFailureDelay(): Promise<void> {
  return runtime().sleep(LOGIN_FAILURE_DELAY_MS);
}

/** Test hook: replace the limiter and/or the sleep function (so tests never wait). `null` restores the defaults. */
export function configureLoginRuntimeForTests(overrides: Partial<LoginRuntime> | null): void {
  const g = globalThis as GlobalWithRuntime;
  delete g[RUNTIME_KEY];
  if (overrides) Object.assign(runtime(), overrides);
}
