import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, KRAKEN_TIER_LIMITS, krakenCost, KrakenRateLimiter, RATE_LIMIT_RESERVE } from './ratelimit';
import { KRAKEN_PRIVATE_METHODS, type KrakenTier } from './types';

/** Fake clock whose sleep() simply advances time. */
function fakeTime(start = 1_000_000) {
  const state = { now: start, sleeps: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

function limiterFor(tier: KrakenTier, time = fakeTime()) {
  return { time, limiter: new KrakenRateLimiter({ tier, now: time.now, sleep: time.sleep }) };
}

describe('krakenCost', () => {
  it('charges 2 for Ledgers and 1 for everything else', () => {
    expect(krakenCost('Ledgers')).toBe(2);
    for (const method of KRAKEN_PRIVATE_METHODS.filter((m) => m !== 'Ledgers')) expect(krakenCost(method)).toBe(1);
  });
});

describe('tier limits', () => {
  it('mirrors the plan', () => {
    expect(KRAKEN_TIER_LIMITS).toEqual({
      starter: { max: 15, decayPerSec: 0.33 },
      intermediate: { max: 20, decayPerSec: 0.5 },
      pro: { max: 20, decayPerSec: 1 },
    });
    expect(RATE_LIMIT_RESERVE).toBe(3);
  });

  it('exposes the budget as max minus the 3-point reserve', () => {
    expect(limiterFor('starter').limiter.budget).toBe(12);
    expect(limiterFor('pro').limiter.budget).toBe(17);
  });

  it('rejects an unknown tier', () => {
    expect(() => new KrakenRateLimiter({ tier: 'gold' as KrakenTier })).toThrow(/tier/);
  });
});

describe('KrakenRateLimiter.acquire', () => {
  it('lets a burst through up to the budget without waiting', async () => {
    const { limiter, time } = limiterFor('starter');
    for (let i = 0; i < 12; i++) await limiter.acquire(1);
    expect(time.state.sleeps).toEqual([]);
    expect(limiter.level()).toBeCloseTo(12, 6);
  });

  it.each(['starter', 'intermediate', 'pro'] as const)(
    'never exceeds max - reserve under a 60-call burst (%s)',
    async (tier) => {
      const { limiter, time } = limiterFor(tier);
      const peak = { value: 0 };
      const start = time.now();
      for (let i = 0; i < 60; i++) {
        await limiter.acquire(1);
        peak.value = Math.max(peak.value, limiter.level());
      }
      expect(peak.value).toBeLessThanOrEqual(KRAKEN_TIER_LIMITS[tier].max - RATE_LIMIT_RESERVE + 1e-6);
      // 60 calls minus the free burst have to be paid for by decay time.
      const { max, decayPerSec } = KRAKEN_TIER_LIMITS[tier];
      const expectedMinMs = ((60 - (max - RATE_LIMIT_RESERVE)) / decayPerSec) * 1000;
      expect(time.now() - start).toBeGreaterThanOrEqual(expectedMinMs - 1);
    },
  );

  it('waits for exactly the decay it needs', async () => {
    const { limiter, time } = limiterFor('starter');
    for (let i = 0; i < 12; i++) await limiter.acquire(1);
    await limiter.acquire(1);
    // one point at 0.33/s = 3.03 s
    expect(time.state.sleeps).toHaveLength(1);
    expect(time.state.sleeps[0]).toBe(Math.ceil((1 / 0.33) * 1000));
  });

  it('charges Ledgers double', async () => {
    const { limiter } = limiterFor('starter');
    await limiter.acquire(krakenCost('Ledgers'));
    expect(limiter.level()).toBeCloseTo(2, 6);
  });

  it('decays continuously between calls', async () => {
    const { limiter, time } = limiterFor('intermediate');
    for (let i = 0; i < 10; i++) await limiter.acquire(1);
    time.state.now += 4_000; // 4 s * 0.5/s = 2 points
    expect(limiter.level()).toBeCloseTo(8, 6);
  });

  it('does not refill when the clock runs backwards', async () => {
    const { limiter, time } = limiterFor('starter');
    for (let i = 0; i < 12; i++) await limiter.acquire(1);
    time.state.now -= 60_000;
    expect(limiter.level()).toBeCloseTo(12, 6);
  });

  it('clamps a cost larger than the whole budget instead of waiting forever', async () => {
    const { limiter } = limiterFor('starter');
    await limiter.acquire(50);
    expect(limiter.level()).toBeCloseTo(12, 6);
  });

  it.each([0, -1, Number.NaN])('rejects the invalid cost %s', async (cost) => {
    const { limiter } = limiterFor('starter');
    await expect(limiter.acquire(cost)).rejects.toThrow(RangeError);
  });

  it('serialises concurrent acquirers without overspending', async () => {
    const { limiter, time } = limiterFor('starter');
    let peak = 0;
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        await limiter.acquire(1);
        peak = Math.max(peak, limiter.level());
      }),
    );
    expect(peak).toBeLessThanOrEqual(12 + 1e-6);
    expect(time.state.sleeps.length).toBeGreaterThan(0);
  });
});

describe('KrakenRateLimiter.penalize', () => {
  it('backs off 30 s, 60 s, 120 s, 240 s, then caps at 300 s', () => {
    const { limiter } = limiterFor('starter');
    const applied = Array.from({ length: 7 }, () => limiter.penalize());
    expect(applied).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(BACKOFF_MAX_MS).toBe(300_000);
  });

  it('reports the remaining back-off as time passes', () => {
    const { limiter, time } = limiterFor('starter');
    limiter.penalize();
    expect(limiter.backoffRemainingMs()).toBe(30_000);
    time.state.now += 10_000;
    expect(limiter.backoffRemainingMs()).toBe(20_000);
    time.state.now += 20_000;
    expect(limiter.backoffRemainingMs()).toBe(0);
  });

  it('starts over at 30 s after a success', () => {
    const { limiter } = limiterFor('starter');
    limiter.penalize();
    limiter.penalize();
    limiter.noteSuccess();
    expect(limiter.penalize()).toBe(30_000);
  });

  it('makes acquire() wait out the back-off, then let calls through again', async () => {
    const { limiter, time } = limiterFor('starter');
    const start = time.now();
    limiter.penalize();
    await limiter.acquire(1);
    // 30 s back-off; the assumed-full counter has decayed by 9.9 by then, so no further wait is needed.
    expect(time.now() - start).toBe(30_000);
    expect(time.state.sleeps).toEqual([30_000]);
  });

  it('assumes the counter is full after a penalty', () => {
    const { limiter } = limiterFor('starter');
    limiter.penalize();
    expect(limiter.level()).toBe(15);
  });
});
