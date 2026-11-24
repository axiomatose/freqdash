import type {
  BotConfigInfo,
  BotHealth,
  BotId,
  BotOrder,
  BotTradeBase,
  FtWalletCurrency,
  FtWalletView,
  Ms,
  Pair,
  Side,
} from '@/shared/types/domain';
import {
  ftBalanceSchema,
  ftHealthSchema,
  ftLocksSchema,
  ftShowConfigSchema,
  ftStatusSchema,
  ftTradesPageSchema,
  ftWhitelistSchema,
  type FtOrderRaw,
  type FtTradeRaw,
} from './schemas';

// Pure normalizers from raw freqtrade JSON to the frozen contracts. Every timestamp leaves here as epoch ms (F4):
// `/health *_ts` are seconds and converted; `*_timestamp` fields are already ms; freqtrade's `*_date` strings carry no
// timezone and are never read. Structurally invalid input throws a ZodError; odd leaf values become null.

const SECONDS_TO_MS_LIMIT = 1e11; // above this an epoch "seconds" value is really ms (year 5138 in seconds)

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch ms field (order/trade `*_timestamp`); zero and negatives mean "not set". */
function ms(v: unknown): Ms | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** Epoch SECONDS field (`/health *_ts`, `last_analyzed_ts`) to ms. */
export function secondsToMs(v: unknown): Ms | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return Math.round(n >= SECONDS_TO_MS_LIMIT ? n : n * 1000);
}

/** Freqtrade sends "" for absent tags and reasons. */
function tag(v: string | null | undefined): string | null {
  return v === null || v === undefined || v === '' ? null : v;
}

export function normalizeHealth(raw: unknown): BotHealth {
  const h = ftHealthSchema.parse(raw);
  return {
    reachable: true,
    authFailed: false,
    lastProcessAt: secondsToMs(h.last_process_ts),
    botStartAt: secondsToMs(h.bot_start_ts),
    botStartupAt: secondsToMs(h.bot_startup_ts),
    unreachableSince: null,
  };
}

/** Health after a failed `/health` call: keeps the last known timestamps and starts (or keeps) the unreachable clock. */
export function markUnreachable(prev: BotHealth | null, now: Ms, authFailed: boolean): BotHealth {
  return {
    reachable: false,
    authFailed,
    lastProcessAt: prev?.lastProcessAt ?? null,
    botStartAt: prev?.botStartAt ?? null,
    botStartupAt: prev?.botStartupAt ?? null,
    unreachableSince: prev && !prev.reachable && prev.unreachableSince !== null ? prev.unreachableSince : now,
  };
}

const TIMEFRAME_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000,
};

function timeframeToMs(timeframe: string | null | undefined): number {
  const m = /^(\d+)([smhdwM])$/.exec(timeframe ?? '');
  if (!m) return 0;
  return Number(m[1]) * (TIMEFRAME_UNIT_MS[m[2] as string] ?? 0);
}

export function normalizeConfig(botId: BotId, raw: unknown): BotConfigInfo {
  const c = ftShowConfigSchema.parse(raw);
  const timeframe = c.timeframe ?? '';
  return {
    botId,
    botName: c.bot_name ?? botId,
    strategy: c.strategy ?? '',
    timeframe,
    timeframeMs: num(c.timeframe_ms) ?? timeframeToMs(timeframe),
    stakeCurrency: c.stake_currency ?? '',
    maxOpenTrades: num(c.max_open_trades) ?? 0,
    dryRun: c.dry_run ?? false,
    tradingMode: c.trading_mode ?? '',
    state: c.state ?? '',
    runmode: c.runmode ?? '',
    version: c.version ?? '',
    positionAdjustment: c.position_adjustment_enable ?? false,
    exchange: c.exchange ?? '',
  };
}

function orderSide(o: FtOrderRaw): Side {
  if (o.ft_order_side === 'buy' || o.ft_order_side === 'sell') return o.ft_order_side;
  return o.ft_is_entry === false ? 'sell' : 'buy';
}

/** First strictly positive number: the fill price (average / safe_price) beats the limit price. */
function fillPrice(o: FtOrderRaw): number | null {
  for (const v of [o.average, o.safe_price, o.price]) {
    const n = num(v);
    if (n !== null && n > 0) return n;
  }
  return null;
}

export function normalizeOrder(botId: BotId, tradeId: number, tradePair: Pair, o: FtOrderRaw): BotOrder {
  const side = orderSide(o);
  return {
    botId,
    tradeId,
    orderId: o.order_id,
    pair: o.pair ?? tradePair,
    side,
    // /status orders lack ft_is_entry (F2); freqtrade spot here is long-only, so a buy is an entry.
    isEntry: o.ft_is_entry ?? side === 'buy',
    tag: tag(o.ft_order_tag),
    status: o.status ?? '',
    orderType: o.order_type ?? '',
    amount: num(o.amount) ?? 0,
    filled: num(o.filled) ?? 0,
    remaining: num(o.remaining) ?? 0,
    price: fillPrice(o),
    cost: num(o.cost),
    placedAt: ms(o.order_timestamp),
    filledAt: ms(o.order_filled_timestamp),
    isOpen: o.is_open ?? false,
  };
}

