import { describe, expect, it } from 'vitest';
import type { Freshness, FreshnessState } from '@/shared/types/domain';
import { STATE_RANK, summarizeFreshness, worstState } from './freshness';

const NOW = 1_800_000_000_000;

function src(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return {
    source: `s:${state}`,
    label: `Source ${state}`,
    cadenceMs: 30_000,
    lastOkAt: state === 'disabled' ? null : NOW - 10_000,
    lastAttemptAt: NOW - 5_000,
    consecutiveFailures: state === 'error' ? 3 : 0,
    error: state === 'error' ? 'EAPI:Invalid nonce' : null,
    state,
    ...over,
  };
}

describe('worstState', () => {
  it('returns null for no sources', () => {
    expect(worstState([])).toBeNull();
  });

  it('ranks error > stale > aging > disabled > fresh', () => {
    expect(worstState(['fresh', 'aging'])).toBe('aging');
    expect(worstState(['aging', 'stale', 'fresh'])).toBe('stale');
    expect(worstState(['stale', 'error', 'aging'])).toBe('error');
    expect(worstState(['fresh', 'disabled'])).toBe('disabled');
    expect(worstState(['aging', 'disabled'])).toBe('aging');
    expect(worstState(['fresh'])).toBe('fresh');
  });

  it('is order independent', () => {
    const all: FreshnessState[] = ['fresh', 'aging', 'stale', 'error', 'disabled'];
    for (const a of all) for (const b of all) expect(worstState([a, b])).toBe(worstState([b, a]));
  });

  it('has a strict total order', () => {
    expect(new Set(Object.values(STATE_RANK)).size).toBe(5);
  });
});

describe('summarizeFreshness', () => {
  it('has no state and no items for no sources', () => {
    const s = summarizeFreshness([]);
    expect(s).toEqual({ state: null, items: [], muted: false, asOf: null });
  });

  it('keeps fresh and aging values normal (not muted)', () => {
    expect(summarizeFreshness([src('fresh'), src('aging')])).toMatchObject({
      state: 'aging',
      muted: false,
      asOf: null,
    });
  });

  it('mutes stale and error values and reports the oldest last-good time', () => {
    const s = summarizeFreshness([
      src('fresh'),
      src('stale', { lastOkAt: NOW - 20 * 60_000 }),
      src('error', { lastOkAt: NOW - 5 * 60_000 }),
    ]);
    expect(s.state).toBe('error');
    expect(s.muted).toBe(true);
    expect(s.asOf).toBe(NOW - 20 * 60_000);
  });

  it('has no "as of" when a degraded source never succeeded', () => {
    const s = summarizeFreshness([src('error', { lastOkAt: null })]);
    expect(s.muted).toBe(true);
    expect(s.asOf).toBeNull();
  });

  it('does not mute disabled values', () => {
    expect(summarizeFreshness([src('disabled')])).toMatchObject({ state: 'disabled', muted: false });
  });

  it('carries labels, ages and redacted errors into the popover items', () => {
    const s = summarizeFreshness([src('error')]);
    expect(s.items).toEqual([
      expect.objectContaining({
        source: 's:error',
        label: 'Source error',
        state: 'error',
        error: 'EAPI:Invalid nonce',
        lastOkAt: NOW - 10_000,
      }),
    ]);
  });

  it('when the dashboard is offline, healthy inputs become stale as of the last fetch', () => {
    const since = NOW - 90_000;
    const s = summarizeFreshness([src('fresh'), src('disabled')], { since });
    expect(s.items.map((i) => i.state)).toEqual(['stale', 'disabled']);
    expect(s.state).toBe('stale');
    expect(s.muted).toBe(true);
    expect(s.asOf).toBe(since);
  });

  it('offline keeps an already-degraded input as of its own last success', () => {
    const s = summarizeFreshness([src('stale', { lastOkAt: NOW - 30 * 60_000 })], { since: NOW - 60_000 });
    expect(s.asOf).toBe(NOW - 30 * 60_000);
  });

  it('offline without a known fetch time has no "as of"', () => {
    expect(summarizeFreshness([src('fresh')], { since: null }).asOf).toBeNull();
  });
});
