// Per-viewer conveniences kept in localStorage (never state that matters: it can be blocked, cleared or empty).
// Every storage access is guarded, and the app works identically without it.
import { useSyncExternalStore } from 'react';
import type { Ms } from '@/shared/types/domain';

const STORAGE_KEY = 'freqdash.prefs.v1';
export const DISMISS_24H_MS = 24 * 60 * 60 * 1_000;

export interface Prefs {
  /** Show times in UTC instead of the device time zone. */
  utc: boolean;
  /** Banner key -> epoch ms until which it stays hidden. */
  dismissedUntil: Record<string, Ms>;
  /** The assistant pane on the right is expanded. */
  assistantOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = Object.freeze({
  utc: false,
  dismissedUntil: Object.freeze({}) as Record<string, Ms>,
  assistantOpen: false,
});

/** Shape-checks whatever came out of storage; anything unexpected falls back to the defaults. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return DEFAULT_PREFS;
    const obj = data as { utc?: unknown; dismissedUntil?: unknown; assistantOpen?: unknown };
    const dismissedUntil: Record<string, Ms> = {};
    if (typeof obj.dismissedUntil === 'object' && obj.dismissedUntil !== null) {
      for (const [k, v] of Object.entries(obj.dismissedUntil)) {
        if (typeof v === 'number' && Number.isFinite(v)) dismissedUntil[k] = v;
      }
    }
    return { utc: obj.utc === true, dismissedUntil, assistantOpen: obj.assistantOpen === true };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function isDismissed(prefs: Prefs, key: string, now: Ms): boolean {
  const until = prefs.dismissedUntil[key];
  return until !== undefined && until > now;
}

// ---- store ------------------------------------------------------------------------------------------------------

let cache: Prefs | null = null;
const listeners = new Set<() => void>();

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage blocked or full: the in-memory copy still serves this page view.
  }
}

export function getPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  cache ??= parsePrefs(readStorage());
  return cache;
}

function emit(): void {
  for (const l of listeners) l();
}

export function updatePrefs(patch: Partial<Prefs>): void {
  const next: Prefs = { ...getPrefs(), ...patch };
  cache = next;
  writeStorage(JSON.stringify(next));
  emit();
}

/** Hide `key` (a banner) for `forMs`, 24 h by default. */
export function dismissFor(key: string, forMs: number = DISMISS_24H_MS, now: Ms = Date.now()): void {
  updatePrefs({ dismissedUntil: { ...getPrefs().dismissedUntil, [key]: now + forMs } });
}

export function clearDismissal(key: string): void {
  const { [key]: _removed, ...rest } = getPrefs().dismissedUntil;
  updatePrefs({ dismissedUntil: rest });
}

/** Test hook: drop the in-memory copy so the next read goes back to storage. */
export function resetPrefsCache(): void {
  cache = null;
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY || e.key === null) {
      cache = null;
      onChange();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS);
}

/** True while the banner `key` is inside its dismissal window. */
export function useDismissed(key: string): boolean {
  // The boolean is derived inside the snapshot function, so the clock is read outside render.
  return useSyncExternalStore(
    subscribe,
    () => isDismissed(getPrefs(), key, Date.now()),
    () => false,
  );
}
