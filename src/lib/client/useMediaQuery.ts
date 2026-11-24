import { useMemo, useSyncExternalStore } from 'react';

/** Tailwind breakpoints, so JS and CSS agree on what "desktop" means. */
export const BREAKPOINT = { md: '(min-width: 768px)', lg: '(min-width: 1024px)' } as const;

function subscribeTo(query: string) {
  return (onChange: () => void): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

/**
 * Matches a CSS media query. During SSR and hydration it reports `defaultValue`, and switches to the real answer
 * right after mount, so markup never depends on the device at render time (no UA sniffing).
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const subscribe = useMemo(() => subscribeTo(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : defaultValue,
    () => defaultValue,
  );
}

/** >= 1024 px: sidebar shell, multi-column grids. */
export const useIsDesktop = (): boolean => useMediaQuery(BREAKPOINT.lg);
/** >= 768 px: real tables instead of card lists. */
export const useIsTablet = (): boolean => useMediaQuery(BREAKPOINT.md);
