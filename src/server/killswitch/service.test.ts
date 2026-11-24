import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KrakenOrder } from '@/shared/types/domain';
import type { AppConfig } from '../config';
import { closeDb } from '../db/client';
import { createAcks, upsertKrakenOrders } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { createContext, emptyBotRuntime, type PollerContext } from '../poller/context';
import { Scheduler } from '../poller/scheduler';
import { KrakenPublicClient } from '../kraken/public';
import { createStore } from '../state/store';
import { evaluateKillswitch, loadState, resetKillswitch, MAX_STOP_ATTEMPTS } from './service';

const T0 = 1_790_000_000_000;
let temp: TempDb;
let clock = T0;
let n = 0;

const buy = (atMs: number, over: Partial<KrakenOrder> = {}): KrakenOrder => {
  n += 1;
  return {
    txid: `O${String(n).padStart(5, '0')}-AAAAA-BBBBBB`,
    pair: 'ETH/USD',
    krakenPair: 'ETHUSD',
    side: 'buy',
    orderType: 'market',
    status: 'closed',
    openedAt: atMs,
    closedAt: atMs + 500,
    vol: 1,
    volExec: 1,
    costUsd: 10,
    feeUsd: 0,
    avgPrice: 10,
    limitPrice: null,
    userref: null,
    clOrdId: null,
    reason: null,
    ...over,
  };
};

function setup(mode: 'off' | 'dry-run' | 'armed', opts: { containers?: boolean } = {}) {
  const store = createStore();
  store.update((s) => {
    s.bots.votemax = { ...emptyBotRuntime('votemax', 'VoteMax', '#fff', null), whitelist: ['ETH/USD', 'BTC/USD'] };
    s.bots.dca = { ...emptyBotRuntime('dca', 'DCA', '#fff', null), whitelist: ['SOL/USD'] };
    s.kraken.status = 'ok';
    s.kraken.balances = [];
    s.kraken.balancesAt = clock;
  });
  const alerts: string[] = [];
  const cfg = {
    killswitch: {
      mode,
      agentUrl: 'http://agent:9100',
      token: 'x'.repeat(30),
      maxBuysShort: 2,
      windowShortMs: 30_000,
      maxBuysLong: 3,
      windowLongMs: 600_000,
    },
    bots: [
      { id: 'votemax', container: opts.containers === false ? null : 'freqtrade-votemax' },
      { id: 'dca', container: opts.containers === false ? null : 'freqtrade-dca' },
    ],
  } as unknown as AppConfig;
  const ctx: PollerContext = createContext({
    cfg,
    store,
    now: () => clock,
    scheduler: new Scheduler(),
    dispatcher: { alert: async (t: string, d: string) => (alerts.push(`${t} | ${d}`), true) } as never,
    ft: new Map(),
    kraken: null,
    krakenPublic: new KrakenPublicClient({ baseUrl: 'http://localhost:1' }),
    tailers: new Map(),
    parserStates: new Map(),
    reconStartAt: T0 - 86_400_000,
  });
  return { ctx, alerts, store };
}

const storeOrders = (...o: KrakenOrder[]) => upsertKrakenOrders(o, clock);
const burst = () => [buy(clock - 20_000), buy(clock - 10_000), buy(clock - 2_000)];

beforeEach(() => {
  temp = installTempDb();
  clock = T0;
});
afterEach(() => {
  temp.cleanup();
  closeDb();
});

