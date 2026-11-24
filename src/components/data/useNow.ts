'use client';

import { useSyncExternalStore } from 'react';
import { serverNow } from '@/lib/client/api';
import type { Ms } from '@/shared/types/domain';

// One shared 1 s ticker for every relative-time label on the page, on the server's clock (see api.ts serverNow).
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let snapshot: Ms = 0;

function tick(): void {
  // Nobody sees the labels while the tab is hidden; the next tick after it returns catches up.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  snapshot = serverNow();
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    snapshot = serverNow();
    timer = setInterval(tick, 1_000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): Ms {
  if (snapshot === 0) snapshot = serverNow();
  return snapshot;
}

/**
 * Current server time in ms, refreshed every second. `null` during SSR and hydration so markup that depends on
 * the clock never mismatches; components render a placeholder until it is known.
 */
export function useNow(): Ms | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
