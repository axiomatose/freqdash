import type { BotCard, OverviewResponse } from '@/shared/types/api';
import type { BotId, BotTrade } from '@/shared/types/domain';
import type { BotRuntime } from '@/shared/types/state';
import { equityChange } from '../accounting';
import { listEquity, listEvents, listFindings, listFlows } from '../db';
import { pricesOf } from '../poller/context';
import {
  botSources,
  botStatus,
  countBySeverity,
  freshnessOf,
  isLoopFinding,
  modeOf,
  restarts24h,
  shownFindings,
  toLite,
  type ViewContext,
} from './common';

const DAY = 24 * 3_600_000;

export function buildBotCard(
  ctx: ViewContext,
  bot: BotRuntime,
  restartLoop: boolean,
  events: Parameters<typeof restarts24h>[0],
): BotCard {
  return {
    botId: bot.botId,
    name: bot.name,
    color: bot.color,
    status: botStatus(bot, ctx.now, restartLoop),
    config: bot.config,
    health: bot.health,
    stats: bot.stats,
    uptimeSince: bot.health?.botStartupAt ?? null,
    restarts24h: restarts24h(events, bot.botId, ctx.now),
    sources: botSources(ctx, bot.botId),
  };
}

export function walletUsd(bot: BotRuntime): number | null {
  const w = bot.wallet;
  if (w === null) return null;
  const usd = w.currencies.find((c) => /^Z?USD[TC]?$/i.test(c.currency));
  return usd === undefined ? 0 : usd.balance;
}

export function buildOverview(ctx: ViewContext): OverviewResponse {
  const { mode, reason } = modeOf(ctx);
  const s = ctx.state;
  const active = listFindings({ status: 'active' });
  const { open } = shownFindings(active);
  const events = listEvents({ since: ctx.now - DAY, types: ['startup'] });
  const bots = Object.values(s.bots);

  let change24h: OverviewResponse['change24h'] = null;
  if (s.account !== null) {
    const history = listEquity(ctx.now - DAY - 3_600_000, 500).map((p) => ({ t: p.at, totalUsd: p.totalUsd }));
    const flows = mode === 'kraken' ? listFlows({ since: ctx.now - DAY - 3_600_000 }) : null;
    change24h = equityChange({ now: ctx.now, currentUsd: s.account.totalUsd, history, flows, prices: pricesOf(s) });
  }

  const openPositions: BotTrade[] = bots.flatMap((b) => b.openTrades).sort((a, b) => a.openedAt - b.openedAt);
  const combined = bots.reduce(
    (acc, b) => {
      const st = b.stats;
      if (st === null) return acc;
      acc.realizedUsd += st.realizedUsd;
      acc.unrealizedUsd += st.unrealizedUsd;
      acc.openCostBasisUsd += st.openCostBasisUsd;
      acc.feesUsd += st.feesUsd;
      acc.closedCost += st.closedCostBasisUsd;
      return acc;
    },
    { realizedUsd: 0, unrealizedUsd: 0, openCostBasisUsd: 0, feesUsd: 0, closedCost: 0 },
  );

  return {
    generatedAt: ctx.now,
    mode,
    modeReason: reason,
    account: s.account,
    allocation: s.allocation,
    change24h,
    walletViews: bots.map((b) => ({
      botId: b.botId as BotId,
      usd: walletUsd(b),
      totalUsd: b.wallet?.totalUsd ?? null,
      syncedAt: b.wallet === null ? null : (b.wallet.lastWalletSyncAt ?? b.wallet.fetchedAt),
    })),
    bots: bots.map((b) =>
      buildBotCard(
        ctx,
        b,
        active.some((f) => isLoopFinding(f, b.botId)),
        events,
      ),
    ),
    openPositions,
    combined: {
      realizedUsd: combined.realizedUsd,
      unrealizedUsd: combined.unrealizedUsd,
      totalUsd: combined.realizedUsd + combined.unrealizedUsd,
      openCostBasisUsd: combined.openCostBasisUsd,
      feesUsd: combined.feesUsd,
      roiOnStake: combined.closedCost > 0 ? combined.realizedUsd / combined.closedCost : null,
    },
    findings: { counts: countBySeverity(open), top: open.slice(0, 5).map(toLite) },
    sources: freshnessOf(ctx),
  };
}
