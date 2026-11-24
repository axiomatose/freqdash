// Frozen shared contract (docs/PLAN.md section 5.2). Do not change without the integrator.
export type Ms = number;                 // epoch ms UTC, used everywhere
export type BotId = string;              // /^[a-z0-9-]{1,32}$/
export type Pair = string;               // 'BTC/USD'
export type Asset = string;              // 'BTC','ETH','USD','SHIB'
export type Severity = 'info' | 'warning' | 'critical';
export type Side = 'buy' | 'sell';
export type SourceKey = string;          // 'bot:votemax:status' | 'kraken:balance' | 'logtail:dca' | 'market:ticker'
export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'error' | 'disabled';
export interface Freshness { source: SourceKey; label: string; cadenceMs: number; lastOkAt: Ms | null;
  lastAttemptAt: Ms | null; consecutiveFailures: number; error: string | null; state: FreshnessState; }
  // state (computed at response time): disabled if not configured; fresh if age<=2*cadence;
  // aging if <=5*cadence; stale otherwise; error if last attempt failed and age>2*cadence.

export interface BotConfigInfo { botId: BotId; botName: string; strategy: string; timeframe: string; timeframeMs: number;
  stakeCurrency: string; maxOpenTrades: number; dryRun: boolean; tradingMode: string; state: string;
  runmode: string; version: string; positionAdjustment: boolean; exchange: string; }
export interface BotHealth { reachable: boolean; authFailed: boolean; lastProcessAt: Ms | null;
  botStartAt: Ms | null; botStartupAt: Ms | null; unreachableSince: Ms | null; }
export interface BotOrder { botId: BotId; tradeId: number; orderId: string; pair: Pair; side: Side; isEntry: boolean;
  tag: string | null; status: string; orderType: string; amount: number; filled: number; remaining: number;
  price: number | null; cost: number | null; placedAt: Ms | null; filledAt: Ms | null; isOpen: boolean; }
export interface TradePnl { entryQty: number; exitQty: number; openQty: number; entryCostUsd: number;
  exitProceedsUsd: number; feesUsd: number; costBasisUsd: number; realizedUsd: number;
  unrealizedUsd: number | null; totalUsd: number | null; roiOnStake: number | null;
  markPrice: number | null; markSource: 'kraken' | 'bot' | null; }
export interface BotTradeBase { botId: BotId; tradeId: number; key: string; pair: Pair; base: Asset; quote: Asset;
  isOpen: boolean; strategy: string; enterTag: string | null; exitReason: string | null;
  amount: number; stakeAmount: number; maxStakeAmount: number; openRate: number; closeRate: number | null;
  botCurrentRate: number | null; openedAt: Ms; openFilledAt: Ms | null; closedAt: Ms | null;
  feeOpenRate: number | null; feeOpenCost: number | null; feeCloseRate: number | null; feeCloseCost: number | null;
  entries: number; exits: number; hasOpenOrders: boolean; orders: BotOrder[];
  ftProfitAbs: number | null; }        // cross-check only, never displayed as ROI
export interface BotTrade extends BotTradeBase { pnl: TradePnl; }
export interface FtWalletCurrency { currency: Asset; balance: number; free: number; used: number;
  botOwned: number | null; estStakeUsd: number | null; isBotManaged: boolean; }
export interface FtWalletView { botId: BotId; fetchedAt: Ms; lastWalletSyncAt: Ms | null;
  currencies: FtWalletCurrency[]; totalUsd: number; }
export interface BotStats { closedTrades: number; wins: number; losses: number; winRate: number | null;
  realizedUsd: number; unrealizedUsd: number; totalUsd: number; closedCostBasisUsd: number; roiOnStake: number | null;
  openTrades: number; openCostBasisUsd: number; openMarketValueUsd: number | null;
  peakConcurrentStakeUsd: number; returnOnPeakStake: number | null; feesUsd: number;
  firstTradeAt: Ms | null; lastTradeAt: Ms | null; }
export type BotEventType = 'startup' | 'fatal' | 'process_died' | 'order_created' | 'order_failed' | 'order_canceled'
  | 'error' | 'identity_changed' | 'unreachable' | 'recovered';
export interface BotEvent { botId: BotId; at: Ms; type: BotEventType; source: 'logfile' | 'api-logs' | 'health' | 'poller';
  orderId?: string; pair?: Pair; price?: number; stakeUsd?: number; message?: string; fingerprint: string; }

export type KrakenWallet = 'spot' | 'earn' | 'staked' | 'other';
export interface KrakenBalanceEntry { asset: Asset; krakenAsset: string; wallet: KrakenWallet; total: number;
  hold: number; available: number; priceUsd: number | null; valueUsd: number | null; }
