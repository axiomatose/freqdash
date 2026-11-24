import type { Candle, ChartData, Freshness, KrakenOrder, Ms, Pair } from '@/shared/types/domain';
import type { BotTrade } from '@/shared/types/domain';
import { candleSignals, type PairCandles } from '../freqtrade/candles';
import { buildIndicators } from './indicators';
import { buildFills, buildSignals, type RecordedSignal } from './markers';

export const TF_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};
/** Kraken OHLC interval (minutes) for a freqtrade-style timeframe. */
export const KRAKEN_INTERVAL: Record<string, number> = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

export interface ChartInput {
  botId: string;
  pair: Pair;
  timeframe: string;
  strategyTimeframe: string | null;
  strategy: string | null;
  limit: number;
  now: Ms;
  /** Analyzed dataframe (strategy timeframe only). */
  frame: PairCandles | null;
  plotConfig: unknown;
  /** Kraken OHLC candles for this timeframe (the last one may be the forming candle). */
  kraken: Candle[];
  recorded: RecordedSignal[];
  /** Trades of every bot for this pair. */
  trades: BotTrade[];
  orphans: KrakenOrder[];
  /** The `manual` source only: Kraken orders no bot owns for this pair, and the position they derive. */
  manual?: { orders: KrakenOrder[]; position: { avgPrice: number; qty: number } | null };
  freshness: Freshness[];
  /** Earliest time freqdash recorded a signal, for the DcaBot note. */
  recordedSince: Ms | null;
}

/** Freqtrade's candles up to the last closed one, then Kraken's newer ones (the forming candle is `live`). */
export function mergeCandles(closed: readonly Candle[], kraken: readonly Candle[]): Candle[] {
  const lastClosed = closed[closed.length - 1]?.time ?? -Infinity;
  return [...closed, ...kraken.filter((c) => c.time > lastClosed)].sort((a, b) => a.time - b.time);
}

export function signalsNote(strategy: string | null, since: Ms | null): string | null {
  if (strategy !== 'DcaBot') return null;
  const date = since === null ? 'now' : new Date(since).toISOString().slice(0, 10);
  return `DcaBot marks signals only on the latest candle; earlier markers are those recorded live by freqdash since ${date}`;
}

export function buildChart(i: ChartInput): ChartData {
  const tfSec = TF_SECONDS[i.timeframe] ?? 14_400;
  const withStrategy = i.frame !== null && i.strategyTimeframe === i.timeframe;
  const frame = withStrategy ? i.frame : null;

  const all = frame === null ? [...i.kraken].sort((a, b) => a.time - b.time) : mergeCandles(frame.candles, i.kraken);
  const candles = all.slice(-Math.max(1, i.limit));
  const first = candles[0]?.time ?? 0;

  const signals =
    frame === null ? [] : buildSignals(candleSignals(frame.rows), i.recorded).filter((s) => s.time >= first);
  const fills = buildFills({ trades: i.trades, orphans: i.orphans, manual: i.manual?.orders ?? [], candles, tfSec });
  const inRange = <T extends { points: { time: number }[] }>(s: T): T => ({
    ...s,
    points: s.points.filter((p) => p.time >= first),
  });

  return {
    botId: i.botId,
    pair: i.pair,
    timeframe: i.timeframe,
    source: frame === null ? 'kraken' : 'freqtrade',
    strategy: frame === null ? null : i.strategy,
    candles,
    indicators: frame === null ? [] : buildIndicators(frame.rows, i.plotConfig).map(inRange),
    signals,
    fills,
    positions: i.trades
      .filter((t) => t.isOpen && t.botId === i.botId && t.pnl.openQty > 0)
      .map((t) => ({
        botId: t.botId,
        tradeId: t.tradeId,
        avgPrice: t.pnl.costBasisUsd / Math.max(t.pnl.entryQty, 1e-12),
        qty: t.pnl.openQty,
      }))
      .concat(
        i.manual?.position == null
          ? []
          : [{ botId: i.botId, tradeId: 0, avgPrice: i.manual.position.avgPrice, qty: i.manual.position.qty }],
      ),
    meta: {
      lastAnalyzedAt: frame?.lastAnalyzedAt ?? null,
      dataStopAt: frame?.dataStopAt ?? null,
      liveCandle: candles.some((c) => c.live === true),
      signalsNote: frame === null ? null : signalsNote(i.strategy, i.recordedSince),
    },
    freshness: i.freshness,
  };
}
