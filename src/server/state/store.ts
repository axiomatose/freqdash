import 'server-only';
import type { AppState, StateStore } from '@/shared/types/state';
import { log } from '../log';

// Process-wide state store (docs/PLAN.md section 5.2). FROZEN after WP0a.
//
// Next.js bundles instrumentation.ts (where the poller runs) and every route handler separately, so a plain module
// singleton would exist once per bundle. The store therefore lives on globalThis under a registered symbol: every
// bundled copy of this file resolves to the same instance.
//
// Semantics:
//  * get() returns an immutable snapshot. A reader that keeps the reference never sees later writes.
//  * update() runs the mutator on a private deep copy and publishes it atomically. If the mutator throws, the state
//    is unchanged and the error propagates. Outside production the published snapshot is deep-frozen so accidental
//    in-place mutation by a reader fails loudly in dev and tests.
//  * requestRecheck() is explicit. update() never triggers it, otherwise the checks job (which updates the monitor
//    fields) would retrigger itself. Callers that changed something the checks care about call it.

export function createInitialState(): AppState {
  return {
    bots: {},
    kraken: {
      status: 'disabled',
      statusReason: null,
      balances: null,
      balancesAt: null,
      openOrders: null,
      openOrdersAt: null,
      feeTier: null,
      permissionDenied: [],
      backfillComplete: false,
      errors: [],
    },
    market: { prices: {}, clockSkewMs: null },
    account: null,
    allocation: null,
    sources: {},
    monitor: { startedAt: null, lastCycleAt: null, lastEvalAt: null, rulesEvaluated: 0, lastEvalError: null },
    notifier: { discord: false, lastSentAt: null, lastError: null, consecutiveFailures: 0 },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Builds an isolated store. Production code uses getStore(); tests may want a private instance. */
export function createStore(initial: AppState = createInitialState()): StateStore {
  const freeze = process.env.NODE_ENV !== 'production';
  let state: AppState = freeze ? deepFreeze(structuredClone(initial)) : structuredClone(initial);
  const listeners = new Set<() => void>();

  return {
    get: () => state,

    update(mutator) {
      const draft = structuredClone(state);
      const result: unknown = mutator(draft);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        // An async mutator would keep writing to a snapshot that readers may already hold.
        throw new TypeError('StateStore.update() mutators must be synchronous');
      }
      state = freeze ? deepFreeze(draft) : draft;
    },

    requestRecheck() {
      // Iterate a copy so a listener may unsubscribe itself; one failing listener must not affect the others
      // or the caller (typically an HTTP handler).
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (err) {
          log.error('recheck listener failed', { err });
        }
      }
    },

    onRecheck(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

const STORE_KEY = Symbol.for('freqdash.store');
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: StateStore };

export function getStore(): StateStore {
  const g = globalThis as GlobalWithStore;
  g[STORE_KEY] ??= createStore();
  return g[STORE_KEY];
}

/** Test helper: discard the process-wide store so the next getStore() starts from the initial state. */
export function resetStoreForTests(): void {
  delete (globalThis as GlobalWithStore)[STORE_KEY];
}
