import type { ChartData, KrakenOrder, Pair } from '@/shared/types/domain';
import { getPollerHandle } from '../boot';
import { readLedger, replayAsset } from '../accounting';
import { getKnownOrders, listAcks, listKrakenOrders, listLedgerEntries, listSignals } from '../db';
import { parsePairCandles, type PairCandles } from '../freqtrade/candles';
import { normalizeOhlc } from '../kraken/normalize';
import type { OhlcResult } from '../kraken/types';
import { freshnessOf, currentViewContext } from '../views/common';
import { excludedTxids } from '../views/positions';
import { buildChart, KRAKEN_INTERVAL, TF_SECONDS } from './builder';
import { SingleFlightCache } from './cache';

export class ChartError extends Error {
  constructor(
    readonly code: 'not_found' | 'bad_request' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const FRAME_LIMIT = 1000;

const frames = new SingleFlightCache<PairCandles>({
  // A new candle has closed and freqtrade has had time to analyze it.
  isOutdated: (f, now) =>
    f.dataStopAt !== null && f.timeframeMs !== null && now >= f.dataStopAt + 2 * f.timeframeMs + 30_000,
});
const ohlc = new SingleFlightCache<OhlcResult>({ ttlMs: 60_000, minRefetchMs: 30_000 });

function altname(pair: Pair, catalogAlt: string | undefined): string {
  return catalogAlt ?? pair.replace('/', '').replace(/^BTC/, 'XBT');
}

/** The pseudo-bot id for the third chart: manually held assets, drawn from Kraken orders no bot owns. */
export const MANUAL_SOURCE = 'manual';

async function krakenCandles(ctx: NonNullable<ReturnType<typeof getPollerHandle>>['ctx'], pair: Pair, tf: string) {
  const interval = KRAKEN_INTERVAL[tf];
  if (interval === undefined) throw new ChartError('bad_request', 'unsupported timeframe');
  const name = altname(pair, ctx.catalog.resolvePair(pair)?.altname);
  try {
    return (
      await ohlc.get(`${name}|${interval}`, async () => normalizeOhlc(await ctx.krakenPublic.ohlc(name, interval)))
    ).value.candles;
  } catch {
    throw new ChartError('unavailable', 'Kraken market data is unavailable');
  }
}

async function getManualChart(p: { pair: Pair; tf: string; limit: number }): Promise<ChartData> {
  const handle = getPollerHandle();
  if (handle === null) throw new ChartError('unavailable', 'the poller is not running');
  const view = currentViewContext();
  if (!view.kraken.configured) throw new ChartError('unavailable', 'manual holdings need Kraken');
  const [base, quote] = p.pair.split('/');
  const acks = listAcks(view.now);
  if (quote !== 'USD' || !acks.some((a) => a.kind === 'asset' && a.label === 'manual' && a.subject === base)) {
    throw new ChartError('not_found', 'pair is not a manual holding');
  }
  if (!(p.tf in TF_SECONDS)) throw new ChartError('bad_request', 'unsupported timeframe');

  const candles = await krakenCandles(handle.ctx, p.pair, p.tf);
  const exclude = excludedTxids(view, acks);
  const orders = listKrakenOrders({ pair: p.pair }).filter((o) => !exclude.has(o.txid));
  const ledger = listLedgerEntries({ assets: [base as string, 'USD'] });
  const replay = replayAsset(base as string, orders, exclude, ledger);
  // Buy Crypto and Convert leave no order: draw their ledger trades like orders.
  const ledgerFills: KrakenOrder[] = readLedger(base as string, ledger, listKrakenOrders({ pair: p.pair })).trades.map(
    (t) => ({
      txid: t.refid,
      pair: p.pair,
      krakenPair: p.pair.replace('/', ''),
      side: t.side,
      orderType: 'ledger',
      status: 'closed',
      openedAt: t.at,
      closedAt: t.at,
      vol: t.qty,
      volExec: t.qty,
      costUsd: t.costUsd,
      feeUsd: t.feeUsd,
      avgPrice: t.costUsd / t.qty,
      limitPrice: null,
      userref: null,
      clOrdId: null,
      reason: null,
    }),
  );
  return buildChart({
    botId: MANUAL_SOURCE,
    pair: p.pair,
    timeframe: p.tf,
    strategyTimeframe: null,
    strategy: null,
    limit: p.limit,
    now: view.now,
    frame: null,
    plotConfig: null,
    kraken: candles,
    recorded: [],
    trades: [],
    orphans: [],
    manual: {
      orders: [...orders, ...ledgerFills],
      position: replay.qty > 0 ? { avgPrice: replay.gross / replay.qty, qty: replay.qty } : null,
    },
    freshness: freshnessOf(view, (k) => k === 'market:ticker' || k.startsWith('kraken:')),
    recordedSince: null,
  });
}

export async function getChart(p: { bot: string; pair: Pair; tf: string; limit: number }): Promise<ChartData> {
  if (p.bot === MANUAL_SOURCE) return getManualChart(p);
  const handle = getPollerHandle();
  if (handle === null) throw new ChartError('unavailable', 'the poller is not running');
  const ctx = handle.ctx;
  const view = currentViewContext();
  const bot = view.state.bots[p.bot];
  if (bot === undefined) throw new ChartError('not_found', 'unknown bot');
  if (!(p.tf in TF_SECONDS)) throw new ChartError('bad_request', 'unsupported timeframe');
  if (bot.whitelist.length > 0 && !bot.whitelist.includes(p.pair) && bot.openTrades.every((t) => t.pair !== p.pair)) {
    throw new ChartError('not_found', 'pair is not traded by this bot');
  }

  const strategyTf = bot.config?.timeframe ?? null;
  const client = ctx.ft.get(p.bot);
  let frame: PairCandles | null = null;
  if (strategyTf === p.tf && client !== undefined) {
    const entry = await frames.get(`${p.bot}|${p.pair}|${p.tf}`, async () => {
      const res = await client.pairCandles(p.pair, p.tf, FRAME_LIMIT);
      if (!res.ok) throw new Error(res.error.message);
      return parsePairCandles(res.data);
    });
    frame = entry.value;
  }

  let kraken: OhlcResult | null = null;
  const interval = KRAKEN_INTERVAL[p.tf];
  if (interval !== undefined) {
    const name = altname(p.pair, ctx.catalog.resolvePair(p.pair)?.altname);
    try {
      kraken = (
        await ohlc.get(`${name}|${interval}`, async () => normalizeOhlc(await ctx.krakenPublic.ohlc(name, interval)))
      ).value;
    } catch {
      // The dataframe alone is still a usable chart; a price-only chart without Kraken is not.
      if (frame === null) throw new ChartError('unavailable', 'Kraken market data is unavailable');
    }
  }
  if (frame === null && kraken === null) throw new ChartError('unavailable', 'no candle source for this timeframe');

  const trades = Object.values(view.state.bots)
    .flatMap((b) => [...b.openTrades, ...b.closedTrades])
    .filter((t) => t.pair === p.pair);

  const recordedRows = listSignals({ botId: p.bot, pair: p.pair, timeframe: p.tf });
  const known = new Set(Object.keys(getKnownOrders()));
  for (const t of trades) for (const o of t.orders) known.add(o.orderId);
  const acked = new Set(listAcks(view.now, { kind: 'kraken_order' }).map((a) => a.subject));
  const orphans = view.kraken.configured
    ? listKrakenOrders({
        ...(view.kraken.reconStartAt === null ? {} : { since: view.kraken.reconStartAt }),
        pair: p.pair,
      }).filter((o) => !known.has(o.txid) && !acked.has(o.txid))
    : [];

  return buildChart({
    botId: p.bot,
    pair: p.pair,
    timeframe: p.tf,
    strategyTimeframe: strategyTf,
    strategy: bot.config?.strategy ?? null,
    limit: p.limit,
    now: view.now,
    frame,
    plotConfig: bot.plotConfig,
    kraken: kraken?.candles ?? [],
    recorded: recordedRows.map((s) => ({
      time: Math.floor(s.candleAt / 1000),
      enter: s.enter,
      exit: s.exit,
      enterTag: s.enterTag,
      exitTag: s.exitTag,
    })),
    trades,
    orphans,
    freshness: freshnessOf(view, (k) => k === `bot:${p.bot}:status` || k === 'market:ticker'),
    recordedSince: recordedRows.length === 0 ? null : Math.min(...recordedRows.map((s) => s.firstSeenAt)),
  });
}
