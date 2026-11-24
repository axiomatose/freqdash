// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  DISMISS_24H_MS,
  clearDismissal,
  dismissFor,
  getPrefs,
  isDismissed,
  parsePrefs,
  resetPrefsCache,
  updatePrefs,
  useDismissed,
  usePrefs,
} from './prefs';

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsCache();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('parsePrefs', () => {
  it('falls back to defaults for missing or malformed data', () => {
    expect(parsePrefs(null)).toBe(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toBe(DEFAULT_PREFS);
    expect(parsePrefs('42')).toBe(DEFAULT_PREFS);
  });

  it('keeps only well-typed fields', () => {
    const p = parsePrefs(JSON.stringify({ utc: true, dismissedUntil: { a: 5, b: 'x', c: null } }));
    expect(p).toEqual({ utc: true, dismissedUntil: { a: 5 }, assistantOpen: false });
    expect(parsePrefs('{"assistantOpen":true}').assistantOpen).toBe(true);
    expect(parsePrefs(JSON.stringify({ utc: 'yes' })).utc).toBe(false);
  });
});

describe('dismissal', () => {
  it('hides a banner for 24 hours and then lets it return', () => {
    const now = 1_000_000;
    dismissFor('mode-banner', DISMISS_24H_MS, now);
    const prefs = getPrefs();
    expect(isDismissed(prefs, 'mode-banner', now + DISMISS_24H_MS - 1)).toBe(true);
    expect(isDismissed(prefs, 'mode-banner', now + DISMISS_24H_MS)).toBe(false);
    expect(isDismissed(prefs, 'other', now)).toBe(false);
  });

  it('persists to localStorage and can be cleared', () => {
    dismissFor('mode-banner', DISMISS_24H_MS, 5);
    expect(JSON.parse(window.localStorage.getItem('freqdash.prefs.v1') ?? '{}').dismissedUntil['mode-banner']).toBe(
      5 + DISMISS_24H_MS,
    );
    clearDismissal('mode-banner');
    expect(getPrefs().dismissedUntil).toEqual({});
  });
});

describe('storage failures', () => {
  it('keeps working in memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    resetPrefsCache();
    expect(getPrefs().utc).toBe(false);
    updatePrefs({ utc: true });
    expect(getPrefs().utc).toBe(true);
  });
});

describe('hooks', () => {
  it('usePrefs re-renders on update', () => {
    const { result } = renderHook(() => usePrefs());
    expect(result.current.utc).toBe(false);
    act(() => updatePrefs({ utc: true }));
    expect(result.current.utc).toBe(true);
  });

  it('useDismissed flips after dismissFor', () => {
    const { result } = renderHook(() => useDismissed('mode-banner'));
    expect(result.current).toBe(false);
    act(() => dismissFor('mode-banner'));
    expect(result.current).toBe(true);
  });
});
