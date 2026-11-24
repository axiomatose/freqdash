'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Freshness, SourceKey } from '@/shared/types/domain';
import type { OfflineInfo, SourceRef } from './freshness';

interface FreshnessContextValue {
  sources: ReadonlyMap<SourceKey, Freshness>;
  offline: OfflineInfo | null;
}

const EMPTY: FreshnessContextValue = { sources: new Map(), offline: null };
const FreshnessContext = createContext<FreshnessContextValue>(EMPTY);

export interface FreshnessProviderProps {
  /** Usually the `sources` array of an API response (or `[summary.accountFreshness]`). */
  sources: readonly Freshness[] | undefined;
  /** Provided once by the app shell when the API is unreachable; nested providers inherit it. */
  offline?: OfflineInfo | null;
  children: ReactNode;
}

/**
 * Makes the freshness of named sources available to <Metric sources={['kraken:balance']}>. Providers nest: an inner
 * provider adds to (and overrides by key) what its parents know, so a page can wrap its own response's `sources`
 * inside the shell-level provider.
 */
export function FreshnessProvider({ sources, offline, children }: FreshnessProviderProps) {
  const parent = useContext(FreshnessContext);
  const value = useMemo<FreshnessContextValue>(() => {
    const merged = new Map(parent.sources);
    for (const s of sources ?? []) merged.set(s.source, s);
    return { sources: merged, offline: offline === undefined ? parent.offline : offline };
  }, [parent, sources, offline]);
  return <FreshnessContext.Provider value={value}>{children}</FreshnessContext.Provider>;
}

/** Resolves refs to Freshness objects; keys nobody registered are dropped. Cheap enough to run on every render. */
export function useResolveSources(refs: readonly SourceRef[]): { sources: Freshness[]; offline: OfflineInfo | null } {
  const ctx = useContext(FreshnessContext);
  const sources: Freshness[] = [];
  for (const ref of refs) {
    const f = typeof ref === 'string' ? ctx.sources.get(ref) : ref;
    if (f) sources.push(f);
  }
  return { sources, offline: ctx.offline };
}
