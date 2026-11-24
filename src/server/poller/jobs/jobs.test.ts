import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotId } from '@/shared/types/domain';
import { getMetaNumber, listEvents, listFindings, listFlows, listLedgerEntries } from '../../db';
import { closeDb } from '../../db/client';
import { installTempDb, type TempDb } from '../../db/testing';
import type { FreqtradeClient, FtResult } from '../../freqtrade/client';
import { KrakenPublicClient } from '../../kraken/public';
import { Dispatcher } from '../../notify/dispatcher';
import { createStore } from '../../state/store';
import type { AppConfig } from '../../config';
import { createContext, emptyBotRuntime, type PollerContext } from '../context';
import { Scheduler } from '../scheduler';
import { checksJob } from './checks';
import { equityJob } from './equity';
import { healthJob } from './freqtrade';
import { ledgersJob } from './kraken';
import { maintenanceJob } from './maintenance';

const T0 = 1_790_000_000_000;

function ok<T>(data: T): FtResult<T> {
  return { ok: true, data, fetchedAt: T0, latencyMs: 5 };
}

function healthBody(startupTs: number, startTs = 1_789_000_000) {
  return {
    last_process: 'x',
    last_process_ts: T0 / 1000 - 5,
    bot_start: 'x',
    bot_start_ts: startTs,
    bot_startup: 'x',
    bot_startup_ts: startupTs,
  };
}

