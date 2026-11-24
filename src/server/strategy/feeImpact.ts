import type { BotTradeBase } from '@/shared/types/domain';
import type { FeeImpact, FeeImpactTrade, FeeSensitivity, StrategyParams } from '@/shared/types/strategy';

// Pure: how much would a wrong fee estimate have changed a strategy's decisions?
//
// Freqtrade never lets a strategy see a fee directly. It computes every profit ratio as
//   close_value / open_value - 1,  open_value = open * amount * (1 + fee_open),  close_value = close * amount * (1 - fee_close)
// and the strategy gates (exit_profit_only, trailing offset, minimal_roi, stoploss, custom_exit profit checks) compare that
// ratio with fixed thresholds. While a trade is open, fee_open is the entry fill's real fee but fee_close is still the
// estimate freqtrade took from the exchange when the entry was placed. So a bot that believes the close fee is 0.16 %
// while Kraken charges 0.40 % overstates every profit ratio by about the gap.

/** Profit ratio freqtrade computes for a closed trade, for given fee rates. */
export function profitRatio(openRate: number, closeRate: number, feeOpen: number, feeClose: number): number {
  return (closeRate * (1 - feeClose)) / (openRate * (1 + feeOpen)) - 1;
}

export interface FeeImpactInput {
  params: StrategyParams | null;
  closedTrades: readonly BotTradeBase[];
  /**
   * The close fee the bot believed while the trade was open. `null` (the default) uses each trade's own entry fee: after
   * an entry fills, freqtrade sets the trade's close fee to the entry fill's fee rate as an educated guess (`Trade.update_fee`).
   * A number replays every trade with that fixed rate instead.
   */
  assumedCloseFee: number | null;
}

const pct = (v: number): string => `${(v * 100).toFixed(2)} points`;

function sensitivities(p: StrategyParams | null, gap: number | null): FeeSensitivity[] {
  const shift = gap === null ? null : Math.abs(gap) * 100;
  const gapText = gap === null ? 'the fee gap' : pct(Math.abs(gap));
  const dir = gap !== null && gap < 0 ? 'overstates' : 'understates';
  const trailing = p?.trailingStop === true;
  const roi = (p?.minimalRoi.length ?? 0) > 0;
  const sensitive: FeeSensitivity[] = [
    {
      key: 'exit_profit_only',
      label: 'Profit-only exit signals',
      active: p?.exitProfitOnly === true && p?.useExitSignal !== false,
      effect: `An exit signal only fires while the bot's profit estimate is above ${p?.exitProfitOffset ?? 0}. A close fee that is too low ${dir} that profit by about ${gapText}, so a marginal exit can happen at a real net loss.`,
      shiftPoints: shift,
    },
    {
      key: 'trailing_stop',
      label: 'Trailing stop offset and distance',
      active: trailing,
      effect: `The trailing stop arms at ${p?.trailingStopPositiveOffset ?? '?'} and trails ${p?.trailingStopPositive ?? '?'} from the peak, both measured on the fee-adjusted profit ratio. A wrong fee moves the arming point by about ${gapText}: negligible.`,
      shiftPoints: shift,
    },
    {
      key: 'minimal_roi',
      label: 'ROI target',
      active: roi,
      effect: `The ROI table is compared with the same profit ratio, so targets shift by about ${gapText}.`,
      shiftPoints: shift,
    },
    {
      key: 'stoploss',
      label: 'Stoploss',
      active: p?.stoploss !== null && p?.stoploss !== undefined && p.stoploss > -0.5,
      effect: `A stoploss compares the fee-adjusted ratio, so it triggers about ${gapText} early or late.`,
      shiftPoints: shift,
    },
    {
      key: 'entries',
      label: 'Entry signals and stake size',
      active: false,
      effect: 'Entries come from indicators and wallet size; no fee is used, so nothing changes.',
      shiftPoints: 0,
    },
  ];
  return sensitive;
}

export function analyzeFeeImpact({ params, closedTrades, assumedCloseFee }: FeeImpactInput): FeeImpact {
  const offset = params?.exitProfitOffset ?? 0;
  const gated = params?.exitProfitOnly === true;
  const rows: FeeImpactTrade[] = [];
  let feeSum = 0;
  let believedSum = 0;
  let gapUsd = 0;
  let flips = 0;
  let gatedExits = 0;

  for (const t of closedTrades) {
    if (t.isOpen || t.closeRate === null || t.feeOpenRate === null || t.feeCloseRate === null) continue;
    if (!(t.openRate > 0) || !(t.closeRate > 0)) continue;
    const actual = profitRatio(t.openRate, t.closeRate, t.feeOpenRate, t.feeCloseRate);
    const believedFee = assumedCloseFee ?? t.feeOpenRate;
    const assumed = profitRatio(t.openRate, t.closeRate, t.feeOpenRate, believedFee);
    const gapUsdTrade = t.closeRate * t.amount * (t.feeCloseRate - believedFee);
    const isSignalExit =
      t.exitReason !== null && /exit|signal/i.test(t.exitReason) && !/trailing|roi|stop/i.test(t.exitReason);
    const flipped = gated && isSignalExit && assumed > offset && actual <= offset;
    if (gated && isSignalExit) gatedExits += 1;
    if (flipped) flips += 1;
    feeSum += t.feeCloseRate;
    believedSum += believedFee;
    gapUsd += gapUsdTrade;
    rows.push({
      tradeId: t.tradeId,
      pair: t.pair,
      exitReason: t.exitReason,
      closedAt: t.closedAt,
      grossRatio: t.closeRate / t.openRate - 1,
      feeOpenRate: t.feeOpenRate,
      feeCloseRate: t.feeCloseRate,
      actualProfitRatio: actual,
      assumedProfitRatio: assumed,
      closeFeeGapUsd: gapUsdTrade,
      gateFlipped: flipped,
    });
  }

  const avg = rows.length > 0 ? feeSum / rows.length : null;
  const believedAvg = rows.length > 0 ? believedSum / rows.length : null;
  const gap = avg === null || believedAvg === null ? null : believedAvg - avg;
  return {
    summary: {
      basis: assumedCloseFee === null ? 'entry' : 'fixed',
      assumedCloseFee: believedAvg,
      actualCloseFeeAvg: avg,
      gapPoints: gap === null ? null : gap * 100,
      trades: rows.length,
      totalCloseFeeGapUsd: gapUsd,
      gateFlips: flips,
      profitGatedExits: gatedExits,
    },
    trades: rows.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    sensitivities: sensitivities(params, gap),
    note:
      'Replay of closed trades with the fees Kraken actually charged versus the close fee the bot believed while the trade was open. ' +
      (assumedCloseFee === null
        ? "By default that is the trade's own entry fee, which is what freqtrade assumes once the entry has filled. "
        : 'A fixed close fee was requested, so every trade is replayed with it. ') +
      'The exchange fee override (exchange.ccxt_config.fees) only sets the estimate between placing an order and its fill and is not visible through the freqtrade API.',
  };
}
