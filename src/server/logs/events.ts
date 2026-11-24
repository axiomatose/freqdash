import 'server-only';
import { createHash } from 'node:crypto';
import type { BotEvent, BotEventType, BotId, Ms } from '@/shared/types/domain';
import { redactSecrets } from '../log';
import type { LogRecord } from './parser';

// Event extraction table: docs/PLAN.md section 6.2. DEBUG records are skipped first (they only count for lastLineAt),
// and every stored message is redacted. Log lines are not time ordered, so nothing here assumes monotonic `at`.

const RE_ORDER_CREATED = /^Order (O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}) was created for (\S+) and status is (\w+)/;
const RE_SIGNAL =
  /^Long signal found: about create a new trade for (\S+) with stake_amount: ([\d.]+) and price: ([\d.]+)/;
const RE_FAILED = /^Unable to create trade for (\S+?): (.*)$/;
const RE_TXID = /O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}/;
const RE_CANCEL = /cancel|timeout/i;
const RE_PROCESS_DIED = /Sending rpc message: .*'process died'/;
const RE_HEARTBEAT = /^Bot heartbeat\. PID=\d+, version='([^']+)', state='(\w+)'/;

/** An order line is enriched with the price/stake of a signal for the same pair logged at most this long before it. */
const SIGNAL_WINDOW_MS = 5_000;
const MESSAGE_MAX = 500;

export interface SignalSeen {
  at: Ms;
  price: number;
  stakeUsd: number;
}

/** State carried between extractEvents() calls (one per bot). Treated as immutable: each call returns a new one. */
export interface ParserState {
  /** Last `Long signal found` per pair, used to enrich the following `order_created`. */
  lastSignals: Record<string, SignalSeen>;
  lastWalletSyncAt: Ms | null;
  lastHeartbeatAt: Ms | null;
  heartbeat: { version: string; state: string } | null;
  /** Newest record time seen, DEBUG included (max, because lines are not time ordered). */
  lastLineAt: Ms | null;
}

export function createParserState(): ParserState {
  return { lastSignals: {}, lastWalletSyncAt: null, lastHeartbeatAt: null, heartbeat: null, lastLineAt: null };
}

export interface ExtractResult {
  /** Sorted by `at` (stable for equal times). */
  events: BotEvent[];
  lastWalletSyncAt: Ms | null;
  lastHeartbeatAt: Ms | null;
  lastLineAt: Ms | null;
  state: ParserState;
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 10);
}

function clip(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
}

/**
 * Deterministic and idempotent: the same log line always yields the same fingerprint, whichever source or poll it
 * arrives through (the source is deliberately not part of it), so the store can dedupe with a UNIQUE constraint.
 */
export function eventFingerprint(botId: BotId, type: BotEventType, at: Ms, discriminator: string | undefined): string {
  return discriminator ? `${botId}:${type}:${at}:${discriminator}` : `${botId}:${type}:${at}`;
}

function lastNonBlank(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (line !== '') return line;
  }
  return null;
}

export function extractEvents(
  botId: BotId,
  records: readonly LogRecord[],
  source: BotEvent['source'],
  parserState: ParserState = createParserState(),
): ExtractResult {
  const state: ParserState = { ...parserState, lastSignals: { ...parserState.lastSignals } };
  const found: BotEvent[] = [];

  const push = (
    type: BotEventType,
    at: Ms,
    discriminator: string | undefined,
    extra: Partial<Pick<BotEvent, 'orderId' | 'pair' | 'price' | 'stakeUsd' | 'message'>> = {},
  ): void => {
    const event: BotEvent = { botId, at, type, source, fingerprint: eventFingerprint(botId, type, at, discriminator) };
    if (extra.orderId !== undefined) event.orderId = extra.orderId;
    if (extra.pair !== undefined) event.pair = extra.pair;
    if (extra.price !== undefined) event.price = extra.price;
    if (extra.stakeUsd !== undefined) event.stakeUsd = extra.stakeUsd;
    if (extra.message !== undefined) event.message = clip(redactSecrets(extra.message));
    found.push(event);
  };

  for (const r of records) {
    if (state.lastLineAt === null || r.at > state.lastLineAt) state.lastLineAt = r.at;
    if (r.level === 'DEBUG') continue;

    const msg = r.message;
    let m: RegExpExecArray | null;

    if (r.logger === 'freqtrade.wallets' && msg.startsWith('Wallets synced')) {
      if (state.lastWalletSyncAt === null || r.at > state.lastWalletSyncAt) state.lastWalletSyncAt = r.at;
    } else if ((m = RE_HEARTBEAT.exec(msg))) {
      if (state.lastHeartbeatAt === null || r.at > state.lastHeartbeatAt) {
        state.lastHeartbeatAt = r.at;
        state.heartbeat = { version: m[1] as string, state: m[2] as string };
      }
    } else if (r.logger === 'freqtrade.loggers' && msg.startsWith('Logfile configured')) {
      push('startup', r.at, undefined);
    } else if (r.logger === 'freqtrade' && r.level === 'ERROR' && msg.startsWith('Fatal exception')) {
      // The interesting line is the exception at the end of the traceback.
      push('fatal', r.at, undefined, { message: lastNonBlank(r.continuation) ?? msg });
    } else if (RE_PROCESS_DIED.test(msg)) {
      push('process_died', r.at, undefined);
    } else if ((m = RE_SIGNAL.exec(msg))) {
      state.lastSignals[m[1] as string] = { at: r.at, price: Number(m[3]), stakeUsd: Number(m[2]) };
    } else if ((m = RE_ORDER_CREATED.exec(msg))) {
      const orderId = m[1] as string;
      const pair = m[2] as string;
      const signal = state.lastSignals[pair];
      const extra: Parameters<typeof push>[3] = { orderId, pair };
      if (signal && r.at - signal.at >= 0 && r.at - signal.at <= SIGNAL_WINDOW_MS) {
        extra.price = signal.price;
        extra.stakeUsd = signal.stakeUsd;
      }
      push('order_created', r.at, orderId, extra);
    } else if ((r.level === 'WARNING' || r.level === 'ERROR') && (m = RE_FAILED.exec(msg))) {
      const pair = m[1] as string;
      const reason = m[2] as string;
      push('order_failed', r.at, `${pair}:${shortHash(reason)}`, { pair, message: reason });
    } else if ((r.level === 'INFO' || r.level === 'WARNING') && RE_CANCEL.test(msg) && (m = RE_TXID.exec(msg))) {
      push('order_canceled', r.at, m[0], { orderId: m[0], message: msg });
    } else if (r.level === 'ERROR' || r.level === 'CRITICAL') {
      const tail = lastNonBlank(r.continuation);
      push('error', r.at, shortHash(`${r.logger}|${msg}`), { message: tail === null ? msg : `${msg} | ${tail}` });
    }
  }

  const events = found
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].at - b[0].at || a[1] - b[1])
    .map(([e]) => e);
  return {
    events,
    lastWalletSyncAt: state.lastWalletSyncAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastLineAt: state.lastLineAt,
    state,
  };
}