describe('poller jobs', () => {
  let temp: TempDb;
  let clock: number;
  let health: () => Promise<FtResult<unknown>>;
  let ctx: PollerContext;

  beforeEach(() => {
    temp = installTempDb();
    clock = T0;
    health = async () => ok(healthBody(1_789_500_000));
    const store = createStore();
    store.update((s) => {
      s.bots.votemax = emptyBotRuntime('votemax', 'VoteMax', '#4F8CFF', null);
    });
    const client = { health: () => health() } as unknown as FreqtradeClient;
    const cfg = { notify: { minSeverity: 'warning' }, kraken: { tier: 'starter' } } as unknown as AppConfig;
    ctx = createContext({
      cfg,
      store,
      now: () => clock,
      scheduler: new Scheduler(),
      dispatcher: new Dispatcher({ discordWebhookUrl: null, store, now: () => clock }),
      ft: new Map<BotId, FreqtradeClient>([['votemax', client]]),
      kraken: null,
      krakenPublic: new KrakenPublicClient({ baseUrl: 'http://localhost:1' }),
      tailers: new Map(),
      parserStates: new Map(),
      reconStartAt: T0 - 86_400_000,
    });
  });

  afterEach(() => {
    temp.cleanup();
    closeDb();
    vi.restoreAllMocks();
  });

  describe('ledgers', () => {
    const sec = T0 / 1000;
    type Params = Record<string, string | number | undefined>;
    const row = (id: string, at: number, type: string, asset: string, amount: string, refid = id) => [
      id,
      { refid, time: at, type, subtype: '', asset, amount, fee: '0' },
    ];
    function useLedger(rows: ReturnType<typeof row>[]): Params[] {
      const calls: Params[] = [];
      const fake = {
        call: async (_m: string, params: Params = {}) => {
          calls.push(params);
          const matching = rows.filter(([, e]) => (e as { time: number }).time > Number(params.start ?? 0));
          return { ledger: Object.fromEntries(matching), count: matching.length };
        },
      };
      Object.assign(ctx, { kraken: fake, catalogReady: true });
      return calls;
    }

    it('stores every entry type, derives deposit/withdrawal flows, then reads only the tail', async () => {
      const calls = useLedger([
        row('L1', sec - 3000, 'deposit', 'ZUSD', '500'),
        row('L2', sec - 2000, 'spend', 'ZUSD', '-300', 'P1'),
        row('L3', sec - 2000, 'receive', 'XETH', '0.1', 'P1'),
        row('L4', sec - 1000, 'staking', 'ETH.S', '0.001'),
      ]);
      await ledgersJob(ctx);
      expect(listLedgerEntries().map((e) => [e.type, e.asset])).toEqual([
        ['deposit', 'USD'],
        ['spend', 'USD'],
        ['receive', 'ETH'],
        ['staking', 'ETH'],
      ]);
      expect(listFlows().map((f) => f.ledgerId)).toEqual(['L1']);
      expect(calls[0]!.start).toBe(Math.floor((T0 - 86_400_000) / 1000));
      expect(getMetaNumber('kraken_ledger_cursor_sec')).toBe(sec - 1000);

      await ledgersJob(ctx);
      expect(calls[1]!.start).toBe(sec - 1000 - 600);
      expect(listLedgerEntries()).toHaveLength(4);
    });

    it('backfills again when RECON_START moves earlier, not when it moves later', async () => {
      const calls = useLedger([row('L1', sec - 3000, 'deposit', 'ZUSD', '500')]);
      await ledgersJob(ctx);
      await ledgersJob(ctx);
      expect(calls[1]!.start).toBe(sec - 3000 - 600);

      Object.assign(ctx, { reconStartAt: T0 - 2 * 86_400_000 });
      await ledgersJob(ctx);
      expect(calls[2]!.start).toBe(Math.floor((T0 - 2 * 86_400_000) / 1000));

      Object.assign(ctx, { reconStartAt: T0 - 3_600_000 });
      await ledgersJob(ctx);
      expect(calls[3]!.start).toBe(sec - 3000 - 600);
    });

    it('keeps the cursor and the backfill marker unset when the read fails', async () => {
      Object.assign(ctx, {
        kraken: {
          call: async () => {
            throw new Error('boom');
          },
        },
        catalogReady: true,
      });
      await expect(ledgersJob(ctx)).rejects.toThrow('boom');
      expect(getMetaNumber('kraken_ledger_cursor_sec')).toBeNull();
      expect(getMetaNumber('kraken_ledger_backfill_from_sec')).toBeNull();
    });
  });

  it('health: first success records the source and the start markers without an event', async () => {
    await healthJob(ctx, 'votemax');
    const bot = ctx.store.get().bots.votemax;
    expect(bot?.health?.reachable).toBe(true);
    expect(bot?.firstFailureAt).toBeNull();
    expect(ctx.store.get().sources['bot:votemax:health']?.consecutiveFailures).toBe(0);
    expect(getMetaNumber('bot:votemax:startup_at')).toBe(1_789_500_000_000);
    expect(listEvents()).toHaveLength(0);
  });

  it('health: a changed bot_startup_ts emits a startup event; a changed bot_start_ts emits identity_changed', async () => {
    await healthJob(ctx, 'votemax');
    health = async () => ok(healthBody(1_789_500_120, 1_789_000_500));
    await healthJob(ctx, 'votemax');
    const types = listEvents()
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(['identity_changed', 'startup']);
    // A repeat with the same values emits nothing new.
    await healthJob(ctx, 'votemax');
    expect(listEvents()).toHaveLength(2);
  });

  it('health: failure marks the bot unreachable once, keeps the failure clock and emits recovered later', async () => {
    await healthJob(ctx, 'votemax');
    health = async () => ({ ok: false, error: { kind: 'network', message: 'ECONNREFUSED' }, fetchedAt: clock });
    await healthJob(ctx, 'votemax');
    clock += 10_000;
    await healthJob(ctx, 'votemax');
    const bot = ctx.store.get().bots.votemax;
    expect(bot?.health?.reachable).toBe(false);
    expect(bot?.firstFailureAt).toBe(T0);
    expect(bot?.health?.unreachableSince).toBe(T0);
    expect(ctx.store.get().sources['bot:votemax:health']?.consecutiveFailures).toBe(2);
    expect(listEvents().filter((e) => e.type === 'unreachable')).toHaveLength(1);

    health = async () => ok(healthBody(1_789_500_000));
    await healthJob(ctx, 'votemax');
    expect(ctx.store.get().bots.votemax?.firstFailureAt).toBeNull();
    expect(listEvents().some((e) => e.type === 'recovered')).toBe(true);
  });

  it('health: an auth failure sets authFailed', async () => {
    health = async () => ({
      ok: false,
      error: { kind: 'auth', status: 401, message: 'unauthorized' },
      fetchedAt: clock,
    });
    await healthJob(ctx, 'votemax');
    expect(ctx.store.get().bots.votemax?.health?.authFailed).toBe(true);
  });

  it('checks: a long outage becomes a persisted finding and updates the monitor state', async () => {
    health = async () => ({ ok: false, error: { kind: 'network', message: 'ECONNREFUSED' }, fetchedAt: clock });
    await healthJob(ctx, 'votemax');
    clock += 200_000;
    await healthJob(ctx, 'votemax');
    await checksJob(ctx);
    const open = listFindings({ status: ['pending', 'active'] });
    expect(open.map((f) => f.rule)).toContain('BOT_UNREACHABLE');
    const monitor = ctx.store.get().monitor;
    expect(monitor.lastEvalAt).toBe(clock);
    expect(monitor.rulesEvaluated).toBeGreaterThan(10);
    expect(monitor.lastEvalError).toBeNull();
  });

  it('equity: skips without an account and writes a snapshot with one', async () => {
    await equityJob(ctx);
    ctx.store.update((s) => {
      s.account = {
        source: 'bot-wallet',
        estimatedFromBot: 'votemax',
        asOf: clock,
        totalUsd: 100,
        usdCash: 40,
        usdAvailable: null,
        holdings: [],
        unpricedAssets: [],
      };
    });
    await equityJob(ctx);
    const { listEquity } = await import('../../db');
    expect(listEquity(0, 100)).toHaveLength(1);
  });

  it('maintenance: prunes without throwing', async () => {
    await expect(maintenanceJob(ctx)).resolves.toBeUndefined();
  });
});
