import type { BotDetailResponse } from '@/shared/types/api';
import type { BotId } from '@/shared/types/domain';
import { listEvents, listFindings } from '../db';
import { buildBotCard } from './overview';
import { botSourceKeys, freshnessOf, isLoopFinding, type ViewContext } from './common';

const RECENT_CLOSED = 20;
const EVENT_LIMIT = 100;
const EVENT_WINDOW_MS = 7 * 24 * 3_600_000;

/** null when the bot id is unknown (the route answers 404). */
export function buildBotDetail(ctx: ViewContext, botId: BotId): BotDetailResponse | null {
  const bot = ctx.state.bots[botId];
  if (bot === undefined) return null;
  const active = listFindings({ status: 'active' });
  const startups = listEvents({ botId, since: ctx.now - 24 * 3_600_000, types: ['startup'] });

  const closed = [...bot.closedTrades].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const pairs = new Map<string, { closedTrades: number; realized: number; cost: number; openQty: number }>();
  const row = (pair: string) => {
    let r = pairs.get(pair);
    if (r === undefined) {
      r = { closedTrades: 0, realized: 0, cost: 0, openQty: 0 };
      pairs.set(pair, r);
    }
    return r;
  };
  for (const t of closed) {
    const r = row(t.pair);
    r.closedTrades += 1;
    r.realized += t.pnl.realizedUsd;
    r.cost += t.pnl.costBasisUsd;
  }
  for (const t of bot.openTrades) row(t.pair).openQty += t.pnl.openQty;

  return {
    generatedAt: ctx.now,
    bot: buildBotCard(
      ctx,
      bot,
      active.some((f) => isLoopFinding(f, botId)),
      startups,
    ),
    openTrades: [...bot.openTrades].sort((a, b) => b.openedAt - a.openedAt),
    recentClosed: closed.slice(0, RECENT_CLOSED),
    perPair: [...pairs.entries()]
      .map(([pair, r]) => ({
        pair,
        closedTrades: r.closedTrades,
        realizedUsd: r.realized,
        roiOnStake: r.cost > 0 ? r.realized / r.cost : null,
        openQty: r.openQty,
      }))
      .sort((a, b) => b.realizedUsd - a.realizedUsd),
    events: listEvents({ botId, since: ctx.now - EVENT_WINDOW_MS, limit: EVENT_LIMIT }),
    whitelist: bot.whitelist,
    locks: bot.locks,
    wallet: bot.wallet,
    sources: freshnessOf(ctx, botSourceKeys(botId)),
  };
}
