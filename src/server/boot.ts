import 'server-only';
import { CADENCE_MS } from '@/shared/constants';
import type { Ms, SourceKey } from '@/shared/types/domain';
import type { StateStore } from '@/shared/types/state';
import { applyConfiguredPasswordReset, ensureFirstAccount } from './auth/reset';
import { ConfigError, getConfig, type AppConfig } from './config';
import { getDb, getMeta, getMetaNumber, loadSourceStates, setMeta } from './db';
import { FreqtradeClient } from './freqtrade/client';
import { KrakenPrivateClient } from './kraken/private';
import { KrakenPublicClient } from './kraken/public';
import { createNonceSource } from './kraken/nonce';
import { KrakenRateLimiter } from './kraken/ratelimit';
import { describeError, log } from './log';
import { LogTailer } from './logs/tailer';
import { Dispatcher, type PushChannel } from './notify/dispatcher';
import { getPushService } from './push/service';
import { createContext, emptyBotRuntime, type PollerContext } from './poller/context';
import { registerChecksJob } from './poller/jobs/checks';
import { registerEquityJob } from './poller/jobs/equity';
import { registerFreqtradeJobs } from './poller/jobs/freqtrade';
import { registerKillswitchJob } from './poller/jobs/killswitch';
import { registerKrakenJobs } from './poller/jobs/kraken';
import { registerLogJobs } from './poller/jobs/logs';
import { registerMaintenanceJob } from './poller/jobs/maintenance';
import { registerMarketJobs } from './poller/jobs/market';
import { registerSignalsJob } from './poller/jobs/signals';
import { Scheduler } from './poller/scheduler';
import { getStore } from './state/store';

// Process start-up (docs/PLAN.md section 10, WP8): hydrate the state store from SQLite, build the clients from the
// configuration and start the scheduler. Called from instrumentation.ts; idempotent per process.

const BOOT_KEY = Symbol.for('freqdash.boot');
type GlobalWithBoot = typeof globalThis & { [BOOT_KEY]?: PollerHandle | 'skipped' };

export interface PollerHandle {
  ctx: PollerContext;
  stop(): void;
}

const CADENCE_BY_SUFFIX: Record<string, Ms> = {
  health: CADENCE_MS['ft.health'],
  status: CADENCE_MS['ft.status'],
  trades: CADENCE_MS['ft.trades'],
  balance: CADENCE_MS['ft.balance'],
  config: CADENCE_MS['ft.config'],
  whitelist: CADENCE_MS['ft.whitelist'],
  plot_config: CADENCE_MS['ft.plot_config'],
  locks: CADENCE_MS['ft.locks'],
};

/** Cadence of a persisted source key; used only until the job's first run rewrites the source with its own values. */
export function cadenceForSource(key: SourceKey): Ms {
  const [kind, second, third] = key.split(':');
  if (kind === 'bot' && third !== undefined) return CADENCE_BY_SUFFIX[third] ?? 60_000;
  if (kind === 'logtail') return CADENCE_MS.logtail;
  if (kind === 'kraken' && second !== undefined)
    return (CADENCE_MS as Record<string, Ms>)[`kraken.${second}`] ?? 60_000;
  if (kind === 'market' && second !== undefined)
    return (CADENCE_MS as Record<string, Ms>)[`market.${second}`] ?? 60_000;
  return 60_000;
}

/** Seeds bots and persisted source freshness into the store. Safe to run with the poller disabled. */
export function hydrateStore(store: StateStore, cfg: AppConfig, now: Ms): void {
  const persisted = loadSourceStates();
  store.update((s) => {
    for (const bot of cfg.bots) s.bots[bot.id] = emptyBotRuntime(bot.id, bot.name, bot.color, bot.logFile);
    for (const [key, p] of Object.entries(persisted)) {
      s.sources[key] = {
        key,
        label: key,
        cadenceMs: cadenceForSource(key),
        lastOkAt: p.lastOkAt,
        lastAttemptAt: p.lastAttemptAt,
        consecutiveFailures: p.consecutiveFailures,
        error: p.lastError,
        disabled: false,
      };
    }
    s.kraken.status = cfg.kraken.enabled ? 'ok' : 'disabled';
    s.kraken.statusReason = cfg.kraken.enabled ? null : 'No Kraken API key is configured';
    s.kraken.backfillComplete = getMeta('kraken_backfill_complete') === '1';
    s.monitor.startedAt = now;
  });
}

function resolveReconStart(cfg: AppConfig, now: Ms): Ms {
  if (cfg.reconStartAt !== null) {
    setMeta('recon_start_at', cfg.reconStartAt);
    return cfg.reconStartAt;
  }
  const stored = getMetaNumber('recon_start_at');
  if (stored !== null) return stored;
  setMeta('recon_start_at', now);
  return now;
}

