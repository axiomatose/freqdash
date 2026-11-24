import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotRuntime } from '@/shared/types/state';
import { createInitialState, createStore, getStore, resetStoreForTests } from './store';

function bot(botId: string): BotRuntime {
  return {
    botId,
    name: botId,
    color: '#4F8CFF',
    config: null,
    health: null,
    firstFailureAt: null,
    lastStatusOkAt: null,
    lastTradesOkAt: null,
    openTrades: [],
    closedTrades: [],
    wallet: null,
    whitelist: ['BTC/USD'],
    plotConfig: null,
    locks: [],
    stats: null,
    logTail: {
      configured: false,
      file: null,
      available: false,
      lastLineAt: null,
      lastWalletSyncAt: null,
      lastHeartbeatAt: null,
      error: null,
    },
  };
}

afterEach(() => {
  resetStoreForTests();
  vi.restoreAllMocks();
});

describe('initial state', () => {
  it('starts empty and disabled', () => {
    const state = createInitialState();
    expect(state.bots).toEqual({});
    expect(state.kraken).toMatchObject({
      status: 'disabled',
      balances: null,
      openOrders: null,
      backfillComplete: false,
      errors: [],
    });
    expect(state.monitor).toEqual({
      startedAt: null,
      lastCycleAt: null,
      lastEvalAt: null,
      rulesEvaluated: 0,
      lastEvalError: null,
    });
    expect(state.notifier).toMatchObject({ discord: false, consecutiveFailures: 0 });
    expect(state.account).toBeNull();
    expect(state.allocation).toBeNull();
  });

  it('returns a fresh object each time', () => {
    expect(createInitialState()).not.toBe(createInitialState());
  });
});

describe('get / update', () => {
  it('applies mutations and exposes them through get()', () => {
    const store = createStore();
    store.update((s) => {
      s.bots.votemax = bot('votemax');
      s.monitor.lastCycleAt = 1_000;
      s.market.prices.BTC = { usd: 84_000, at: 900 };
    });
    expect(store.get().bots.votemax?.whitelist).toEqual(['BTC/USD']);
    expect(store.get().monitor.lastCycleAt).toBe(1_000);
    expect(store.get().market.prices.BTC).toEqual({ usd: 84_000, at: 900 });
  });

  it('gives readers immutable snapshots: an old reference never sees later writes', () => {
    const store = createStore();
    store.update((s) => {
      s.bots.votemax = bot('votemax');
    });
    const before = store.get();
    store.update((s) => {
      s.bots.votemax!.whitelist.push('ETH/USD');
      s.monitor.rulesEvaluated = 22;
    });
    const after = store.get();
    expect(before).not.toBe(after);
    expect(before.bots.votemax?.whitelist).toEqual(['BTC/USD']);
    expect(before.monitor.rulesEvaluated).toBe(0);
    expect(after.bots.votemax?.whitelist).toEqual(['BTC/USD', 'ETH/USD']);
    expect(after.monitor.rulesEvaluated).toBe(22);
  });

  it('freezes the draft once published, so a reference leaked from the mutator cannot write to it later', () => {
    const store = createStore();
    let leaked: { rulesEvaluated: number } | undefined;
    store.update((s) => {
      leaked = s.monitor;
    });
    expect(() => {
      if (leaked) leaked.rulesEvaluated = 99;
    }).toThrow(TypeError);
    expect(store.get().monitor.rulesEvaluated).toBe(0);
  });

  it('does not alias the initial state passed in', () => {
    const initial = createInitialState();
    const store = createStore(initial);
    initial.monitor.rulesEvaluated = 5;
    expect(store.get().monitor.rulesEvaluated).toBe(0);
  });

  it('leaves the state untouched when the mutator throws, and rethrows', () => {
    const store = createStore();
    store.update((s) => {
      s.monitor.rulesEvaluated = 1;
    });
    const before = store.get();
    expect(() =>
      store.update((s) => {
        s.monitor.rulesEvaluated = 2;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.get()).toBe(before);
    expect(store.get().monitor.rulesEvaluated).toBe(1);
  });

  it('rejects asynchronous mutators', () => {
    const store = createStore();
    const asyncMutator = async (s: { monitor: { rulesEvaluated: number } }): Promise<void> => {
      s.monitor.rulesEvaluated = 3;
    };
    expect(() => store.update(asyncMutator as never)).toThrow('synchronous');
    expect(store.get().monitor.rulesEvaluated).toBe(0);
  });

  it('freezes published snapshots outside production so in-place mutation by readers fails loudly', () => {
    const store = createStore();
    store.update((s) => {
      s.bots.votemax = bot('votemax');
    });
    const snapshot = store.get() as unknown as { bots: Record<string, BotRuntime> };
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      snapshot.bots.votemax!.whitelist.push('ETH/USD');
    }).toThrow(TypeError);
    expect(() => {
      snapshot.bots.other = bot('other');
    }).toThrow(TypeError);
  });

  it('does not freeze in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const store = createStore();
    store.update((s) => {
      s.bots.votemax = bot('votemax');
    });
    expect(Object.isFrozen(store.get())).toBe(false);
    vi.unstubAllEnvs();
  });

  it('keeps stores created with createStore() independent of each other', () => {
    const a = createStore();
    const b = createStore();
    a.update((s) => {
      s.monitor.rulesEvaluated = 7;
    });
    expect(b.get().monitor.rulesEvaluated).toBe(0);
  });
});

