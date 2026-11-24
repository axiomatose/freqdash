import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import {
  APP_VERSION,
  CADENCE_MS,
  computeFreshnessState,
  FRESHNESS,
  SCHEDULER,
  sourceKey,
  toFreshness,
  type FreshnessInput,
} from './constants';

const base: FreshnessInput = {
  cadenceMs: 10_000,
  lastOkAt: 1_000_000,
  lastAttemptAt: 1_000_000,
  consecutiveFailures: 0,
};

describe('constants', () => {
  it('APP_VERSION matches package.json', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('cadences follow the poller job table (docs/PLAN.md section 6.4)', () => {
    expect(CADENCE_MS['ft.health']).toBe(10_000);
    expect(CADENCE_MS['ft.status']).toBe(15_000);
    expect(CADENCE_MS['ft.trades']).toBe(60_000);
    expect(CADENCE_MS['ft.balance']).toBe(60_000);
    expect([
      CADENCE_MS['ft.config'],
      CADENCE_MS['ft.whitelist'],
      CADENCE_MS['ft.plot_config'],
      CADENCE_MS['ft.locks'],
    ]).toEqual([300_000, 600_000, 600_000, 300_000]);
    expect(CADENCE_MS.logtail).toBe(5_000);
    expect([CADENCE_MS['market.ticker'], CADENCE_MS['market.time'], CADENCE_MS['market.catalog']]).toEqual([
      20_000, 600_000, 86_400_000,
    ]);
    expect(CADENCE_MS['checks.evaluate']).toBe(10_000);
    expect(CADENCE_MS['equity.snapshot']).toBe(300_000);
    expect(CADENCE_MS['signals.record']).toBe(300_000);
    expect(CADENCE_MS.maintenance).toBe(6 * 3_600_000);
  });

  it('cadences follow the Kraken call table (docs/PLAN.md section 6.3)', () => {
    expect(CADENCE_MS['kraken.openOrders']).toBe(15_000);
    expect(CADENCE_MS['kraken.balance']).toBe(30_000);
    expect(CADENCE_MS['kraken.closedOrders']).toBe(30_000);
    expect(CADENCE_MS['kraken.tradeVolume']).toBe(6 * 3_600_000);
    expect(CADENCE_MS['kraken.ledgers']).toBe(30 * 60_000);
  });

  it('scheduler settings', () => {
    expect(SCHEDULER).toEqual({ jitterRatio: 0.1, maxBackoffMs: 300_000, checksDebounceMs: 2_000 });
  });

  it('builds canonical source keys', () => {
    expect(sourceKey.bot('votemax', 'status')).toBe('bot:votemax:status');
    expect(sourceKey.logtail('dca')).toBe('logtail:dca');
    expect(sourceKey.kraken('balance')).toBe('kraken:balance');
    expect(sourceKey.market('ticker')).toBe('market:ticker');
  });
});

describe('computeFreshnessState', () => {
  const at = (age: number) => base.lastOkAt! + age;

  it('is disabled whenever the source is not configured', () => {
    expect(computeFreshnessState({ ...base, disabled: true }, at(0))).toBe('disabled');
    expect(computeFreshnessState({ ...base, lastOkAt: null, disabled: true }, at(0))).toBe('disabled');
  });

  it('is fresh up to and including 2x cadence', () => {
    expect(computeFreshnessState(base, at(0))).toBe('fresh');
    expect(computeFreshnessState(base, at(FRESHNESS.freshMultiplier * base.cadenceMs))).toBe('fresh');
  });

  it('is aging between 2x and 5x cadence', () => {
    expect(computeFreshnessState(base, at(20_001))).toBe('aging');
    expect(computeFreshnessState(base, at(FRESHNESS.agingMultiplier * base.cadenceMs))).toBe('aging');
  });

  it('is stale beyond 5x cadence', () => {
    expect(computeFreshnessState(base, at(50_001))).toBe('stale');
  });

  it('is error when the last attempt failed and the age exceeds 2x cadence', () => {
    const failing = { ...base, consecutiveFailures: 1 };
    expect(computeFreshnessState(failing, at(20_001))).toBe('error');
    expect(computeFreshnessState(failing, at(500_000))).toBe('error');
  });

  it('stays fresh through a single recent failure', () => {
    expect(computeFreshnessState({ ...base, consecutiveFailures: 1 }, at(5_000))).toBe('fresh');
  });

  it('handles a source that never succeeded', () => {
    const never = { ...base, lastOkAt: null, lastAttemptAt: null };
    expect(computeFreshnessState(never, 5)).toBe('stale');
    expect(computeFreshnessState({ ...never, consecutiveFailures: 2 }, 5)).toBe('error');
  });

  it('treats a lastOkAt in the future (clock skew) as age zero', () => {
    expect(computeFreshnessState(base, base.lastOkAt! - 60_000)).toBe('fresh');
  });
});

describe('toFreshness', () => {
  it('builds the Freshness contract with a computed state', () => {
    const f = toFreshness(
      'kraken:balance',
      'Kraken balance',
      { ...base, consecutiveFailures: 3, error: 'EAPI:Invalid key' },
      base.lastOkAt! + 60_000,
    );
    expect(f).toEqual({
      source: 'kraken:balance',
      label: 'Kraken balance',
      cadenceMs: 10_000,
      lastOkAt: 1_000_000,
      lastAttemptAt: 1_000_000,
      consecutiveFailures: 3,
      error: 'EAPI:Invalid key',
      state: 'error',
    });
  });

  it('defaults the error to null', () => {
    expect(toFreshness('s', 'S', base, base.lastOkAt!).error).toBeNull();
  });
});
