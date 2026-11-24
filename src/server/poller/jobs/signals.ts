import { CADENCE_MS } from '@/shared/constants';
import { upsertSignals, type SignalRecord } from '../../db';
import { candleSignals, parsePairCandles } from '../../freqtrade/candles';
import { describeError, log } from '../../log';
import type { PollerContext } from '../context';

// signals.record every 5 minutes per bot x pair: freqtrade's dataframe does not keep historical signals for every
// strategy, so the signals of the newest analyzed candles are stored as they are observed (docs/PLAN.md F9).
const CANDLES = 3;

export async function signalsJob(ctx: PollerContext): Promise<void> {
  for (const [botId, client] of ctx.ft) {
    const bot = ctx.store.get().bots[botId];
    const timeframe = bot?.config?.timeframe;
    if (bot === undefined || !timeframe || bot.whitelist.length === 0) continue;
    for (const pair of bot.whitelist) {
      const res = await client.pairCandles(pair, timeframe, CANDLES);
      if (!res.ok) continue;
      try {
        const rows = parsePairCandles(res.data).rows;
        const seenAt = ctx.now();
        const records: SignalRecord[] = candleSignals(rows)
          .filter((c) => c.enter || c.exit)
          .map((c) => ({
            botId,
            pair,
            timeframe,
            candleAt: c.time * 1000,
            enter: c.enter,
            exit: c.exit,
            enterTag: c.enterTag,
            exitTag: c.exitTag,
            firstSeenAt: seenAt,
          }));
        upsertSignals(records);
      } catch (err) {
        log.warn('could not record signals', { botId, pair, err: describeError(err) });
      }
    }
  }
  ctx.touchCycle();
}

export function registerSignalsJob(ctx: PollerContext): void {
  ctx.scheduler.add({
    name: 'signals.record',
    cadenceMs: CADENCE_MS['signals.record'],
    startDelayMs: 20_000,
    run: () => signalsJob(ctx),
  });
}