describe('requestRecheck / onRecheck', () => {
  it('notifies every subscriber once per request', () => {
    const store = createStore();
    const a = vi.fn();
    const b = vi.fn();
    store.onRecheck(a);
    store.onRecheck(b);
    store.requestRecheck();
    store.requestRecheck();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe, and unsubscribing twice is harmless', () => {
    const store = createStore();
    const cb = vi.fn();
    const off = store.onRecheck(cb);
    store.requestRecheck();
    off();
    off();
    store.requestRecheck();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nobody is subscribed', () => {
    expect(() => createStore().requestRecheck()).not.toThrow();
  });

  it('never triggers a recheck from update() (the checks job updates state itself)', () => {
    const store = createStore();
    const cb = vi.fn();
    store.onRecheck(cb);
    store.update((s) => {
      s.monitor.lastEvalAt = 5;
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates a failing subscriber from the others and from the caller', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const store = createStore();
    const after = vi.fn();
    store.onRecheck(() => {
      throw new Error('listener exploded');
    });
    store.onRecheck(after);
    expect(() => store.requestRecheck()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('recheck listener failed');
  });

  it('lets a subscriber unsubscribe itself while being notified', () => {
    const store = createStore();
    const other = vi.fn();
    const off = store.onRecheck(() => {
      off();
    });
    store.onRecheck(other);
    store.requestRecheck();
    store.requestRecheck();
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('registers the same callback only once', () => {
    const store = createStore();
    const cb = vi.fn();
    store.onRecheck(cb);
    store.onRecheck(cb);
    store.requestRecheck();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('getStore (process-wide)', () => {
  it('returns one instance per process', () => {
    expect(getStore()).toBe(getStore());
  });

  it('is shared by module instances that Next.js bundles separately (instrumentation vs route handlers)', async () => {
    vi.resetModules();
    const instrumentation = await import('./store');
    vi.resetModules();
    const routeHandler = await import('./store');
    expect(routeHandler).not.toBe(instrumentation);
    expect(routeHandler.getStore).not.toBe(instrumentation.getStore);

    const poller = instrumentation.getStore();
    const route = routeHandler.getStore();
    expect(route).toBe(poller);

    const seen = vi.fn();
    poller.onRecheck(seen);
    poller.update((s) => {
      s.monitor.lastCycleAt = 123;
      s.bots.votemax = bot('votemax');
    });
    expect(route.get().monitor.lastCycleAt).toBe(123);
    expect(route.get().bots.votemax?.botId).toBe('votemax');

    route.requestRecheck();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps state across module reloads and starts clean after a reset', async () => {
    getStore().update((s) => {
      s.monitor.rulesEvaluated = 22;
    });
    vi.resetModules();
    const again = await import('./store');
    expect(again.getStore().get().monitor.rulesEvaluated).toBe(22);
    again.resetStoreForTests();
    expect(again.getStore().get().monitor.rulesEvaluated).toBe(0);
  });
});
