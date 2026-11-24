// Frozen shared contract (docs/PLAN.md section 5.2). Do not change without the integrator.
// The store implementation lives in src/server/state/store.ts.
import type {
  AccountSnapshot, Allocation, Asset, BotConfigInfo, BotHealth, BotId, BotStats, BotTrade, FtWalletView,
  KrakenBalanceEntry, KrakenOrder, Ms, Pair, SourceKey,
} from './domain';

export interface SourceStatus { key: SourceKey; label: string; cadenceMs: number; lastOkAt: Ms | null; lastAttemptAt: Ms | null;
  consecutiveFailures: number; error: string | null; disabled: boolean; }
export interface BotRuntime { botId: BotId; name: string; color: string; config: BotConfigInfo | null; health: BotHealth | null;
  firstFailureAt: Ms | null; lastStatusOkAt: Ms | null; lastTradesOkAt: Ms | null;
  openTrades: BotTrade[]; closedTrades: BotTrade[]; wallet: FtWalletView | null; whitelist: Pair[];
  plotConfig: unknown | null; locks: { pair: Pair; until: Ms; reason: string | null }[]; stats: BotStats | null;
  logTail: { configured: boolean; file: string | null; available: boolean; lastLineAt: Ms | null;
             lastWalletSyncAt: Ms | null; lastHeartbeatAt: Ms | null; error: string | null }; }
export interface KrakenRuntime { status: 'disabled' | 'ok' | 'degraded' | 'error'; statusReason: string | null;
  balances: KrakenBalanceEntry[] | null; balancesAt: Ms | null; openOrders: KrakenOrder[] | null; openOrdersAt: Ms | null;
  feeTier: Record<Pair, { taker: number; maker: number }> | null; permissionDenied: string[];
  backfillComplete: boolean; errors: { kind: string; endpoint: string; since: Ms; message: string }[]; }
export interface AppState { bots: Record<BotId, BotRuntime>; kraken: KrakenRuntime;
  market: { prices: Record<Asset, { usd: number; at: Ms }>; clockSkewMs: number | null };
  account: AccountSnapshot | null; allocation: Allocation | null; sources: Record<SourceKey, SourceStatus>;
  monitor: { startedAt: Ms | null; lastCycleAt: Ms | null; lastEvalAt: Ms | null; rulesEvaluated: number; lastEvalError: string | null };
  notifier: { discord: boolean; lastSentAt: Ms | null; lastError: string | null; consecutiveFailures: number }; }
export interface StateStore { get(): Readonly<AppState>; update(mutator: (draft: AppState) => void): void;
  requestRecheck(): void; onRecheck(cb: () => void): () => void; }
