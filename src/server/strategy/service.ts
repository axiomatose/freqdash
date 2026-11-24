import type { StrategiesResponse, StrategyParams, StrategyView } from '@/shared/types/strategy';
import { getPollerHandle } from '../boot';
import { SingleFlightCache } from '../chart/cache';
import { describeError } from '../log';
import { currentViewContext, freshnessOf } from '../views/common';
import { analyzeFeeImpact } from './feeImpact';
import { readParams, readSource, withSourceFallback, type SourceFacts } from './source';

export class StrategyError extends Error {
  constructor(
    readonly code: 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

interface Loaded {
  strategy: string;
  params: StrategyParams;
  facts: SourceFacts;
  code: string;
}

// Strategy files change rarely: five minutes of cache, one upstream read per bot at a time.
const cache = new SingleFlightCache<Loaded>({ ttlMs: 5 * 60_000, minRefetchMs: 30_000 });

export async function getStrategies(opts: {
  includeCode: boolean;
  assumedCloseFee: number | null;
}): Promise<StrategiesResponse> {
  const handle = getPollerHandle();
  if (handle === null) throw new StrategyError('unavailable', 'the poller is not running');
  const view = currentViewContext();
  const bots: StrategyView[] = [];

  for (const [botId, bot] of Object.entries(view.state.bots)) {
    const client = handle.ctx.ft.get(botId);
    const base: StrategyView = {
      botId,
      botName: bot.name,
      strategy: bot.config?.strategy ?? null,
      params: null,
      constants: [],
      docstring: null,
      hooks: [],
      sourceSha256: null,
      sourceLines: null,
      fetchedAt: null,
      error: null,
      feeImpact: null,
    };
    if (client === undefined) {
      bots.push({ ...base, error: 'bot is not configured' });
      continue;
    }
    try {
      const entry = await cache.get(botId, async () => {
        const cfg = await client.showConfig();
        if (!cfg.ok) throw new Error(`show_config: ${cfg.error.message}`);
        const name = typeof cfg.data.strategy === 'string' ? cfg.data.strategy : null;
        if (name === null) throw new Error('the bot reports no strategy name');
        const src = await client.strategy(name);
        if (!src.ok) throw new Error(`strategy: ${src.error.message}`);
        const code = typeof src.data.code === 'string' ? src.data.code : '';
        return {
          strategy: name,
          params: withSourceFallback(readParams(cfg.data), code),
          facts: readSource(code),
          code,
        };
      });
      const l = entry.value;
      bots.push({
        ...base,
        strategy: l.strategy,
        params: l.params,
        constants: l.facts.constants,
        docstring: l.facts.docstring,
        hooks: l.facts.hooks,
        sourceSha256: l.facts.sha256,
        sourceLines: l.facts.lines,
        ...(opts.includeCode ? { code: l.code } : {}),
        fetchedAt: entry.fetchedAt,
        feeImpact: analyzeFeeImpact({
          params: l.params,
          closedTrades: bot.closedTrades,
          assumedCloseFee: opts.assumedCloseFee,
        }),
      });
    } catch (err) {
      bots.push({ ...base, error: describeError(err) });
    }
  }

  return {
    generatedAt: view.now,
    assumedCloseFee: opts.assumedCloseFee,
    bots,
    sources: freshnessOf(view, (k) => /^bot:[^:]+:(config|trades)$/.test(k)),
  };
}