export type KrakenOrderStatus = 'pending' | 'open' | 'closed' | 'canceled' | 'expired';
export interface KrakenOrder { txid: string; pair: Pair | null; krakenPair: string; side: Side; orderType: string;
  status: KrakenOrderStatus; openedAt: Ms; closedAt: Ms | null; vol: number; volExec: number; costUsd: number;
  feeUsd: number; avgPrice: number | null; limitPrice: number | null; userref: number | null;
  clOrdId: string | null; reason: string | null; }
export interface KrakenFlow { ledgerId: string; at: Ms; type: 'deposit' | 'withdrawal' | 'transfer' | 'other';
  asset: Asset; amount: number; fee: number; }
/** One Kraken ledger entry, any type (trade, spend, receive, deposit, staking, ...). `amount` keeps Kraken's sign and is
 *  before `fee`: the balance moves by `amount - fee`. Entries of one operation share a `refid`. */
export interface LedgerEntry { ledgerId: string; refid: string | null; at: Ms; type: string; subtype: string | null;
  asset: Asset; amount: number; fee: number; }
export interface AccountSnapshot { source: 'kraken' | 'bot-wallet'; estimatedFromBot: BotId | null; asOf: Ms;
  totalUsd: number; usdCash: number; usdAvailable: number | null; holdings: KrakenBalanceEntry[]; unpricedAssets: Asset[]; }
export interface HoldingAttribution { asset: Asset; total: number; valueUsd: number | null;
  byBot: { botId: BotId; qty: number }[]; acknowledgedQty: number | null; ackId: number | null;
  untrackedQty: number; untrackedUsd: number | null; status: 'cash' | 'bot' | 'manual' | 'untracked' | 'dust'; }
export interface Allocation { totalUsd: number; usdCash: number; botPositions: { botId: BotId; valueUsd: number }[];
  acknowledgedUsd: number; untrackedUsd: number; dustUsd: number; holdings: HoldingAttribution[]; }
export interface Acknowledgement { id: number; kind: 'asset' | 'kraken_order'; subject: string; label: 'manual' | 'ignored';
  note: string | null; qtyBaseline: number | null; createdAt: Ms; createdBy: string | null;
  expiresAt: Ms | null; revokedAt: Ms | null; }

// chart
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; live?: boolean } // UTC seconds, open time
export interface SeriesPoint { time: number; value: number }
export interface IndicatorSeries { key: string; label: string; placement: 'main' | 'pane'; pane: string | null;
  kind: 'line' | 'step' | 'histogram' | 'threshold'; color: string; lineWidth: number; defaultVisible: boolean;
  points: SeriesPoint[]; }
export interface SignalMarker { time: number; kind: 'enter' | 'exit'; tag: string | null; source: 'dataframe' | 'recorded' }
export interface FillMarker { time: number; at: Ms; botId: BotId | null; tradeId: number | null; orderId: string; side: Side;
  isEntry: boolean; price: number; qty: number; costUsd: number; tag: string | null; origin: 'bot' | 'kraken-orphan' | 'kraken-manual' }
export interface ChartData { botId: BotId; pair: Pair; timeframe: string; source: 'freqtrade' | 'kraken';
  strategy: string | null; candles: Candle[]; indicators: IndicatorSeries[]; signals: SignalMarker[]; fills: FillMarker[];
  positions: { botId: BotId; tradeId: number; avgPrice: number; qty: number }[];
  meta: { lastAnalyzedAt: Ms | null; dataStopAt: Ms | null; liveCandle: boolean; signalsNote: string | null };
  freshness: Freshness[]; }

// Manual positions: holdings labelled `manual`, with a cost basis derived from non-bot Kraken orders (average cost).
export interface ManualPosition {
  asset: Asset; ackId: number; note: string | null;
  qty: number;                      // quantity the acknowledgement covers
  priceUsd: number | null; valueUsd: number | null;
  basisQty: number;                 // part of `qty` the order history can price
  unknownQty: number;               // qty - basisQty: arrived without a Kraken buy (transfer, reward) or before the history starts
  avgEntryUsd: number | null;       // average fill price of the buys (what Kraken shows), fees not included
  breakEvenUsd: number | null;      // average cost per unit with the buy fees: the price where unrealized P&L is zero
  costBasisUsd: number | null;      // breakEvenUsd * basisQty
  unrealizedUsd: number | null; unrealizedPct: number | null;   // on basisQty only
  realizedUsd: number;              // from non-bot sells of this asset, sell fees deducted
  feesUsd: number;
  orders: number; firstBuyAt: Ms | null; lastBuyAt: Ms | null;
  ledgerTrades: number;             // of `orders`, buys/sells read from the ledger (Buy Crypto, convert): exact, no order exists
  inflows: { kind: 'deposit' | 'transfer' | 'reward' | 'convert' | 'other'; qty: number }[]; // where unpriced quantity came from
}
