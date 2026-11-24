// Pure freshness logic for <Metric>: which state wins, what "as of" means, what the popover lists.
import type { Freshness, FreshnessState, Ms, SourceKey } from '@/shared/types/domain';

/**
 * Severity order for "worst state wins". `disabled` ranks above `fresh` on purpose: a number that leans on a
 * source that is switched off (no Kraken key) is not live data and must not show a reassuring green dot.
 */
export const STATE_RANK: Record<FreshnessState, number> = { fresh: 0, disabled: 1, aging: 2, stale: 3, error: 4 };

export const STATE_LABEL: Record<FreshnessState, string> = {
  fresh: 'Fresh',
  aging: 'Aging',
  stale: 'Stale',
  error: 'Error',
  disabled: 'Disabled',
};

export function worstState(states: readonly FreshnessState[]): FreshnessState | null {
  let worst: FreshnessState | null = null;
  for (const s of states) if (worst === null || STATE_RANK[s] > STATE_RANK[worst]) worst = s;
  return worst;
}

/** A source can be named by key (resolved through FreshnessProvider) or passed as the object itself. */
export type SourceRef = SourceKey | Freshness;

/** Set when the dashboard API itself is unreachable: every value on screen is then at best "as of" the last fetch. */
export interface OfflineInfo {
  since: Ms | null;
}

export interface FreshnessItem {
  source: SourceKey;
  label: string;
  state: FreshnessState;
  lastOkAt: Ms | null;
  error: string | null;
  /** When this input was last known good (null = never). */
  asOf: Ms | null;
}

export interface FreshnessSummary {
  /** null when there are no sources at all (the value is shown without a dot). */
  state: FreshnessState | null;
  items: FreshnessItem[];
  /** Stale and error values are rendered muted with "as of HH:MM". */
  muted: boolean;
  /** Oldest last-good time among the stale/error inputs; null when unknown (never succeeded) or not muted. */
  asOf: Ms | null;
}

export function summarizeFreshness(
  sources: readonly Freshness[],
  offline: OfflineInfo | null = null,
): FreshnessSummary {
  const items: FreshnessItem[] = sources.map((f) => {
    const degraded = f.state === 'stale' || f.state === 'error';
    // Offline: an otherwise healthy input is only as good as the last successful fetch of the dashboard.
    const state: FreshnessState = offline && !degraded && f.state !== 'disabled' ? 'stale' : f.state;
    return {
      source: f.source,
      label: f.label,
      state,
      lastOkAt: f.lastOkAt,
      error: f.error,
      asOf: degraded ? f.lastOkAt : state === 'stale' ? (offline?.since ?? null) : f.lastOkAt,
    };
  });
  const state = worstState(items.map((i) => i.state));
  const muted = state === 'stale' || state === 'error';
  let asOf: Ms | null = null;
  if (muted) {
    const bad = items.filter((i) => i.state === 'stale' || i.state === 'error');
    asOf = bad.some((i) => i.asOf === null) ? null : Math.min(...bad.map((i) => i.asOf as Ms));
  }
  return { state, items, muted, asOf };
}
