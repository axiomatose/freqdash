import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state/store';
import { krakenMode } from './mode';

describe('krakenMode', () => {
  const now = 1_000_000;
  const withBalances = (at: number | null, status: 'ok' | 'disabled' | 'error' = 'ok') => {
    const s = createInitialState();
    s.kraken.status = status;
    if (at !== null) {
      s.kraken.balances = [];
      s.kraken.balancesAt = at;
    }
    return s;
  };

  it('is kraken with fresh balances (age <= 3x cadence)', () => {
    expect(krakenMode(withBalances(now - 90_000), now)).toEqual({ mode: 'kraken', reason: null });
  });

  it('falls back to freqtrade-only when stale, unread or disabled', () => {
    expect(krakenMode(withBalances(now - 91_000), now).mode).toBe('freqtrade-only');
    expect(krakenMode(withBalances(null), now).mode).toBe('freqtrade-only');
    expect(krakenMode(withBalances(now, 'disabled'), now).reason).toMatch(/No Kraken API key/);
  });

  it('prefers the Kraken status reason when there is one', () => {
    const s = withBalances(null);
    s.kraken.statusReason = 'EAPI:Invalid key';
    expect(krakenMode(s, now).reason).toBe('EAPI:Invalid key');
  });
});
