// Bot-level statistics (docs/PLAN.md section 7, "Bot stats").
import type { BotStats, BotTrade, Ms } from '@/shared/types/domain';
import { tradeFills } from './pnl';

interface StakeEvent {
  at: Ms;
  tradeKey: string;
  kind: 'entry' | 'exit';
  qty: number;
  value: number;
}

function stakeEvents(trades: readonly BotTrade[]): StakeEvent[] {
  const events: StakeEvent[] = [];
  for (const t of trades) {
    const { entries, exits } = tradeFills(t);
    for (const f of entries) events.push({ at: f.at, tradeKey: t.key, kind: 'entry', qty: f.qty, value: f.value });
    for (const f of exits) events.push({ at: f.at, tradeKey: t.key, kind: 'exit', qty: f.qty, value: f.value });
  }
  // Exits sort first on a tie, so a same-instant close-and-reopen does not inflate the peak.
  events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'exit' ? -1 : 1));
  return events;
}

/**
 * Highest total stake held at once: an entry fill adds its cost at its fill time, an exit removes the share of that
 * trade's stake that it sells.
 */
export function peakConcurrentStake(trades: readonly BotTrade[]): number {
  const held = new Map<string, { qty: number; stake: number }>();
  let total = 0;
  let peak = 0;
  for (const e of stakeEvents(trades)) {
    const cur = held.get(e.tradeKey) ?? { qty: 0, stake: 0 };
    if (e.kind === 'entry') {
      cur.qty += e.qty;
      cur.stake += e.value;
      total += e.value;
    } else if (cur.qty > 0) {
      const share = Math.min(1, e.qty / cur.qty);
      const removed = cur.stake * share;
      cur.stake -= removed;
      cur.qty = Math.max(0, cur.qty - e.qty);
      total -= removed;
    }
    held.set(e.tradeKey, cur);
    if (total > peak) peak = total;
  }
  return peak;
}

/** Statistics over the union of a bot's open and closed trades (already carrying `pnl`). */
export function computeBotStats(trades: readonly BotTrade[]): BotStats {
  const closed = trades.filter((t) => !t.isOpen);
  const open = trades.filter((t) => t.isOpen);

  const realizedUsd = trades.reduce((acc, t) => acc + t.pnl.realizedUsd, 0);
  const unrealizedUsd = open.reduce((acc, t) => acc + (t.pnl.unrealizedUsd ?? 0), 0);
  const totalUsd = realizedUsd + unrealizedUsd;

  const closedRealized = closed.reduce((acc, t) => acc + t.pnl.realizedUsd, 0);
  const closedCostBasisUsd = closed.reduce((acc, t) => acc + t.pnl.costBasisUsd, 0);
  const wins = closed.filter((t) => t.pnl.realizedUsd > 0).length;
  const losses = closed.filter((t) => t.pnl.realizedUsd < 0).length;

  const held = open.filter((t) => t.pnl.openQty > 0);
  const openCostBasisUsd = held.reduce(
    (acc, t) => acc + (t.pnl.entryQty > 0 ? t.pnl.costBasisUsd * (t.pnl.openQty / t.pnl.entryQty) : 0),
    0,
  );
  const priced = held.every((t) => t.pnl.markPrice !== null);
  const openMarketValueUsd = priced ? held.reduce((acc, t) => acc + t.pnl.openQty * (t.pnl.markPrice ?? 0), 0) : null;

  const peak = peakConcurrentStake(trades);
  const times = trades.map((t) => t.closedAt ?? t.openedAt);

  return {
    closedTrades: closed.length,
    wins,
    losses,
    winRate: closed.length > 0 ? wins / closed.length : null,
    realizedUsd,
    unrealizedUsd,
    totalUsd,
    closedCostBasisUsd,
    roiOnStake: closedCostBasisUsd > 0 ? closedRealized / closedCostBasisUsd : null,
    openTrades: open.length,
    openCostBasisUsd,
    openMarketValueUsd,
    peakConcurrentStakeUsd: peak,
    returnOnPeakStake: peak > 0 ? totalUsd / peak : null,
    feesUsd: trades.reduce((acc, t) => acc + t.pnl.feesUsd, 0),
    firstTradeAt: trades.length > 0 ? Math.min(...trades.map((t) => t.openedAt)) : null,
    lastTradeAt: times.length > 0 ? Math.max(...times) : null,
  };
}
