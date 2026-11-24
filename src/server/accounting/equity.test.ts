import { describe, expect, it } from 'vitest';
import type { KrakenFlow } from '@/shared/types/domain';
import { BASELINE_TOLERANCE_MS, DAY_MS, equityChange, flowUsd, nearestPoint } from './equity';

const NOW = 10 * DAY_MS;
const MIN = 60_000;

function flow(over: Partial<KrakenFlow>): KrakenFlow {
  return { ledgerId: 'L', at: NOW - 3_600_000, type: 'deposit', asset: 'USD', amount: 100, fee: 0, ...over };
}

describe('nearestPoint', () => {
  const pts = [
    { t: 100, totalUsd: 1 },
    { t: 200, totalUsd: 2 },
    { t: 400, totalUsd: 4 },
  ];
  it('returns the closest point within the tolerance, else null', () => {
    expect(nearestPoint(pts, 190, 50)?.totalUsd).toBe(2);
    expect(nearestPoint(pts, 300, 100)?.totalUsd).toBe(2);
    expect(nearestPoint(pts, 1000, 100)).toBeNull();
    expect(nearestPoint([], 1, 100)).toBeNull();
  });
});

describe('equityChange', () => {
  const base = { now: NOW, currentUsd: 660, prices: { ETH: 2000 } };

  it('compares with the snapshot nearest to now - 24 h (+-10 min)', () => {
    const history = [
      { t: NOW - DAY_MS - 9 * MIN, totalUsd: 600 },
      { t: NOW - DAY_MS + 2 * MIN, totalUsd: 620 },
      { t: NOW - 1000, totalUsd: 655 },
    ];
    const c = equityChange({ ...base, history, flows: null })!;
    expect(c.usd).toBeCloseTo(40, 12);
    expect(c.pct).toBeCloseTo((40 / 620) * 100, 12);
    expect(c.netFlowsUsd).toBeNull();
  });

  it('is null when there is no snapshot close enough to 24 h ago', () => {
    const far = [{ t: NOW - DAY_MS - BASELINE_TOLERANCE_MS - 1, totalUsd: 600 }];
    expect(equityChange({ ...base, history: far, flows: null })).toBeNull();
    expect(equityChange({ ...base, history: [], flows: [] })).toBeNull();
  });

  it('accepts a point exactly at the tolerance boundary', () => {
    const edge = [{ t: NOW - DAY_MS - BASELINE_TOLERANCE_MS, totalUsd: 600 }];
    expect(equityChange({ ...base, history: edge, flows: null })?.usd).toBe(60);
  });

  it('removes deposits and withdrawals that happened after the baseline', () => {
    const history = [{ t: NOW - DAY_MS, totalUsd: 500 }];
    const flows = [
      flow({ ledgerId: '1', amount: 100, fee: 0 }),
      flow({ ledgerId: '2', type: 'withdrawal', amount: -20, fee: 1 }),
      flow({ ledgerId: '3', at: NOW - DAY_MS - 1000, amount: 999 }),
      flow({ ledgerId: '4', at: NOW + 1000, amount: 999 }),
      flow({ ledgerId: '5', asset: 'ETH', amount: 0.01, fee: 0 }),
    ];
    const c = equityChange({ ...base, history, flows })!;
    expect(c.netFlowsUsd).toBeCloseTo(100 - 21 + 20, 9);
    expect(c.usd).toBeCloseTo(660 - 500 - 99, 9);
  });

  it('nulls the flow adjustment when a flow cannot be valued, and reports raw change', () => {
    const history = [{ t: NOW - DAY_MS, totalUsd: 500 }];
    const c = equityChange({ ...base, history, flows: [flow({ asset: 'XYZ' })] })!;
    expect(c.netFlowsUsd).toBeNull();
    expect(c.usd).toBe(160);
  });

  it('reports 0 % when the baseline is not positive, and supports a custom window', () => {
    const c = equityChange({
      ...base,
      history: [{ t: NOW - 3_600_000, totalUsd: 0 }],
      flows: null,
      windowMs: 3_600_000,
    })!;
    expect(c.pct).toBe(0);
    expect(c.usd).toBe(660);
  });
});

describe('flowUsd', () => {
  it('signs by type whatever sign the ledger used, and always charges the fee', () => {
    expect(flowUsd(flow({ amount: 100, fee: 1 }), {})).toBe(99);
    expect(flowUsd(flow({ amount: -100, fee: 1 }), {})).toBe(99);
    expect(flowUsd(flow({ type: 'withdrawal', amount: 100, fee: 1 }), {})).toBe(-101);
    expect(flowUsd(flow({ type: 'withdrawal', amount: -100, fee: 1 }), {})).toBe(-101);
    expect(flowUsd(flow({ type: 'transfer', amount: -5, fee: 0 }), {})).toBe(-5);
    expect(flowUsd(flow({ type: 'other', amount: 5, fee: 0 }), {})).toBe(5);
  });
  it('values non-USD assets at the given price and gives up without one', () => {
    expect(flowUsd(flow({ asset: 'ETH', amount: 0.5 }), { ETH: 2000 })).toBe(1000);
    expect(flowUsd(flow({ asset: 'ETH' }), {})).toBeNull();
    expect(flowUsd(flow({ asset: 'ETH' }), { ETH: Number.NaN })).toBeNull();
  });
});
