import { z } from 'zod';

// Lenient raw-response schemas for the freqtrade REST API (docs/PLAN.md section 6.1 and the F-table in section 1).
// Objects are loose (unknown keys pass through) and every leaf we do not need for identity is nullish and falls back
// to null on a wrong type, so a freqtrade version drift never fails a whole poll because of one odd field.
// Only identity fields (trade_id, pair, order_id, the container shapes) are required.

const lnum = z.number().nullish().catch(null);
const lstr = z.string().nullish().catch(null);
const lbool = z.boolean().nullish().catch(null);

export const ftPingSchema = z.looseObject({ status: lstr });

/** `/health`: the `*_ts` fields are epoch SECONDS (F4). */
export const ftHealthSchema = z.looseObject({
  last_process: lstr,
  last_process_ts: lnum,
  bot_start: lstr,
  bot_start_ts: lnum,
  bot_startup: lstr,
  bot_startup_ts: lnum,
});

export const ftShowConfigSchema = z.looseObject({
  version: lstr,
  bot_name: lstr,
  strategy: lstr,
  timeframe: lstr,
  timeframe_ms: lnum,
  stake_currency: lstr,
  max_open_trades: lnum,
  dry_run: lbool,
  trading_mode: lstr,
  state: lstr,
  runmode: lstr,
  position_adjustment_enable: lbool,
  exchange: lstr,
});

/**
 * An order inside a trade. `/status` orders lack ft_is_entry, average, price and order_date (F2); `/trades` orders have
 * them. Timestamps (`*_timestamp`) are epoch MS; the `*_date` strings carry no timezone and are never read.
 */
export const ftOrderSchema = z.looseObject({
  order_id: z.string(),
  pair: lstr,
  status: lstr,
  order_type: lstr,
  ft_order_side: lstr,
  ft_is_entry: lbool,
  ft_order_tag: lstr,
  amount: lnum,
  filled: lnum,
  remaining: lnum,
  price: lnum,
  average: lnum,
  safe_price: lnum,
  cost: lnum,
  is_open: lbool,
  order_timestamp: lnum,
  order_filled_timestamp: lnum,
});

export const ftTradeSchema = z.looseObject({
  trade_id: z.number(),
  pair: z.string(),
  base_currency: lstr,
  quote_currency: lstr,
  is_open: lbool,
  strategy: lstr,
  enter_tag: lstr,
  exit_reason: lstr,
  amount: lnum,
  stake_amount: lnum,
  max_stake_amount: lnum,
  open_rate: lnum,
  close_rate: lnum,
  current_rate: lnum,
  open_timestamp: lnum,
  open_fill_timestamp: lnum,
  close_timestamp: lnum,
  fee_open: lnum,
  fee_open_cost: lnum,
  fee_close: lnum,
  fee_close_cost: lnum,
  nr_of_successful_entries: lnum,
  nr_of_successful_exits: lnum,
  has_open_orders: lbool,
  profit_abs: lnum,
  close_profit_abs: lnum,
  total_profit_abs: lnum,
  orders: z
    .array(ftOrderSchema)
    .nullish()
    .transform((v) => v ?? []),
});

/** `/status`: open trades, a bare array. */
export const ftStatusSchema = z.array(ftTradeSchema);

/** `/trades` page: closed trades only (F1). */
export const ftTradesPageSchema = z.looseObject({
  trades: z.array(ftTradeSchema),
  trades_count: lnum,
  offset: lnum,
  total_trades: lnum,
});

export const ftBalanceCurrencySchema = z.looseObject({
  currency: z.string(),
  balance: lnum,
  free: lnum,
  used: lnum,
  bot_owned: lnum,
  est_stake: lnum,
  est_stake_bot: lnum,
  stake: lstr,
  is_bot_managed: lbool,
});

export const ftBalanceSchema = z.looseObject({
  currencies: z.array(ftBalanceCurrencySchema),
  total: lnum,
  total_bot: lnum,
  stake: lstr,
});

export const ftWhitelistSchema = z.looseObject({
  whitelist: z.array(z.string()),
});

export const ftLockSchema = z.looseObject({
  pair: z.string(),
  reason: lstr,
  active: lbool,
  lock_end_timestamp: lnum,
});

export const ftLocksSchema = z.looseObject({
  lock_count: lnum,
  locks: z.array(ftLockSchema),
});

/**
 * `/logs`: rows are `[asctime, created_ms, logger, level, message]`. The sample fixtures truncate inner arrays to three
 * items, so rows stay unvalidated here and parseApiLogs() picks them apart.
 */
export const ftLogsSchema = z.looseObject({
  log_count: lnum,
  logs: z.array(z.array(z.unknown())),
});

export const ftPlotConfigSchema = z.looseObject({});

/** `/strategy/<name>`: the strategy's source file as text. */
export const ftStrategySchema = z.looseObject({ strategy: lstr, code: lstr });
export type FtStrategyRaw = z.infer<typeof ftStrategySchema>;

/** `/pair_candles`: `data` rows follow `columns` (which includes __date_ts). last_analyzed_ts is SECONDS, the rest MS (F4). */
export const ftPairCandlesSchema = z.looseObject({
  strategy: lstr,
  pair: lstr,
  timeframe: lstr,
  timeframe_ms: lnum,
  columns: z.array(z.string()),
  data: z.array(z.array(z.unknown())),
  length: lnum,
  last_analyzed_ts: lnum,
  data_start_ts: lnum,
  data_stop_ts: lnum,
});

export type FtHealthRaw = z.infer<typeof ftHealthSchema>;
export type FtShowConfigRaw = z.infer<typeof ftShowConfigSchema>;
export type FtOrderRaw = z.infer<typeof ftOrderSchema>;
export type FtTradeRaw = z.infer<typeof ftTradeSchema>;
export type FtTradesPageRaw = z.infer<typeof ftTradesPageSchema>;
export type FtBalanceRaw = z.infer<typeof ftBalanceSchema>;
export type FtWhitelistRaw = z.infer<typeof ftWhitelistSchema>;
export type FtLocksRaw = z.infer<typeof ftLocksSchema>;
export type FtLogsRaw = z.infer<typeof ftLogsSchema>;
export type FtPlotConfigRaw = z.infer<typeof ftPlotConfigSchema>;
export type FtPairCandlesRaw = z.infer<typeof ftPairCandlesSchema>;

/** One-line, path-qualified description of the first validation problem (no values, so nothing sensitive leaks). */
export function describeZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'invalid response shape';
  const path = issue.path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');
  return `${path || '(root)'}: ${issue.message}`;
}
