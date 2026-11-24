import { describe, expect, it } from 'vitest';
import type { KrakenCheckView } from '../types';
import { MIN, SEC, T0, input, krakenView } from '../../../../test/fixtures/incident/builders';
import { krakenError } from './krakenError';

const err = (kind: string, endpoint: string, ageMs: number, message = 'boom') => ({
  kind,
  endpoint,
  since: T0 - ageMs,
  message,
});
const run = (over: Partial<KrakenCheckView>) => krakenError(input({ kraken: krakenView(over) }));

describe('KRAKEN_ERROR', () => {
  it('is silent without Kraken data and without errors', () => {
    expect(krakenError(input({ kraken: null }))).toEqual([]);
    expect(run({})).toEqual([]);
  });

  it('an auth error is critical immediately', () => {
    const [f] = run({ errors: [err('auth', 'BalanceEx', 1000, 'EAPI:Invalid key')] });
    expect(f).toMatchObject({
      rule: 'KRAKEN_ERROR',
      fingerprint: 'KRAKEN_ERROR:auth:BalanceEx',
      severity: 'critical',
      subject: { kind: 'auth' },
      clearAfterMs: 60_000,
    });
    expect(f!.evidence).toMatchObject({ kind: 'auth', endpoint: 'BalanceEx', message: 'EAPI:Invalid key' });
    expect(f!.detail).toContain('read-only API key');
  });

  it('a missing permission is a warning for required endpoints and info for optional ones', () => {
    for (const endpoint of ['Balance', 'BalanceEx', 'OpenOrders', 'ClosedOrders']) {
      expect(run({ errors: [err('permission', endpoint, 1000)] })[0]!.severity).toBe('warning');
    }
    for (const endpoint of ['Ledgers', 'TradeVolume', 'QueryOrders']) {
      expect(run({ errors: [err('permission', endpoint, 1000)] })[0]!.severity).toBe('info');
    }
  });

  it('permissionDenied endpoints raise the same findings, without duplicating an error entry', () => {
    const [f] = run({ permissionDenied: ['Ledgers'] });
    expect(f).toMatchObject({ fingerprint: 'KRAKEN_ERROR:permission:Ledgers', severity: 'info' });
    expect(f!.evidence).toMatchObject({ since: null });
    expect(f!.detail).toContain('never a trading or withdrawal permission');
    const both = run({
      errors: [err('permission', 'OpenOrders', 5000)],
      permissionDenied: ['OpenOrders', 'TradeVolume'],
    });
    expect(both.map((x) => x.fingerprint)).toEqual([
      'KRAKEN_ERROR:permission:OpenOrders',
      'KRAKEN_ERROR:permission:TradeVolume',
    ]);
    expect(both[0]!.evidence).toMatchObject({ since: T0 - 5000 });
  });

  it('transient errors need 2 minutes before they warn (boundary)', () => {
    for (const kind of ['nonce', 'ratelimit', 'unavailable', 'network']) {
      expect(run({ errors: [err(kind, 'OpenOrders', 2 * MIN - 1)] })).toEqual([]);
      const [f] = run({ errors: [err(kind, 'OpenOrders', 2 * MIN)] });
      expect(f).toMatchObject({ fingerprint: `KRAKEN_ERROR:${kind}:OpenOrders`, severity: 'warning' });
      expect(f!.detail).toContain('keeps retrying');
    }
  });

  it('one finding per kind and endpoint', () => {
    const found = run({
      errors: [
        err('network', 'Balance', 3 * MIN),
        err('network', 'OpenOrders', 3 * MIN),
        err('network', 'Balance', 4 * MIN),
      ],
    });
    expect(found.map((f) => f.fingerprint)).toEqual([
      'KRAKEN_ERROR:network:Balance',
      'KRAKEN_ERROR:network:OpenOrders',
    ]);
  });

  it('describes how long the problem has lasted', () => {
    expect(run({ errors: [err('network', 'Balance', 90 * SEC + 3 * MIN)] })[0]!.detail).toContain('4m 30s');
  });
});