export interface StartOptions {
  cfg: AppConfig;
  store: StateStore;
  now?: () => Ms;
  scheduler?: Scheduler;
  fetchImpl?: typeof fetch;
  /** Web Push channel; default the process-wide service, null to leave it out (tests). */
  push?: PushChannel | null;
}

/** Builds the clients and jobs and starts the scheduler. Separated from boot() so tests can inject everything. */
export function startPoller(options: StartOptions): PollerHandle {
  const { cfg, store } = options;
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? new Scheduler();
  const fetchImpl = options.fetchImpl;

  const ft = new Map(
    cfg.bots.map((b) => [
      b.id,
      new FreqtradeClient({ url: b.url, username: b.username, password: b.password }, fetchImpl),
    ]),
  );
  const tailers = new Map(
    cfg.bots.flatMap((b) =>
      b.logFile === null
        ? []
        : [
            [
              b.id,
              new LogTailer({ botId: b.id, path: b.logFile, backfillHours: cfg.runtime.logBackfillHours }),
            ] as const,
          ],
    ),
  );

  let kraken: KrakenPrivateClient | null = null;
  if (cfg.kraken.enabled && cfg.kraken.apiKey !== null && cfg.kraken.apiSecret !== null) {
    kraken = new KrakenPrivateClient({
      apiKey: cfg.kraken.apiKey,
      apiSecret: cfg.kraken.apiSecret,
      baseUrl: cfg.kraken.baseUrl,
      nonce: createNonceSource(
        () => getMetaNumber('kraken_nonce'),
        (n) => setMeta('kraken_nonce', n),
      ),
      limiter: new KrakenRateLimiter({ tier: cfg.kraken.tier }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  const krakenPublic = new KrakenPublicClient({
    baseUrl: cfg.kraken.baseUrl,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const dispatcher = new Dispatcher({
    discordWebhookUrl: cfg.notify.discordWebhookUrl,
    store,
    push: options.push === undefined ? getPushService() : options.push,
    now,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const ctx = createContext({
    cfg,
    store,
    now,
    scheduler,
    dispatcher,
    ft,
    kraken,
    krakenPublic,
    tailers,
    parserStates: new Map(),
    reconStartAt: resolveReconStart(cfg, now()),
  });

  registerMarketJobs(ctx);
  registerFreqtradeJobs(ctx);
  registerLogJobs(ctx);
  registerKrakenJobs(ctx);
  const unsubscribeChecks = registerChecksJob(ctx);
  const unsubscribeKillswitch = registerKillswitchJob(ctx);
  registerEquityJob(ctx);
  registerSignalsJob(ctx);
  registerMaintenanceJob(ctx);

  scheduler.start();
  void dispatcher
    .sendStartup()
    .catch((err: unknown) => log.warn('startup notification failed', { err: describeError(err) }));
  log.info('poller started', { bots: cfg.bots.length, kraken: kraken !== null, logTails: tailers.size });

  return {
    ctx,
    stop() {
      unsubscribeChecks();
      unsubscribeKillswitch();
      scheduler.stop();
    },
  };
}

/** Process entry point. Never throws: a broken configuration must not take the whole server down. */
export async function boot(): Promise<PollerHandle | null> {
  const g = globalThis as GlobalWithBoot;
  if (g[BOOT_KEY] !== undefined) return g[BOOT_KEY] === 'skipped' ? null : g[BOOT_KEY];
  // `next build` imports the app to collect page data; nothing may start (or touch the database) then.
  if (process.env.NEXT_PHASE === 'phase-production-build') return null;

  try {
    const cfg = getConfig();
    getDb();
    await applyConfiguredPasswordReset(cfg);
    await ensureFirstAccount();
    const store = getStore();
    hydrateStore(store, cfg, Date.now());
    if (!cfg.runtime.pollerEnabled) {
      g[BOOT_KEY] = 'skipped';
      log.info('poller disabled (POLLER_ENABLED=false)');
      return null;
    }
    const handle = startPoller({ cfg, store });
    g[BOOT_KEY] = handle;
    return handle;
  } catch (err) {
    g[BOOT_KEY] = 'skipped';
    log.error('boot failed', { err: err instanceof ConfigError ? err.message : describeError(err) });
    return null;
  }
}

export function resetBootForTests(): void {
  const g = globalThis as GlobalWithBoot;
  const current = g[BOOT_KEY];
  if (current !== undefined && current !== 'skipped') current.stop();
  delete g[BOOT_KEY];
}

/** The running poller, or null (disabled, skipped, not booted). */
export function getPollerHandle(): PollerHandle | null {
  const current = (globalThis as GlobalWithBoot)[BOOT_KEY];
  return current === undefined || current === 'skipped' ? null : current;
}
