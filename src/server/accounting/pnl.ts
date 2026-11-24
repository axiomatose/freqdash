// Per-trade P&L (docs/PLAN.md section 7). Pure: every input is an argument.
// Freqtrade's own ratios (profit_*_percent, starting_capital*) are never used, only its raw fills, fees and rates.
import type { Asset, BotOrder, BotTrade, BotTradeBase, Ms, TradePnl } from '@/shared/types/domain';

/** Exit fee rate assumed for an open trade when neither the close nor the open fee rate is known. */
export const FALLBACK_FEE_RATE = 0.004;

/** Anything smaller than this (in base units) is rounding noise, not a position. */
const QTY_EPSILON = 1e-10;

export interface MarkPrice {
  price: number;
  source: 'kraken' | 'bot';
}

/** One filled order reduced to what accounting needs. */
export interface Fill {
  at: Ms;
  qty: number;
  value: number;
}

export interface TradeFills {
  entries: Fill[];
  exits: Fill[];
}

function isPositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Exchange-reported cost when there is one (it is filled x average price), else filled x price. */
function fillValue(o: BotOrder): number {
  if (isPositive(o.cost)) return o.cost;
  return isPositive(o.price) ? o.filled * o.price : 0;
}

function entryAt(t: BotTradeBase, o: BotOrder): Ms {
  return o.filledAt ?? o.placedAt ?? t.openFilledAt ?? t.openedAt;
}

function exitAt(t: BotTradeBase, o: BotOrder): Ms {
  return o.filledAt ?? o.placedAt ?? t.closedAt ?? t.openedAt;
}

/**
 * The fills of a trade, oldest first. Only orders with `filled > 0` count. A trade without any order (never seen from
 * the real API, but a normalizer may produce it) falls back to its own amount and rates so positions are not lost.
 */
export function tradeFills(trade: BotTradeBase): TradeFills {
  if (trade.orders.length === 0) {
    const entries: Fill[] = isPositive(trade.amount)
      ? [{ at: trade.openFilledAt ?? trade.openedAt, qty: trade.amount, value: trade.amount * trade.openRate }]
      : [];
    const exits: Fill[] =
      !trade.isOpen && isPositive(trade.amount) && isPositive(trade.closeRate)
        ? [{ at: trade.closedAt ?? trade.openedAt, qty: trade.amount, value: trade.amount * trade.closeRate }]
        : [];
    return { entries, exits };
  }
  const entries: Fill[] = [];
  const exits: Fill[] = [];
  for (const o of trade.orders) {
    if (!(o.filled > 0)) continue;
    if (o.isEntry) entries.push({ at: entryAt(trade, o), qty: o.filled, value: fillValue(o) });
    else exits.push({ at: exitAt(trade, o), qty: o.filled, value: fillValue(o) });
  }
  entries.sort((a, b) => a.at - b.at);
  exits.sort((a, b) => a.at - b.at);
  return { entries, exits };
}

const sum = (xs: readonly number[]): number => xs.reduce((acc, x) => acc + x, 0);

/**
 * entryCost, fees, cost basis, realized, unrealized and total of one trade.
 *
 * `realized` books the exits against the matching share of the cost basis; `unrealized` values what is still held at
 * `mark` net of the exit fee it would cost to sell. A held position without a mark has no unrealized/total (null).
 */
export function computeTradePnl(trade: BotTradeBase, mark: MarkPrice | null): TradePnl {
  const { entries, exits } = tradeFills(trade);
  const entryQty = sum(entries.map((f) => f.qty));
  const entryCost = sum(entries.map((f) => f.value));
  const exitQty = sum(exits.map((f) => f.qty));
  const exitProceeds = sum(exits.map((f) => f.value));

  const feeOpen = trade.feeOpenCost ?? (trade.feeOpenRate !== null ? entryCost * trade.feeOpenRate : 0);
  const feeClose = trade.feeCloseCost ?? (trade.feeCloseRate !== null ? exitProceeds * trade.feeCloseRate : 0);
  const costBasis = entryCost + feeOpen;

  const exitShare = entryQty > 0 ? exitQty / entryQty : 0;
  const realized = exitQty > 0 ? exitProceeds - costBasis * exitShare - feeClose : 0;

  const rawOpenQty = entryQty - exitQty;
  const openQty = rawOpenQty > QTY_EPSILON ? rawOpenQty : 0;

  let unrealized: number | null;
  if (openQty === 0) {
    unrealized = 0;
  } else if (mark === null) {
    unrealized = null;
  } else {
    const exitFeeRate = trade.feeCloseRate ?? trade.feeOpenRate ?? FALLBACK_FEE_RATE;
    unrealized = openQty * mark.price * (1 - exitFeeRate) - costBasis * (openQty / entryQty);
  }
  const total = unrealized === null ? null : realized + unrealized;

  return {
    entryQty,
    exitQty,
    openQty,
    entryCostUsd: entryCost,
    exitProceedsUsd: exitProceeds,
    feesUsd: feeOpen + feeClose,
    costBasisUsd: costBasis,
    realizedUsd: realized,
    unrealizedUsd: unrealized,
    totalUsd: total,
    roiOnStake: total !== null && costBasis > 0 ? total / costBasis : null,
    markPrice: mark?.price ?? null,
    markSource: mark?.source ?? null,
  };
}

export function withPnl(trade: BotTradeBase, mark: MarkPrice | null): BotTrade {
  return { ...trade, pnl: computeTradePnl(trade, mark) };
}

/** Mark for an open trade: the Kraken ticker for its base asset, else the bot's own `current_rate`. */
export function pickMark(trade: BotTradeBase, prices: Record<Asset, number>): MarkPrice | null {
  if (!trade.isOpen) return null;
  const ticker = prices[trade.base];
  if (isPositive(ticker)) return { price: ticker, source: 'kraken' };
  if (isPositive(trade.botCurrentRate)) return { price: trade.botCurrentRate, source: 'bot' };
  return null;
}

/** Quantity of a trade that is still held (0 for closed trades). */
export function openQtyOf(trade: BotTrade): number {
  return trade.isOpen ? trade.pnl.openQty : 0;
}
