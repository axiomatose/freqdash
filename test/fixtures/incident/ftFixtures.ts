// Hand-rolled normalization of the raw freqtrade fixtures (test/fixtures/raw/freqtrade) into the shared domain
// types. Deliberately independent of WP1's normalizers: WP3 tests must not depend on them.
import type { BotOrder, BotTradeBase } from '@/shared/types/domain';
import votemaxStatusRaw from '../raw/freqtrade/votemax_status.json';
import votemaxTradesRaw from '../raw/freqtrade/votemax_trades.json';
import dcaTradesRaw from '../raw/freqtrade/dca_trades.json';

export interface RawFtOrder {
  order_id: string;
  pair: string;
  ft_order_side: string;
  ft_is_entry?: boolean;
  ft_order_tag?: string | null;
  status: string;
  order_type?: string;
  amount: number;
  filled: number;
  remaining: number;
  safe_price: number | null;
  cost: number | null;
  is_open: boolean;
  order_timestamp: number | null;
  order_filled_timestamp: number | null;
}

export interface RawFtTrade {
  trade_id: number;
  pair: string;
  base_currency: string;
  quote_currency: string;
  is_open: boolean;
  strategy: string;
  enter_tag?: string | null;
  exit_reason?: string | null;
  amount: number;
  stake_amount: number;
  max_stake_amount: number;
  open_rate: number;
  close_rate: number | null;
  current_rate?: number | null;
  open_timestamp: number;
  open_fill_timestamp: number | null;
  close_timestamp: number | null;
  fee_open: number | null;
  fee_open_cost: number | null;
  fee_close: number | null;
  fee_close_cost: number | null;
  nr_of_successful_entries: number;
  nr_of_successful_exits: number;
  has_open_orders: boolean;
  profit_abs: number | null;
  orders: RawFtOrder[];
}

export function toBotOrder(botId: string, tradeId: number, o: RawFtOrder): BotOrder {
  const side = o.ft_order_side === 'sell' ? 'sell' : 'buy';
  return {
    botId,
    tradeId,
    orderId: o.order_id,
    pair: o.pair,
    side,
    isEntry: o.ft_is_entry ?? side === 'buy',
    tag: o.ft_order_tag ? o.ft_order_tag : null,
    status: o.status,
    orderType: o.order_type ?? 'limit',
    amount: o.amount,
    filled: o.filled,
    remaining: o.remaining,
    price: o.safe_price,
    cost: o.cost,
    placedAt: o.order_timestamp,
    filledAt: o.order_filled_timestamp,
    isOpen: o.is_open,
  };
}

export function toBotTrade(botId: string, t: RawFtTrade): BotTradeBase {
  return {
    botId,
    tradeId: t.trade_id,
    key: `${botId}:${t.trade_id}`,
    pair: t.pair,
    base: t.base_currency,
    quote: t.quote_currency,
    isOpen: t.is_open,
    strategy: t.strategy,
    enterTag: t.enter_tag ? t.enter_tag : null,
    exitReason: t.exit_reason ? t.exit_reason : null,
    amount: t.amount,
    stakeAmount: t.stake_amount,
    maxStakeAmount: t.max_stake_amount,
    openRate: t.open_rate,
    closeRate: t.close_rate,
    botCurrentRate: t.current_rate ?? null,
    openedAt: t.open_timestamp,
    openFilledAt: t.open_fill_timestamp,
    closedAt: t.close_timestamp,
    feeOpenRate: t.fee_open,
    feeOpenCost: t.fee_open_cost,
    feeCloseRate: t.fee_close,
    feeCloseCost: t.fee_close_cost,
    entries: t.nr_of_successful_entries,
    exits: t.nr_of_successful_exits,
    hasOpenOrders: t.has_open_orders,
    orders: t.orders.map((o) => toBotOrder(botId, t.trade_id, o)),
    ftProfitAbs: t.profit_abs,
  };
}

const votemaxClosed = (votemaxTradesRaw as { trades: RawFtTrade[] }).trades;
const dcaClosed = (dcaTradesRaw as { trades: RawFtTrade[] }).trades;
const votemaxOpen = votemaxStatusRaw as unknown as RawFtTrade[];

/** The three closed votemax trades in the sample (ids 1-3; the API total is 7). */
export const votemaxClosedTrades = (): BotTradeBase[] => votemaxClosed.map((t) => toBotTrade('votemax', t));
/** The three closed dca trades in the sample. */
export const dcaClosedTrades = (): BotTradeBase[] => dcaClosed.map((t) => toBotTrade('dca', t));
/** The open votemax BTC/USD trade 8 from /status. */
export const votemaxOpenTrades = (): BotTradeBase[] => votemaxOpen.map((t) => toBotTrade('votemax', t));

export function rawTrade(bot: 'votemax' | 'dca', tradeId: number): RawFtTrade {
  const src = bot === 'votemax' ? [...votemaxClosed, ...votemaxOpen] : dcaClosed;
  const found = src.find((t) => t.trade_id === tradeId);
  if (!found) throw new Error(`fixture trade ${bot}#${tradeId} not found`);
  return found;
}
