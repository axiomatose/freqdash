import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KrakenBalanceEntry } from '@/shared/types/domain';
import { installTempDb, type TempDb } from '../testing';
import { EQUITY_BUCKET_MS, floorToBucket, insertEquitySnapshot, listEquity, type EquitySnapshotInput } from './equity';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

// A realistic epoch-ms value (2026), far above 2^31, aligned to a 5-minute bucket.
const BASE = floorToBucket(1_790_568_000_000);

const holding = (asset: string, valueUsd: number): KrakenBalanceEntry => ({
  asset,
  krakenAsset: asset === 'ETH' ? 'XETH' : asset,
  wallet: 'spot',
  total: 1,
  hold: 0,
  available: 1,
  priceUsd: valueUsd,
  valueUsd,
});

function snapshot(at: number, over: Partial<EquitySnapshotInput> = {}): EquitySnapshotInput {
  return { at, source: 'kraken', totalUsd: 1000 + at / EQUITY_BUCKET_MS, usdCash: 500, holdings: [], ...over };
}

function seed(count: number, step = 1): void {
  const insert = temp.db.prepare(
    `INSERT INTO equity_snapshots (at, source, total_usd, usd_cash, holdings_json) VALUES (?, 'kraken', ?, 1, '[]')`,
  );
  temp.db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(BASE + i * step * EQUITY_BUCKET_MS, 1000 + i);
  })();
}

describe('insertEquitySnapshot', () => {
  it('floors `at` to the 5-minute bucket and stores every column', () => {
    insertEquitySnapshot(
      snapshot(BASE + 2 * EQUITY_BUCKET_MS + 123_456, {
        source: 'bot-wallet',
        totalUsd: 622.78,
        usdCash: 400.5,
        botPositionsUsd: 200,
        untrackedUsd: 22.28,
        holdings: [holding('ETH', 22.28)],
        unpricedAssets: ['BABY'],
      }),
    );

    expect(listEquity(0, 10)).toEqual([
      {
        at: BASE + 2 * EQUITY_BUCKET_MS,
        source: 'bot-wallet',
        totalUsd: 622.78,
        usdCash: 400.5,
        botPositionsUsd: 200,
        untrackedUsd: 22.28,
      },
    ]);
    const row = temp.db.prepare('SELECT holdings_json, unpriced_json FROM equity_snapshots').get() as {
      holdings_json: string;
      unpriced_json: string;
    };
    expect(JSON.parse(row.holdings_json)).toEqual([holding('ETH', 22.28)]);
    expect(JSON.parse(row.unpriced_json)).toEqual(['BABY']);
  });

  it('defaults the optional columns to null / empty', () => {
    insertEquitySnapshot(snapshot(BASE));
    expect(listEquity(0, 10)[0]).toMatchObject({ botPositionsUsd: null, untrackedUsd: null });
    expect(temp.db.prepare('SELECT unpriced_json FROM equity_snapshots').get()).toEqual({ unpriced_json: '[]' });
  });

  it('a second snapshot in the same bucket replaces the first', () => {
    insertEquitySnapshot(snapshot(BASE + 10_000, { totalUsd: 1 }));
    insertEquitySnapshot(snapshot(BASE + 200_000, { totalUsd: 2, source: 'bot-wallet' }));
    const points = listEquity(0, 10);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ at: BASE, totalUsd: 2, source: 'bot-wallet' });
  });
});

describe('listEquity', () => {
  it('returns [] for an empty table, an empty range or a non-positive maxPoints', () => {
    expect(listEquity(0, 500)).toEqual([]);
    seed(5);
    expect(listEquity(BASE + 10 * EQUITY_BUCKET_MS, 500)).toEqual([]);
    expect(listEquity(0, 0)).toEqual([]);
    expect(listEquity(0, -3)).toEqual([]);
    expect(listEquity(0, Number.NaN)).toEqual([]);
  });

  it('returns everything, oldest first, when there are no more rows than maxPoints', () => {
    seed(10);
    const points = listEquity(0, 10);
    expect(points).toHaveLength(10);
    expect(points.map((p) => p.at)).toEqual(Array.from({ length: 10 }, (_, i) => BASE + i * EQUITY_BUCKET_MS));
  });

  it('honors `since` (inclusive)', () => {
    seed(10);
    const since = BASE + 4 * EQUITY_BUCKET_MS;
    const points = listEquity(since, 500);
    expect(points).toHaveLength(6);
    expect(points[0]?.at).toBe(since);
  });

  it.each([1, 2, 3, 7, 50, 499, 500, 1999])('never returns more than maxPoints (%i) from 2000 rows', (maxPoints) => {
    seed(2000);
    const points = listEquity(0, maxPoints);
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(maxPoints);
    const times = points.map((p) => p.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    // The newest snapshot is always present so the chart ends at "now".
    expect(times.at(-1)).toBe(BASE + 1999 * EQUITY_BUCKET_MS);
  });

  it('keeps the first snapshot and spreads the rest evenly (500 of 2000)', () => {
    seed(2000);
    const points = listEquity(0, 500);
    expect(points).toHaveLength(500);
    expect(points[0]?.at).toBe(BASE);
    // Gaps between consecutive points stay within one bucket width of the ideal spacing.
    const ideal = (1999 * EQUITY_BUCKET_MS) / 499;
    const gaps = points.slice(1).map((p, i) => p.at - (points[i] as { at: number }).at);
    for (const gap of gaps) expect(Math.abs(gap - ideal)).toBeLessThanOrEqual(2 * EQUITY_BUCKET_MS);
  });

  it('with maxPoints 1 returns only the newest snapshot', () => {
    seed(30);
    expect(listEquity(0, 1)).toEqual([expect.objectContaining({ at: BASE + 29 * EQUITY_BUCKET_MS })]);
  });

  it('downsamples irregular data (a long gap) without exceeding maxPoints', () => {
    const insert = temp.db.prepare(
      `INSERT INTO equity_snapshots (at, source, total_usd, usd_cash, holdings_json) VALUES (?, 'kraken', 1, 1, '[]')`,
    );
    temp.db.transaction(() => {
      for (let i = 0; i < 300; i += 1) insert.run(BASE + i * EQUITY_BUCKET_MS);
      // A week-long outage, then dense data again.
      for (let i = 0; i < 300; i += 1) insert.run(BASE + (10_000 + i) * EQUITY_BUCKET_MS);
    })();
    const points = listEquity(0, 100);
    expect(points.length).toBeLessThanOrEqual(100);
    expect(points[0]?.at).toBe(BASE);
    expect(points.at(-1)?.at).toBe(BASE + 10_299 * EQUITY_BUCKET_MS);
  });

  it('is fast enough to serve a chart request from a year of data', () => {
    seed(105_120); // 365 days at 5 minutes
    const started = performance.now();
    const points = listEquity(0, 500);
    const elapsed = performance.now() - started;
    expect(points.length).toBeLessThanOrEqual(500);
    expect(elapsed).toBeLessThan(1500);
  });
});
