import 'server-only';
import type { BotId, BotTrade, Ms } from '@/shared/types/domain';
import { claimPushTradeEvent, getMetaNumber, setMeta } from '../db';
import { describeError, log } from '../log';
import type { TradePushEvent } from './service';

// Entries and exits for Web Push, derived from the trades the poller already fetches:
//  * an entry is a bot entry order that finished with something filled (the first one opens the trade, later ones
//    are position adds, e.g. DCA safety orders);
//  * an exit is a trade that closed.
// Each event is announced once (push_trade_events), only if it happened after push announcements started (so the first
// deploy does not replay history) and within the last 6 hours (so a long outage does not flood the phone).

const SINCE_META = 'push_trades_since';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const money = (v: number): string =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedMoney = (v: number): string => (v > 0 ? `+${money(v)}` : money(v));
const price = (v: number): string =>
  v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 8, minimumFractionDigits: 0 });
const qty = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 8 });

export function formatHeld(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Every entry and exit visible in `trades` (pure; no time gate, no dedupe). */
export function tradeEventCandidates(botName: string, trades: readonly BotTrade[]): TradePushEvent[] {
  const out: TradePushEvent[] = [];
  for (const t of trades) {
    const url = `/bots/${t.botId}`;
    const entries = t.orders
      .filter((o) => o.isEntry && o.filled > 0 && !o.isOpen)
      .sort((a, b) => (a.filledAt ?? a.placedAt ?? 0) - (b.filledAt ?? b.placedAt ?? 0));
    entries.forEach((o, index) => {
      const first = index === 0;
      const cost = o.cost ?? (o.price ?? 0) * o.filled;
      const fill = `${qty(o.filled)} ${t.base}${o.price !== null ? ` @ ${price(o.price)}` : ''} · ${money(cost)}`;
      const verb = first ? 'bought' : `added to (#${index + 1})`;
      out.push({
        key: `entry:${t.botId}:${o.orderId}`,
        botId: t.botId,
        kind: 'entry',
        at: o.filledAt ?? o.placedAt ?? t.openedAt,
        title: `${botName} ${verb} ${t.pair}`,
        body: `${fill}${t.enterTag ? ` · ${t.enterTag}` : ''}`,
        short: `${botName} ${first ? 'bought' : 'added to'} ${t.pair} · ${money(cost)}`,
        url,
      });
    });
    if (!t.isOpen && t.closedAt !== null) {
      const pnl = t.pnl.realizedUsd;
      const roi = t.pnl.roiOnStake;
      const pct = roi === null ? '' : ` (${roi > 0 ? '+' : ''}${(roi * 100).toFixed(2)}%)`;
      const details = [
        t.closeRate !== null ? `@ ${price(t.closeRate)}` : null,
        t.exitReason,
        `held ${formatHeld(t.closedAt - t.openedAt)}`,
      ].filter((x): x is string => x !== null && x !== '');
      out.push({
        key: `exit:${t.botId}:${t.tradeId}`,
        botId: t.botId,
        kind: 'exit',
        at: t.closedAt,
        title: `${botName} sold ${t.pair} · ${signedMoney(pnl)}${pct}`,
        body: `${details.join(' · ')} · fees included`,
        short: `${botName} sold ${t.pair} · ${signedMoney(pnl)}`,
        url,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** When announcements started (set on the first call). */
export function announcementsSince(now: Ms): Ms {
  const stored = getMetaNumber(SINCE_META);
  if (stored !== null) return stored;
  setMeta(SINCE_META, now);
  return now;
}

/** The candidates that are recent and not announced yet, claimed in the database so they are announced only once. */
export function claimNewTradeEvents(candidates: readonly TradePushEvent[], now: Ms): TradePushEvent[] {
  const since = announcementsSince(now);
  return candidates.filter(
    (e) => e.at >= since && e.at >= now - MAX_AGE_MS && claimPushTradeEvent(e.key, e.botId, e.at, now),
  );
}

export interface TradeAnnouncer {
  notifyTrades(events: readonly TradePushEvent[]): Promise<void>;
}

/** Called by the poller after it stored a bot's trades. Never throws. */
export async function announceTrades(
  announcer: TradeAnnouncer,
  botId: BotId,
  botName: string,
  trades: readonly BotTrade[],
  now: Ms,
): Promise<void> {
  try {
    const fresh = claimNewTradeEvents(tradeEventCandidates(botName, trades), now);
    if (fresh.length > 0) await announcer.notifyTrades(fresh);
  } catch (err) {
    log.warn('could not announce trades', { botId, err: describeError(err) });
  }
}