function splitPair(pair: Pair): [string, string] {
  const [base = '', quote = ''] = pair.split('/');
  return [base, quote.split(':')[0] ?? ''];
}

export function normalizeTrade(botId: BotId, t: FtTradeRaw, isOpenOverride?: boolean): BotTradeBase {
  const orders = t.orders.map((o) => normalizeOrder(botId, t.trade_id, t.pair, o));
  const filledEntries = orders.filter((o) => o.isEntry && o.filled > 0).length;
  const filledExits = orders.filter((o) => !o.isEntry && o.filled > 0).length;
  const [pairBase, pairQuote] = splitPair(t.pair);
  const stakeAmount = num(t.stake_amount) ?? 0;
  const firstPlaced = orders.reduce<Ms | null>(
    (min, o) => (o.placedAt !== null && (min === null || o.placedAt < min) ? o.placedAt : min),
    null,
  );
  return {
    botId,
    tradeId: t.trade_id,
    key: `${botId}:${t.trade_id}`,
    pair: t.pair,
    base: t.base_currency ?? pairBase,
    quote: t.quote_currency ?? pairQuote,
    isOpen: isOpenOverride ?? t.is_open ?? false,
    strategy: t.strategy ?? '',
    enterTag: tag(t.enter_tag),
    exitReason: tag(t.exit_reason),
    amount: num(t.amount) ?? 0,
    stakeAmount,
    maxStakeAmount: num(t.max_stake_amount) ?? stakeAmount,
    openRate: num(t.open_rate) ?? 0,
    closeRate: num(t.close_rate),
    botCurrentRate: num(t.current_rate),
    openedAt: ms(t.open_timestamp) ?? ms(t.open_fill_timestamp) ?? firstPlaced ?? 0,
    openFilledAt: ms(t.open_fill_timestamp),
    closedAt: ms(t.close_timestamp),
    feeOpenRate: num(t.fee_open),
    feeOpenCost: num(t.fee_open_cost),
    feeCloseRate: num(t.fee_close),
    feeCloseCost: num(t.fee_close_cost),
    entries: num(t.nr_of_successful_entries) ?? filledEntries,
    exits: num(t.nr_of_successful_exits) ?? filledExits,
    hasOpenOrders: t.has_open_orders ?? orders.some((o) => o.isOpen),
    orders,
    // total_profit_abs (open trades) includes already realized partial exits; closed trades carry close_profit_abs.
    ftProfitAbs: num(t.total_profit_abs) ?? num(t.close_profit_abs) ?? num(t.profit_abs),
  };
}

/**
 * Accepts a `/status` array or a `/trades` page (`{trades: [...]}`). `isOpen` overrides the trade's own flag: `/status`
 * is the open set and `/trades` the closed set (F1).
 */
export function normalizeTrades(botId: BotId, raw: unknown, opts: { isOpen?: boolean } = {}): BotTradeBase[] {
  const trades = Array.isArray(raw) ? ftStatusSchema.parse(raw) : ftTradesPageSchema.parse(raw).trades;
  return trades.map((t) => normalizeTrade(botId, t, opts.isOpen));
}

const USD_LIKE = /^(Z?USD[TC]?)$/i;

export interface WalletOptions {
  fetchedAt: Ms;
  /** From the log tail (`Wallets synced.`); the API does not expose it. */
  lastWalletSyncAt?: Ms | null;
}

export function normalizeWallet(botId: BotId, raw: unknown, opts: WalletOptions): FtWalletView {
  const w = ftBalanceSchema.parse(raw);
  let estimateSum = 0;
  let usdStake = true;
  const currencies: FtWalletCurrency[] = w.currencies.map((c) => {
    const stake = c.stake ?? w.stake ?? null;
    const usd = stake === null || stake === '' || USD_LIKE.test(stake);
    if (!usd) usdStake = false;
    const est = num(c.est_stake);
    if (usd && est !== null) estimateSum += est;
    return {
      currency: c.currency,
      balance: num(c.balance) ?? 0,
      free: num(c.free) ?? 0,
      used: num(c.used) ?? 0,
      botOwned: num(c.bot_owned),
      estStakeUsd: usd ? est : null,
      isBotManaged: c.is_bot_managed ?? false,
    };
  });
  const stakeIsUsd = w.stake === null || w.stake === undefined || w.stake === '' || USD_LIKE.test(w.stake);
  return {
    botId,
    fetchedAt: opts.fetchedAt,
    lastWalletSyncAt: opts.lastWalletSyncAt ?? null,
    currencies,
    // The bot's own total is in its stake currency; only report it as USD when the stake currency is USD-like.
    totalUsd: stakeIsUsd && usdStake ? (num(w.total) ?? estimateSum) : 0,
  };
}

export function normalizeLocks(raw: unknown): { pair: Pair; until: Ms; reason: string | null }[] {
  const { locks } = ftLocksSchema.parse(raw);
  const out: { pair: Pair; until: Ms; reason: string | null }[] = [];
  for (const lock of locks) {
    const until = ms(lock.lock_end_timestamp);
    if (until === null || lock.active === false) continue;
    out.push({ pair: lock.pair, until, reason: tag(lock.reason) });
  }
  return out;
}

export function normalizeWhitelist(raw: unknown): Pair[] {
  return ftWhitelistSchema.parse(raw).whitelist;
}
