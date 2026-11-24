import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from './db/client';
import { installTempDb, type TempDb } from './db/testing';
import { boot, cadenceForSource, hydrateStore, resetBootForTests } from './boot';
import { parseConfig, resetConfigForTests } from './config';
import { resetStoreForTests, createStore, getStore } from './state/store';
import { saveSourceState } from './db';

const env = {
  SESSION_SECRET: 'session-secret-that-is-long-enough-0123456789',
  FT_BOT_1_ID: 'votemax',
  FT_BOT_1_NAME: 'VoteMax',
  FT_BOT_1_URL: 'http://localhost:9/votemax',
  FT_BOT_1_USERNAME: 'u',
  FT_BOT_1_PASSWORD: 'password-value-1',
};

describe('boot', () => {
  let temp: TempDb;
  const saved = { ...process.env };

  beforeEach(() => {
    temp = installTempDb();
    vi.useFakeTimers();
    Object.assign(process.env, env, { DATA_DIR: temp.dir, POLLER_ENABLED: 'true' });
    delete process.env.NEXT_PHASE;
    resetConfigForTests();
    resetStoreForTests();
  });

  afterEach(() => {
    resetBootForTests();
    vi.useRealTimers();
    temp.cleanup();
    closeDb();
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
    delete process.env.POLLER_ENABLED;
    resetConfigForTests();
    resetStoreForTests();
  });

  it('starts nothing during `next build`', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    expect(await boot()).toBeNull();
    expect(getStore().get().monitor.startedAt).toBeNull();
  });

  it('starts one poller no matter how often it is called', async () => {
    const a = await boot();
    const b = await boot();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(getStore().get().bots.votemax?.name).toBe('VoteMax');
    expect(getStore().get().monitor.startedAt).not.toBeNull();
  });

  it('seeds the store but starts no jobs when the poller is disabled', async () => {
    process.env.POLLER_ENABLED = 'false';
    expect(await boot()).toBeNull();
    expect(getStore().get().bots.votemax).toBeDefined();
  });

  it('survives a broken configuration', async () => {
    delete process.env.SESSION_SECRET;
    expect(await boot()).toBeNull();
  });

  it('hydrates persisted source freshness', () => {
    saveSourceState(
      { source: 'bot:votemax:status', lastOkAt: 5, lastAttemptAt: 6, consecutiveFailures: 2, lastError: 'x' },
      7,
    );
    const store = createStore();
    hydrateStore(store, parseConfig({ ...env }), 100);
    const s = store.get().sources['bot:votemax:status'];
    expect(s?.lastOkAt).toBe(5);
    expect(s?.consecutiveFailures).toBe(2);
    expect(s?.cadenceMs).toBe(15_000);
  });

  it('maps source keys to cadences', () => {
    expect(cadenceForSource('bot:dca:health')).toBe(10_000);
    expect(cadenceForSource('logtail:dca')).toBe(5_000);
    expect(cadenceForSource('kraken:openOrders')).toBe(15_000);
    expect(cadenceForSource('market:ticker')).toBe(20_000);
    expect(cadenceForSource('weird')).toBe(60_000);
  });
});
