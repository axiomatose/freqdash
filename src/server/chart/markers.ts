import type { BotOrder, BotTrade, Candle, FillMarker, KrakenOrder, Side, SignalMarker } from '@/shared/types/domain';
import type { CandleSignal } from '../freqtrade/candles';

export interface RecordedSignal {
  time: number;
  enter: boolean;
  exit: boolean;
  enterTag: string | null;
  exitTag: string | null;
}

/** Candle open time that a timestamp belongs to; times past the newest candle attach to it (the forming candle). */
export function snapToCandle(sec: number, tfSec: number, candles: readonly Candle[]): number | null {
  const last = candles[candles.length - 1];
  if (last === undefined) return null;
  const snapped = Math.floor(sec / tfSec) * tfSec;
  if (snapped > last.time) return last.time;
  return snapped < (candles[0] as Candle).time ? null : snapped;
}

/** Signals from the dataframe, plus recorded ones for candles the dataframe no longer flags. Sorted by time. */
export function buildSignals(dataframe: readonly CandleSignal[], recorded: readonly RecordedSignal[]): SignalMarker[] {
  const out: SignalMarker[] = [];
  const seen = new Set<string>();
  const push = (time: number, kind: 'enter' | 'exit', tag: string | null, source: SignalMarker['source']): void => {
    const key = `${time}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ time, kind, tag, source });
  };
  for (const s of dataframe) {
    if (s.enter) push(s.time, 'enter', s.enterTag, 'dataframe');
    if (s.exit) push(s.time, 'exit', s.exitTag, 'dataframe');
  }
  for (const s of recorded) {
    if (s.enter) push(s.time, 'enter', s.enterTag, 'recorded');
    if (s.exit) push(s.time, 'exit', s.exitTag, 'recorded');
  }
  return out.sort((a, b) => a.time - b.time || (a.kind === b.kind ? 0 : a.kind === 'enter' ? -1 : 1));
}

function botFill(trade: BotTrade, o: BotOrder, time: number): FillMarker | null {
  const at = o.filledAt ?? o.placedAt;
  if (at === null || o.filled <= 0 || o.price === null) return null;
  return {
    time,
    at,
    botId: trade.botId,
    tradeId: trade.tradeId,
    orderId: o.orderId,
    side: o.side,
    isEntry: o.isEntry,
    price: o.price,
    qty: o.filled,
    costUsd: o.filled * o.price,
    tag: o.isEntry ? trade.enterTag : trade.exitReason,
    origin: 'bot',
  };
}

export function buildFills(input: {
  trades: readonly BotTrade[];
  orphans: readonly KrakenOrder[];
  /** Kraken orders of a manually held asset (no bot owns them): drawn as the user's own entries and exits. */
  manual?: readonly KrakenOrder[];
  candles: readonly Candle[];
  tfSec: number;
}): FillMarker[] {
  const out: FillMarker[] = [];
  for (const t of input.trades) {
    for (const o of t.orders) {
      const at = o.filledAt ?? o.placedAt;
      const time = at === null ? null : snapToCandle(Math.floor(at / 1000), input.tfSec, input.candles);
      if (time === null) continue;
      const fill = botFill(t, o, time);
      if (fill !== null) out.push(fill);
    }
  }
  const krakenFills: [readonly KrakenOrder[], FillMarker['origin']][] = [
    [input.orphans, 'kraken-orphan'],
    [input.manual ?? [], 'kraken-manual'],
  ];
  for (const [orders, origin] of krakenFills)
    for (const k of orders) {
      const at = k.closedAt ?? k.openedAt;
      const time = snapToCandle(Math.floor(at / 1000), input.tfSec, input.candles);
      const price = k.avgPrice ?? k.limitPrice;
      if (time === null || price === null || k.volExec <= 0) continue;
      out.push({
        time,
        at,
        botId: null,
        tradeId: null,
        orderId: k.txid,
        side: k.side as Side,
        isEntry: k.side === 'buy',
        price,
        qty: k.volExec,
        costUsd: k.costUsd,
        tag: null,
        origin,
      });
    }
  return out.sort((a, b) => a.time - b.time || a.at - b.at || a.orderId.localeCompare(b.orderId));
}