describe('evaluateKillswitch', () => {
  it('does nothing when off', async () => {
    const { ctx, alerts } = setup('off');
    storeOrders(...burst());
    const stop = vi.fn();
    await evaluateKillswitch(ctx, stop);
    expect(stop).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
    expect(loadState().tripped).toBeNull();
  });

  it('stays quiet under the limit', async () => {
    const { ctx, alerts } = setup('armed');
    storeOrders(buy(clock - 5000), buy(clock - 1000));
    await evaluateKillswitch(ctx, vi.fn());
    expect(alerts).toEqual([]);
  });

  it('armed: latches, alerts, and stops the containers of the bots that trade the pair', async () => {
    const { ctx, alerts } = setup('armed');
    storeOrders(...burst());
    const stop = vi.fn(async () => ({ ok: true, message: 'stopped' }));
    await evaluateKillswitch(ctx, stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('freqtrade-votemax');
    const t = loadState().tripped;
    expect(t).toMatchObject({ pair: 'ETH/USD', count: 3, dryRun: false, rule: 'burst-short' });
    expect(t?.bots.votemax?.status).toBe('stopped');
    expect(t?.bots.dca).toBeUndefined();
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatch(/TRIPPED/);
    expect(alerts[1]).toMatch(/votemax: stopped/);
  });

  it('is latched: a second evaluation neither alerts nor stops again', async () => {
    const { ctx, alerts } = setup('armed');
    storeOrders(...burst());
    const stop = vi.fn(async () => ({ ok: true, message: 'stopped' }));
    await evaluateKillswitch(ctx, stop);
    await evaluateKillswitch(ctx, stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(2);
  });

  it('dry-run: alerts but never stops anything', async () => {
    const { ctx, alerts } = setup('dry-run');
    storeOrders(...burst());
    const stop = vi.fn();
    await evaluateKillswitch(ctx, stop);
    expect(stop).not.toHaveBeenCalled();
    expect(loadState().tripped?.dryRun).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/dry run/i);
  });

  it('retries a failed stop, then gives up after the attempt limit', async () => {
    const { ctx, alerts } = setup('armed');
    storeOrders(...burst());
    const stop = vi.fn(async () => ({ ok: false, message: 'agent unreachable' }));
    await evaluateKillswitch(ctx, stop);
    expect(loadState().tripped?.bots.votemax?.status).toBe('failed');
    for (let i = 0; i < MAX_STOP_ATTEMPTS + 3; i++) {
      clock += 6000;
      ctx.store.update((s) => {
        s.kraken.balancesAt = clock;
      });
      await evaluateKillswitch(ctx, stop);
    }
    expect(stop).toHaveBeenCalledTimes(MAX_STOP_ATTEMPTS);
    expect(alerts.at(-1)).toMatch(/votemax: failed \(agent unreachable\)/);
  });

  it('a retry that succeeds ends the retrying', async () => {
    const { ctx } = setup('armed');
    storeOrders(...burst());
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'busy' })
      .mockResolvedValue({ ok: true, message: 'stopped' });
    await evaluateKillswitch(ctx, stop);
    clock += 6000;
    ctx.store.update((s) => {
      s.kraken.balancesAt = clock;
    });
    await evaluateKillswitch(ctx, stop);
    expect(loadState().tripped?.bots.votemax?.status).toBe('stopped');
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('reports bots without a container as not stoppable', async () => {
    const { ctx, alerts } = setup('armed', { containers: false });
    storeOrders(...burst());
    const stop = vi.fn();
    await evaluateKillswitch(ctx, stop);
    expect(stop).not.toHaveBeenCalled();
    expect(alerts.at(-1)).toMatch(/no container configured/);
  });

  it('is blind without fresh Kraken data', async () => {
    const { ctx, alerts, store } = setup('armed');
    store.update((s) => {
      s.kraken.balancesAt = clock - 10 * 60_000;
    });
    storeOrders(...burst());
    await evaluateKillswitch(ctx, vi.fn());
    expect(alerts).toEqual([]);
  });

  it('ignores acknowledged (manual) orders', async () => {
    const { ctx } = setup('armed');
    const orders = burst();
    storeOrders(...orders);
    createAcks({ kind: 'kraken_order', subjects: [orders[0]!.txid], label: 'manual' }, clock);
    await evaluateKillswitch(ctx, vi.fn());
    expect(loadState().tripped).toBeNull();
  });

  it('after a reset only newer orders count, so the old burst does not re-trip', async () => {
    const { ctx } = setup('armed');
    storeOrders(...burst());
    const stop = vi.fn(async () => ({ ok: true, message: 'stopped' }));
    await evaluateKillswitch(ctx, stop);
    clock += 1000;
    resetKillswitch(clock);
    expect(loadState()).toMatchObject({ tripped: null, resetAt: clock });
    ctx.store.update((s) => {
      s.kraken.balancesAt = clock;
    });
    await evaluateKillswitch(ctx, stop);
    expect(loadState().tripped).toBeNull();
    storeOrders(buy(clock + 1000), buy(clock + 2000), buy(clock + 3000));
    clock += 4000;
    ctx.store.update((s) => {
      s.kraken.balancesAt = clock;
    });
    await evaluateKillswitch(ctx, stop);
    expect(loadState().tripped).not.toBeNull();
  });

  it('stops every bot when the pair is not attributable', async () => {
    const { ctx } = setup('armed');
    storeOrders(...[0, 1, 2].map((i) => buy(clock - 3000 + i, { pair: 'DOGE/USD', krakenPair: 'DOGEUSD' })));
    const stop = vi.fn(async (_container: string) => ({ ok: true, message: 'stopped' }));
    await evaluateKillswitch(ctx, stop);
    expect(stop.mock.calls.map((c) => c[0]).sort()).toEqual(['freqtrade-dca', 'freqtrade-votemax']);
  });
});
