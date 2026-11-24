// Frozen shared contract (docs/PLAN.md section 5.2). Do not change without the integrator.
import type {
  Acknowledgement, Asset, BotConfigInfo, BotEvent, BotHealth, BotId, BotTrade, FtWalletView, KrakenBalanceEntry,
  KrakenOrder, Ms, Pair,
} from '@/shared/types/domain';
import type { BotRuntime, KrakenRuntime } from '@/shared/types/state';

export interface BotCheckView { botId: BotId; name: string; health: BotHealth | null; firstFailureAt: Ms | null;
  lastStatusOkAt: Ms | null; lastTradesOkAt: Ms | null; config: BotConfigInfo | null;
  openTrades: BotTrade[]; closedTrades: BotTrade[]; wallet: FtWalletView | null; whitelist: Pair[];
  logTail: BotRuntime['logTail']; }
export interface KrakenCheckView { balances: KrakenBalanceEntry[]; balancesAt: Ms; openOrders: KrakenOrder[]; openOrdersAt: Ms;
  orders: KrakenOrder[] /* persisted, openedAt >= reconStartAt, merged with openOrders */; backfillComplete: boolean;
  feeTier: Record<Pair, { taker: number; maker: number }> | null; errors: KrakenRuntime['errors']; permissionDenied: string[]; }
export interface CheckInput { now: Ms; cfg: CheckConfig; reconStartAt: Ms; bots: BotCheckView[];
  kraken: KrakenCheckView | null;                    // null => freqtrade-only mode
  prices: Record<Asset, number>;                     // USD, USD=1
  knownOrders: Record<string, { botId: BotId; tradeId: number }>;   // live API orders UNION bot_orders_seen
  events: BotEvent[];        // last 2 h all types + order_created/order_canceled for last 30 d
  acks: Acknowledgement[];   // active only
  clockSkewMs: number | null; notifierFailures: number; }
export type CheckConfig = typeof import('./config').DEFAULT_CHECK_CONFIG;   // numbers only
