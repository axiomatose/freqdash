// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

type Listener = () => void;

function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const matchMedia = vi.fn((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const l of listeners) l();
    },
    listeners,
  };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe('useMediaQuery', () => {
  it('reports the current match and follows changes', () => {
    const mq = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));
    expect(result.current).toBe(false);
    act(() => mq.set(true));
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const mq = stubMatchMedia(true);
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(mq.listeners.size).toBe(1);
    unmount();
    expect(mq.listeners.size).toBe(0);
  });
});
