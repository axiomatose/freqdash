import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientIp,
  configureLoginRuntimeForTests,
  getLoginRateLimiter,
  LOGIN_FAILURE_DELAY_MS,
  loginFailureDelay,
  LoginRateLimiter,
  type Admission,
} from './ratelimit';

const MIN = 60_000;

function makeLimiter(options: ConstructorParameters<typeof LoginRateLimiter>[0] = {}) {
  const clock = { now: 1_000_000 };
  const limiter = new LoginRateLimiter({ ...options, now: () => clock.now });
  return { limiter, clock };
}

/** Runs one complete attempt and returns the admission (allowed attempts are finished with `success`). */
function attempt(limiter: LoginRateLimiter, ip: string, success = false): Admission {
  const admission = limiter.admit(ip);
  if (admission.allowed) admission.finish(success);
  return admission;
}

function failTimes(limiter: LoginRateLimiter, ip: string, n: number): void {
  for (let i = 0; i < n; i += 1) expect(attempt(limiter, ip).allowed).toBe(true);
}

afterEach(() => configureLoginRuntimeForTests(null));

describe('per-IP lockout', () => {
  it('allows 5 failures, then refuses with the remaining lock time', () => {
    const { limiter, clock } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    clock.now += 60_000;
    const sixth = limiter.admit('1.1.1.1');
    expect(sixth).toEqual({ allowed: false, scope: 'ip', retryAfterSec: 14 * 60 });
  });

  it('reports a 15 minute Retry-After right after the fifth failure', () => {
    const { limiter } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    expect(limiter.admit('1.1.1.1')).toEqual({ allowed: false, scope: 'ip', retryAfterSec: 900 });
  });

  it('does not extend the lock while it is refusing, and unlocks after 15 minutes with a clean slate', () => {
    const { limiter, clock } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    clock.now += 10 * MIN;
    expect(limiter.admit('1.1.1.1').allowed).toBe(false);
    clock.now += 5 * MIN;
    expect(limiter.admit('1.1.1.1').allowed).toBe(true);
  });

  it('gives a fresh 5 attempts after the lock expires', () => {
    const { limiter, clock } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    clock.now += 15 * MIN;
    failTimes(limiter, '1.1.1.1', 5);
    expect(limiter.admit('1.1.1.1').allowed).toBe(false);
  });

  it('counts failures per address', () => {
    const { limiter } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    expect(limiter.admit('2.2.2.2').allowed).toBe(true);
  });

  it('forgets failures older than the 15 minute window', () => {
    const { limiter, clock } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 4);
    clock.now += 15 * MIN + 1;
    failTimes(limiter, '1.1.1.1', 4);
    expect(limiter.admit('1.1.1.1').allowed).toBe(true);
  });

  it('a successful login forgives the address', () => {
    const { limiter } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 4);
    expect(attempt(limiter, '1.1.1.1', true).allowed).toBe(true);
    failTimes(limiter, '1.1.1.1', 4);
    expect(limiter.admit('1.1.1.1').allowed).toBe(true);
  });

  it('refuses a locked address even if the next attempt would carry the right password', () => {
    const { limiter } = makeLimiter();
    failTimes(limiter, '1.1.1.1', 5);
    // The route never reaches the password comparison for a refused admission.
    expect(limiter.admit('1.1.1.1').allowed).toBe(false);
  });
});

describe('in-flight attempts', () => {
  it('a burst of parallel attempts cannot exceed the per-IP limit', () => {
    const { limiter } = makeLimiter();
    const results = Array.from({ length: 20 }, () => limiter.admit('1.1.1.1'));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const refused = results.find((r) => !r.allowed);
    expect(refused).toMatchObject({ allowed: false, scope: 'ip', retryAfterSec: 900 });
  });

  it('a burst cannot exceed the global limit across many addresses', () => {
    const { limiter } = makeLimiter();
    const results = Array.from({ length: 60 }, (_, i) => limiter.admit(`10.0.0.${i}`));
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.find((r) => !r.allowed)).toMatchObject({ scope: 'global' });
  });

  it('finish() is idempotent and releases the slot', () => {
    const { limiter } = makeLimiter();
    const admissions = Array.from({ length: 5 }, () => limiter.admit('1.1.1.1'));
    expect(limiter.admit('1.1.1.1').allowed).toBe(false);
    for (const a of admissions) if (a.allowed) a.finish(true);
    for (const a of admissions) if (a.allowed) a.finish(false); // ignored: already finished
    expect(limiter.admit('1.1.1.1').allowed).toBe(true);
  });
});

