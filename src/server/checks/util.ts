// Helpers shared by the rules and the lifecycle. Pure.
import { isAckActive } from '@/server/accounting';
import type {
  Acknowledgement,
  Asset,
  BotEvent,
  BotEventType,
  BotId,
  BotOrder,
  BotTrade,
  KrakenOrder,
  Ms,
  Pair,
  Severity,
} from '@/shared/types/domain';
import type { Finding, RawFinding, RuleId } from '@/shared/types/findings';
import type { BotCheckView, CheckInput, KrakenCheckView } from './types';

export type Rule = (input: CheckInput) => RawFinding[];

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export const severityRank = (s: Severity): number => RANK[s];

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** `RULE:part:part`; a rule without parts is its own fingerprint (CLOCK_SKEW, NOTIFIER_FAILING). */
export function fingerprint(rule: RuleId, ...parts: (string | number)[]): string {
  return parts.length === 0 ? rule : `${rule}:${parts.join(':')}`;
}

/** FNV-1a, 32 bit, as 8 hex digits. Stable across runs; used to shorten error signatures for fingerprints. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const TXID = /\bO[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}\b/g;
const HEX = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const DIGITS = /\d+(?:\.\d+)?/g;

/** Message with txids, long hex strings and numbers replaced, so repeats of one error share a signature. */
export function errorSignature(message: string, maxLen: number): string {
  return message
    .replace(TXID, '<txid>')
    .replace(HEX, '<hex>')
    .replace(DIGITS, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Start times of the clusters in `times`: an event within `gapMs` of the first event of a cluster belongs to it.
 * (A restart shows up as a log line and as a health diff a second apart; that is one restart.)
 */
export function clusterStarts(times: readonly Ms[], gapMs: Ms): Ms[] {
  const sorted = [...times].sort((a, b) => a - b);
  const starts: Ms[] = [];
  for (const t of sorted) {
    const last = starts[starts.length - 1];
    if (last === undefined || t - last > gapMs) starts.push(t);
  }
  return starts;
}

/** Events of one bot and type(s) with `now - windowMs <= at <= now`. */
export function eventsOf(
  events: readonly BotEvent[],
  botId: BotId,
  types: readonly BotEventType[],
  now: Ms,
  windowMs: Ms,
): BotEvent[] {
  return events.filter((e) => e.botId === botId && types.includes(e.type) && e.at <= now && now - e.at <= windowMs);
}

export function orderAcked(acks: readonly Acknowledgement[], txid: string, now: Ms): boolean {
  return acks.some((a) => a.kind === 'kraken_order' && a.subject === txid && isAckActive(a, now));
}

const ORDER_ACK_RULES = new Set<string>(['ORPHAN_KRAKEN_ORDER', 'UNPERSISTED_ORDER', 'BOT_ORDER_MISSING_ON_KRAKEN']);
const ASSET_ACK_RULES = new Set<string>(['UNTRACKED_HOLDING', 'BOT_OVERCLAIMS_HOLDING']);

/**
 * True when the acknowledgements on file fully cover what a finding is about: every order id in an order finding, or the
 * asset of a holding finding. Used to resolve such a finding at once when it stops being raised.
 */
export function coveredByAcks(finding: Finding, acks: readonly Acknowledgement[], now: Ms): boolean {
  if (ORDER_ACK_RULES.has(finding.rule)) {
    const keys = finding.evidenceKeys ?? [];
    const ids = keys.length > 0 ? keys : finding.subject.orderId === undefined ? [] : [finding.subject.orderId];
    return ids.length > 0 && ids.every((id) => orderAcked(acks, id, now));
  }
  if (ASSET_ACK_RULES.has(finding.rule) && finding.subject.asset !== undefined) {
    const asset = finding.subject.asset;
    return acks.some((a) => a.kind === 'asset' && a.subject === asset && isAckActive(a, now));
  }
  return false;
}

/** Base asset of a `BASE/QUOTE` pair. */
export const baseOf = (pair: Pair): Asset => pair.split('/')[0] ?? pair;

/** Assets any bot is configured to trade (bases of the whitelists and of open trades). */
export function tradedAssets(bots: readonly BotCheckView[]): Set<Asset> {
  const out = new Set<Asset>();
  for (const b of bots) {
    for (const p of b.whitelist) out.add(baseOf(p));
    for (const t of b.openTrades) out.add(t.base);
  }
  return out;
}

export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Quantities with up to 8 decimals, trailing zeros trimmed. */
export function qty(n: number): string {
  return Number(n.toFixed(8)).toString();
}

export const isoTime = (ms: Ms): string => new Date(ms).toISOString().slice(11, 19) + ' UTC';

export function isPositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** `45s`, `3m 05s`, `2h 10m`: for titles and details. */
export function duration(ms: Ms): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}

/** Kraken orders by txid: the persisted list, with the live open orders taking precedence. */
export function krakenOrderMap(kraken: KrakenCheckView): Map<string, KrakenOrder> {
  const m = new Map<string, KrakenOrder>();
  for (const o of kraken.orders) m.set(o.txid, o);
  for (const o of kraken.openOrders) m.set(o.txid, o);
  return m;
}

export interface BotOrderRef {
  bot: BotCheckView;
  trade: BotTrade;
  order: BotOrder;
}

/** Every order of every trade (open and closed) of every bot. */
export function allBotOrders(bots: readonly BotCheckView[]): BotOrderRef[] {
  const out: BotOrderRef[] = [];
  for (const bot of bots) {
    for (const trade of [...bot.openTrades, ...bot.closedTrades]) {
      for (const order of trade.orders) out.push({ bot, trade, order });
    }
  }
  return out;
}

/** Groups `items` by `key`, keeping the insertion order of the first appearance of each key. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  }
  return m;
}

export const isKnownOrder = (known: CheckInput['knownOrders'], txid: string): boolean =>
  Object.prototype.hasOwnProperty.call(known, txid);
