import type { BotId, Freshness, Ms, Pair } from './domain';

/** Strategy settings freqtrade reports through `/show_config`, normalized (ratios are fractions, 0.08 = 8 %). */
export interface StrategyParams {
  timeframe: string | null;
  /** minimal_roi as `[minutesOpen, ratio]` pairs sorted by minutes. */
  minimalRoi: [number, number][];
  stoploss: number | null;
  trailingStop: boolean | null;
  trailingStopPositive: number | null;
  trailingStopPositiveOffset: number | null;
  trailingOnlyOffsetIsReached: boolean | null;
  useExitSignal: boolean | null;
  /** When true an exit signal only fires while the bot's own profit estimate is above `exitProfitOffset`. */
  exitProfitOnly: boolean | null;
  exitProfitOffset: number | null;
  ignoreRoiIfEntrySignal: boolean | null;
  positionAdjustmentEnable: boolean | null;
  maxEntryPositionAdjustment: number | null;
  maxOpenTrades: number | null;
  orderTypes: Record<string, unknown> | null;
  /** The `fee` key of the bot config. Freqtrade only honours it in dry-run; live trading asks the exchange. */
  configFee: number | null;
}

/** A place where a fee estimate can change what the bot does. */
export interface FeeSensitivity {
  key: string;
  label: string;
  /** Whether this bot's strategy actually uses the mechanism. */
  active: boolean;
  /** Plain-language description of how a wrong fee estimate shifts the behaviour. */
  effect: string;
  /** Rough size of the shift for the fee gap analysed, in percentage points of trade profit. */
  shiftPoints: number | null;
}

export interface FeeImpactTrade {
  tradeId: number;
  pair: Pair;
  exitReason: string | null;
  closedAt: Ms | null;
  /** Price move close/open - 1, ignoring fees. */
  grossRatio: number;
  feeOpenRate: number;
  feeCloseRate: number;
  /** Profit ratio with the fees actually charged. */
  actualProfitRatio: number;
  /** Profit ratio the bot would have computed with the assumed close fee. */
  assumedProfitRatio: number;
  /** Profit in USD lost to the difference between the assumed and the actual close fee. */
  closeFeeGapUsd: number;
  /** Exit was gated on profit (`exit_profit_only`) and passed on the assumed profit but not on the actual one. */
  gateFlipped: boolean;
}

export interface FeeImpactSummary {
  /** `entry`: each trade's close fee is assumed to equal its entry fill's fee (what freqtrade does); `fixed`: one rate for all. */
  basis: 'entry' | 'fixed';
  /** Average assumed close fee over the replayed trades. */
  assumedCloseFee: number | null;
  actualCloseFeeAvg: number | null;
  /** Assumed minus actual; negative means the bot under-estimated its fees. */
  gapPoints: number | null;
  trades: number;
  totalCloseFeeGapUsd: number;
  gateFlips: number;
  profitGatedExits: number;
}

export interface FeeImpact {
  summary: FeeImpactSummary;
  trades: FeeImpactTrade[];
  sensitivities: FeeSensitivity[];
  note: string;
}

export interface StrategyView {
  botId: BotId;
  botName: string;
  strategy: string | null;
  params: StrategyParams | null;
  /** Names and values of the ALL_CAPS tuning constants declared at class level in the source. */
  constants: { name: string; value: string }[];
  docstring: string | null;
  /** Hooks the source overrides (custom_exit, adjust_trade_position ...), from a plain-text scan. */
  hooks: string[];
  sourceSha256: string | null;
  sourceLines: number | null;
  /** Only present when the request asked for `code=1`. */
  code?: string | null;
  fetchedAt: Ms | null;
  error: string | null;
  feeImpact: FeeImpact | null;
}

export interface StrategiesResponse {
  generatedAt: Ms;
  /** The fixed rate requested, or null when each trade's entry fee is assumed. */
  assumedCloseFee: number | null;
  bots: StrategyView[];
  sources: Freshness[];
}
