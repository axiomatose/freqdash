import type { Asset, BotId, Ms, SourceKey } from '@/shared/types/domain';
import type { AppState, BotRuntime, StateStore } from '@/shared/types/state';
import { buildAccountSnapshot, buildAllocation, computeBotStats, pickMark, withPnl } from '../accounting';
import type { AppConfig } from '../config';
import { listAcks, saveSourceState } from '../db';
import type { FreqtradeClient } from '../freqtrade/client';
import { buildAssetCatalog, emptyAssetCatalog, type AssetCatalog } from '../kraken/assets';
import type { KrakenPrivateClient } from '../kraken/private';
import type { KrakenPublicClient } from '../kraken/public';
import { describeError, log, redactSecrets } from '../log';
import type { ParserState } from '../logs/events';
import type { LogTailer } from '../logs/tailer';
import type { Dispatcher } from '../notify/dispatcher';
import { krakenMode } from './mode';
import type { Scheduler } from './scheduler';

// Shared state of the poller: clients, the store, bookkeeping helpers and the derived-state recomputation that every
// data job calls after it wrote raw data (docs/PLAN.md section 10, WP8).

export interface PollerContext {
  cfg: AppConfig;
  store: StateStore;
  now: () => Ms;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  ft: Map<BotId, FreqtradeClient>;
  /** null without a Kraken key (freqtrade-only mode). */
  kraken: KrakenPrivateClient | null;
  krakenPublic: KrakenPublicClient;
  tailers: Map<BotId, LogTailer>;
  parserStates: Map<BotId, ParserState>;
  reconStartAt: Ms;
  /** txids seen in bot logs that Kraken has not confirmed yet; drained by the kraken.queryOrders job. */
  queryQueue: Set<string>;
  catalog: AssetCatalog;
  catalogReady: boolean;
  /** Loads the asset catalog once (single-flight); later calls resolve immediately. */
  ensureCatalog(): Promise<void>;
  /** Persists the outcome of one poll and mirrors it into `state.sources`. */
  recordOk(key: SourceKey, label: string, cadenceMs: Ms, disabled?: boolean): void;
  recordFail(key: SourceKey, label: string, cadenceMs: Ms, error: unknown): void;
  /** Recomputes P&L, stats, account and allocation from the raw data in the store. */
  recompute(): void;
  /** Marks a cycle as done (drives the "Live · checked 4s ago" indicator). */
  touchCycle(): void;
  trigger(job: string): void;
}

export function pricesOf(state: Pick<AppState, 'market'>): Record<Asset, number> {
  const out: Record<Asset, number> = { USD: 1 };
  for (const [asset, p] of Object.entries(state.market.prices)) out[asset] = p.usd;
  return out;
}

export function emptyBotRuntime(id: BotId, name: string, color: string, logFile: string | null): BotRuntime {
  return {
    botId: id,
    name,
    color,
    config: null,
    health: null,
    firstFailureAt: null,
    lastStatusOkAt: null,
    lastTradesOkAt: null,
    openTrades: [],
    closedTrades: [],
    wallet: null,
    whitelist: [],
    plotConfig: null,
    locks: [],
    stats: null,
    logTail: {
      configured: logFile !== null,
      file: logFile,
      available: false,
      lastLineAt: null,
      lastWalletSyncAt: null,
      lastHeartbeatAt: null,
      error: null,
    },
  };
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return redactSecrets(error);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return redactSecrets(String((error as { message: unknown }).message));
  }
  return describeError(error);
}

export function createContext(
  parts: Omit<
    PollerContext,
    | 'catalog'
    | 'catalogReady'
    | 'ensureCatalog'
    | 'recordOk'
    | 'recordFail'
    | 'recompute'
    | 'touchCycle'
    | 'trigger'
    | 'queryQueue'
  >,
): PollerContext {
  const { store, now } = parts;
  let loading: Promise<void> | null = null;

  const persist = (key: SourceKey): void => {
    const s = store.get().sources[key];
    if (s === undefined) return;
    try {
      saveSourceState(
        {
          source: key,
          lastOkAt: s.lastOkAt,
          lastAttemptAt: s.lastAttemptAt,
          consecutiveFailures: s.consecutiveFailures,
          lastError: s.error,
        },
        now(),
      );
    } catch (err) {
      log.warn('could not persist source state', { key, err: describeError(err) });
    }
  };

  const ctx: PollerContext = {
    ...parts,
    queryQueue: new Set(),
    catalog: emptyAssetCatalog(),
    catalogReady: false,

    ensureCatalog() {
      if (ctx.catalogReady) return Promise.resolve();
      loading ??= (async () => {
        try {
          const [assets, pairs] = await Promise.all([ctx.krakenPublic.assets(), ctx.krakenPublic.assetPairs()]);
          ctx.catalog = buildAssetCatalog(assets, pairs);
          ctx.catalogReady = true;
        } finally {
          loading = null;
        }
      })();
      return loading;
    },

    recordOk(key, label, cadenceMs, disabled = false) {
      const at = now();
      store.update((s) => {
        s.sources[key] = {
          key,
          label,
          cadenceMs,
          lastOkAt: at,
          lastAttemptAt: at,
          consecutiveFailures: 0,
          error: null,
          disabled,
        };
      });
      persist(key);
    },

    recordFail(key, label, cadenceMs, error) {
      const at = now();
      const message = errorText(error).slice(0, 300);
      store.update((s) => {
        const prev = s.sources[key];
        s.sources[key] = {
          key,
          label,
          cadenceMs,
          lastOkAt: prev?.lastOkAt ?? null,
          lastAttemptAt: at,
          consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
          error: message,
          disabled: false,
        };
      });
      persist(key);
    },

    touchCycle() {
      const at = now();
      store.update((s) => {
        s.monitor.lastCycleAt = at;
      });
    },

    trigger(job) {
      ctx.scheduler.trigger(job);
    },

    recompute() {
      const at = now();
      const acks = listAcks(at);
      store.update((s) => {
        const prices = pricesOf(s);
        for (const bot of Object.values(s.bots)) {
          bot.openTrades = bot.openTrades.map((t) => withPnl(t, pickMark(t, prices)));
          bot.closedTrades = bot.closedTrades.map((t) => withPnl(t, null));
          if (bot.lastStatusOkAt !== null || bot.lastTradesOkAt !== null) {
            bot.stats = computeBotStats([...bot.openTrades, ...bot.closedTrades]);
          }
        }
        const { mode } = krakenMode(s, at);
        const wallets = Object.values(s.bots).flatMap((b) => (b.wallet === null ? [] : [b.wallet]));
        const krakenInput =
          mode === 'kraken' && s.kraken.balances !== null && s.kraken.balancesAt !== null
            ? { balances: s.kraken.balances, balancesAt: s.kraken.balancesAt }
            : null;
        s.account = buildAccountSnapshot({ kraken: krakenInput, wallets, prices });
        s.allocation =
          s.account === null
            ? null
            : buildAllocation({
                snapshot: s.account,
                bots: Object.values(s.bots).map((b) => ({ botId: b.botId, openTrades: b.openTrades })),
                acks,
                now: at,
              });
      });
    },
  };
  return ctx;
}
