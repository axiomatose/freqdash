import { describe, expect, it } from 'vitest';
import { input } from '../../../../test/fixtures/incident/builders';
import { clockSkew } from './clockSkew';

const run = (skew: number | null) => clockSkew(input({ clockSkewMs: skew }));

describe('CLOCK_SKEW', () => {
  it('is silent without a measurement and up to 5 s in either direction (boundary)', () => {
    expect(run(null)).toEqual([]);
    expect(run(0)).toEqual([]);
    expect(run(5000)).toEqual([]);
    expect(run(-5000)).toEqual([]);
  });

  it('warns above 5 s, whichever way the clock is off, with the plain fingerprint and a 10 minute clear timer', () => {
    for (const skew of [5001, -5001, 30_000, -30_000]) {
      const [f] = run(skew);
      expect(f).toMatchObject({
        rule: 'CLOCK_SKEW',
        fingerprint: 'CLOCK_SKEW',
        severity: 'warning',
        clearAfterMs: 600_000,
        evidence: { skewMs: skew },
      });
    }
  });

  it('is critical above 30 s (boundary)', () => {
    expect(run(30_001)[0]!.severity).toBe('critical');
    expect(run(-45_000)[0]!.severity).toBe('critical');
    expect(run(-45_000)[0]!.title).toContain('45.0 s');
  });
});
