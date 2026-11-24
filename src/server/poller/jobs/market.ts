import { CADENCE_MS, sourceKey } from '@/shared/constants';
import type { Asset } from '@/shared/types/domain';
import { buildAssetCatalog } from '../../kraken/assets';
import { normalizeTicker } from '../../kraken/normalize';
import { isRecord, toNumber } from '../../kraken/types';
import type { PollerContext } from '../context';

// Public Kraken market data (no key needed): prices every 20 s, clock skew every 10 min, asset catalog daily.

/** Assets whose USD price matters: everything held, everything a bot trades or holds, and the stake currency. */
export function assetsToPrice(ctx: PollerContext): Set<Asset> {
  const s = ctx.store.get();
  const assets = new Set<Asset>();
  for (const b of s.kraken.balances ?? []) assets.add(b.asset);
  for (const bot of Object.values(s.bots)) {
    for (const pair of bot.whitelist) assets.add(pair.split('/')[0] as string);
    for (const t of bot.openTrades) assets.add(t.base);
    for (const c of bot.wallet?.currencies ?? []) assets.add(c.currency);
  }
  assets.delete('USD');
  return assets;
}

export async function tickerJob(ctx: PollerContext): Promise<void> {
  const key = sourceKey.market('ticker');
  const label = 'Kraken prices';
  const cadence = CADENCE_MS['market.ticker'];
  try {
    await ctx.ensureCatalog();
    const pairs = ctx.catalog.tickerPairsFor(assetsToPrice(ctx));
    if (pairs.length > 0) {
      const raw = await ctx.krakenPublic.ticker(pairs);
      const prices = normalizeTicker(raw, ctx.catalog, ctx.now());
      ctx.store.update((s) => {
        Object.assign(s.market.prices, prices);
      });
      ctx.recompute();
      ctx.store.requestRecheck();
    }
    ctx.recordOk(key, label, cadence);
  } catch (err) {
    ctx.recordFail(key, label, cadence, err);
    throw err;
  } finally {
    ctx.touchCycle();
  }
}

export async function timeJob(ctx: PollerContext): Promise<void> {
  const key = sourceKey.market('time');
  const label = 'Kraken clock';
  const cadence = CADENCE_MS['market.time'];
  try {
    const sent = ctx.now();
    const raw = await ctx.krakenPublic.time();
    const received = ctx.now();
    const result = isRecord(raw) && isRecord(raw.result) ? raw.result : raw;
    const unix = isRecord(result) ? toNumber(result.unixtime) : null;
    if (unix === null) throw new Error('Kraken Time returned no unixtime');
    const skew = Math.round(unix * 1000 - (sent + received) / 2);
    ctx.store.update((s) => {
      s.market.clockSkewMs = skew;
    });
    ctx.store.requestRecheck();
    ctx.recordOk(key, label, cadence);
  } catch (err) {
    ctx.recordFail(key, label, cadence, err);
    throw err;
  }
}

export async function catalogJob(ctx: PollerContext): Promise<void> {
  const key = sourceKey.market('catalog');
  const label = 'Kraken asset catalog';
  const cadence = CADENCE_MS['market.catalog'];
  try {
    const [assets, pairs] = await Promise.all([ctx.krakenPublic.assets(), ctx.krakenPublic.assetPairs()]);
    ctx.catalog = buildAssetCatalog(assets, pairs);
    ctx.catalogReady = true;
    ctx.recordOk(key, label, cadence);
  } catch (err) {
    ctx.recordFail(key, label, cadence, err);
    throw err;
  }
}

export function registerMarketJobs(ctx: PollerContext): void {
  ctx.scheduler.add({
    name: 'market.catalog',
    cadenceMs: CADENCE_MS['market.catalog'],
    startDelayMs: 0,
    run: () => catalogJob(ctx),
  });
  ctx.scheduler.add({
    name: 'market.ticker',
    cadenceMs: CADENCE_MS['market.ticker'],
    startDelayMs: 1500,
    run: () => tickerJob(ctx),
  });
  ctx.scheduler.add({
    name: 'market.time',
    cadenceMs: CADENCE_MS['market.time'],
    startDelayMs: 500,
    run: () => timeJob(ctx),
  });
}