describe('global lockout', () => {
  it('20 failures from different addresses lock everyone for 15 minutes', () => {
    const { limiter, clock } = makeLimiter();
    for (let i = 0; i < 20; i += 1) expect(attempt(limiter, `10.0.0.${i}`).allowed).toBe(true);
    const refused = limiter.admit('192.168.1.1'); // a brand-new address is refused too
    expect(refused).toEqual({ allowed: false, scope: 'global', retryAfterSec: 900 });
    clock.now += 15 * MIN;
    expect(limiter.admit('192.168.1.1').allowed).toBe(true);
  });

  it('is not triggered by successes', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 40; i += 1) expect(attempt(limiter, `10.0.0.${i}`, true).allowed).toBe(true);
    expect(limiter.admit('10.9.9.9').allowed).toBe(true);
  });

  it('is not triggered by failures spread over more than the window', () => {
    const { limiter, clock } = makeLimiter();
    for (let i = 0; i < 19; i += 1) attempt(limiter, `10.0.0.${i}`);
    clock.now += 15 * MIN + 1;
    for (let i = 0; i < 19; i += 1) attempt(limiter, `10.0.1.${i}`);
    expect(limiter.admit('10.9.9.9').allowed).toBe(true);
  });
});

describe('bookkeeping', () => {
  it('bounds the number of tracked addresses', () => {
    const { limiter } = makeLimiter({ maxTrackedIps: 50, globalMaxFailures: 100_000 });
    for (let i = 0; i < 500; i += 1) attempt(limiter, `10.1.${Math.floor(i / 250)}.${i % 250}`);
    expect(limiter.trackedIps).toBeLessThanOrEqual(50);
  });

  it('sweeps idle addresses', () => {
    const { limiter, clock } = makeLimiter({ globalMaxFailures: 100_000 });
    for (let i = 0; i < 10; i += 1) attempt(limiter, `10.2.0.${i}`);
    expect(limiter.trackedIps).toBe(10);
    clock.now += 16 * MIN;
    limiter.admit('10.3.0.1');
    expect(limiter.trackedIps).toBe(1);
  });
});

describe('clientIp', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('uses cf-connecting-ip only when TRUST_PROXY=cloudflare', () => {
    const headers = h({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' });
    expect(clientIp(headers, 'cloudflare')).toBe('203.0.113.7');
    expect(clientIp(headers, 'none')).toBe('198.51.100.9');
  });

  it('ignores a spoofable cf-connecting-ip when the proxy is not trusted', () => {
    expect(clientIp(h({ 'cf-connecting-ip': '203.0.113.7' }), 'none')).toBe('unknown');
  });

  it('falls back to the first x-forwarded-for hop, then to "unknown"', () => {
    expect(clientIp(h({ 'x-forwarded-for': '198.51.100.9' }), 'cloudflare')).toBe('198.51.100.9');
    expect(clientIp(h({ 'x-forwarded-for': ' 2001:DB8::1 , 10.0.0.1' }), 'none')).toBe('2001:db8::1');
    expect(clientIp(h({}), 'none')).toBe('unknown');
    expect(clientIp(h({}), 'cloudflare')).toBe('unknown');
  });

  it('treats non-IP values as unknown so garbage cannot mint unlimited buckets', () => {
    expect(clientIp(h({ 'x-forwarded-for': 'evil<script>' }), 'none')).toBe('unknown');
    expect(clientIp(h({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.9' }), 'cloudflare')).toBe(
      '198.51.100.9',
    );
    expect(clientIp(h({ 'x-forwarded-for': 'a'.repeat(200) }), 'none')).toBe('unknown');
  });
});

describe('process-wide runtime', () => {
  it('shares one limiter and sleeps the fixed failure delay', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    configureLoginRuntimeForTests({ sleep });
    expect(getLoginRateLimiter()).toBe(getLoginRateLimiter());
    await loginFailureDelay();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(LOGIN_FAILURE_DELAY_MS);
    expect(LOGIN_FAILURE_DELAY_MS).toBe(400);
  });

  it('can be replaced and reset for tests', () => {
    const custom = new LoginRateLimiter();
    configureLoginRuntimeForTests({ limiter: custom });
    expect(getLoginRateLimiter()).toBe(custom);
    configureLoginRuntimeForTests(null);
    expect(getLoginRateLimiter()).not.toBe(custom);
  });

  it('the default sleep really waits (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = loginFailureDelay().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(LOGIN_FAILURE_DELAY_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
