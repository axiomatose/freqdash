import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BotEvent } from '@/shared/types/domain';
import { createParserState, eventFingerprint, extractEvents } from './events';
import { LOG_LINE_RE, parseApiLogs, parseLogChunk, type LogRecord } from './parser';

function rawFixture(rel: string): string {
  const url = new URL(`../../../test/fixtures/raw/${rel}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

interface TimelineEvent {
  type: string;
  at: number;
  pair?: string;
  orderId?: string;
  price?: number;
  stakeUsd?: number;
  message?: string;
}
interface Timeline {
  counts: Record<string, number>;
  events: TimelineEvent[];
  outsideWindowEvents: TimelineEvent[];
}

const timeline = JSON.parse(rawFixture('incident/timeline.json')) as Timeline;
const incidentLog = rawFixture('logs/votemax-incident-2026-09-28.log');

/** The comparable part of an event (types, times, txids and the enrichment the timeline records). */
function shape(e: BotEvent | TimelineEvent): TimelineEvent {
  const out: TimelineEvent = { type: e.type, at: e.at };
  if (e.pair !== undefined) out.pair = e.pair;
  if ('orderId' in e && e.orderId !== undefined) out.orderId = e.orderId;
  if (e.price !== undefined) out.price = e.price;
  if (e.stakeUsd !== undefined) out.stakeUsd = e.stakeUsd;
  if (e.message !== undefined) out.message = e.message;
  return out;
}

function rec(partial: Partial<LogRecord> & Pick<LogRecord, 'at' | 'logger' | 'level' | 'message'>): LogRecord {
  return { continuation: [], ...partial };
}

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0, 0);

describe('extractEvents on the incident excerpt', () => {
  const { records } = parseLogChunk(incidentLog);
  const result = extractEvents('votemax', records, 'logfile');

  it('equals timeline.json events (types, times, txids, enrichment), entry signals aside', () => {
    const expected = timeline.events.filter((e) => e.type !== 'entry_signal');
    expect(result.events.map(shape)).toEqual(expected);
  });

  it('reproduces the incident counts: 25 orders, 25 crashes and restarts, one failed attempt', () => {
    const counts: Record<string, number> = {};
    for (const e of result.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    expect(counts).toEqual({
      order_created: timeline.counts.order_created,
      order_failed: timeline.counts.order_failed,
      process_died: timeline.counts.process_died,
      fatal: timeline.counts.fatal,
      startup: timeline.counts.startup,
    });
    expect(counts).toEqual({ order_created: 25, order_failed: 1, process_died: 25, fatal: 25, startup: 25 });
  });

  it('turns the traceback into the exception line and never counts noise warnings as events', () => {
    const fatals = result.events.filter((e) => e.type === 'fatal');
    expect(fatals.every((e) => e.message === "ValueError: invalid literal for int() with base 10: ''")).toBe(true);
    expect(result.events.some((e) => e.type === 'error')).toBe(false);
    const failed = result.events.filter((e) => e.type === 'order_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ at: 1790568240099, pair: 'ETH/USD' });
    expect(failed[0]!.message).toContain('InvalidNonce');
    // the second failure (04:57:40.717) lies outside the excerpt windows
    expect(timeline.outsideWindowEvents).toHaveLength(1);
    expect(result.events.some((e) => e.at === timeline.outsideWindowEvents[0]!.at)).toBe(false);
  });

  it('tracks wallet sync, heartbeat and last line as maxima, since lines are not time ordered', () => {
    const maxAt = (pred: (r: LogRecord) => boolean) => Math.max(...records.filter(pred).map((r) => r.at));
    expect(result.lastLineAt).toBe(maxAt(() => true));
    expect(result.lastWalletSyncAt).toBe(maxAt((r) => r.message.startsWith('Wallets synced')));
    expect(result.lastHeartbeatAt).toBe(maxAt((r) => r.message.startsWith('Bot heartbeat.')));
    expect(result.state.heartbeat).toEqual({ version: '2026.4', state: 'RUNNING' });
  });

  it('emits events sorted by time', () => {
    const times = result.events.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('gives every event a unique, deterministic fingerprint that repeated parsing reproduces', () => {
    const again = extractEvents('votemax', parseLogChunk(incidentLog).records, 'logfile');
    expect(again.events.map((e) => e.fingerprint)).toEqual(result.events.map((e) => e.fingerprint));
    expect(new Set(result.events.map((e) => e.fingerprint)).size).toBe(result.events.length);
  });

  it('gives the same result when the log is fed in chunks with parser state carried over', () => {
    const lines = incidentLog.split('\n');
    const chunks: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      // cut only in front of a header line so a traceback is never split (the tailer holds such records back)
      if (LOG_LINE_RE.test(line) && current.length >= 300) {
        chunks.push(current.join('\n') + '\n');
        current = [];
      }
      current.push(line);
    }
    chunks.push(current.join('\n'));
    expect(chunks.length).toBeGreaterThan(3);

    let state = createParserState();
    const events: BotEvent[] = [];
    for (const chunk of chunks) {
      const r = extractEvents('votemax', parseLogChunk(chunk).records, 'logfile', state);
      state = r.state;
      events.push(...r.events);
    }
    expect(events.map((e) => e.fingerprint)).toEqual(result.events.map((e) => e.fingerprint));
    expect(events.map(shape)).toEqual(result.events.map(shape));
  });
});

describe('extractEvents on the -vv excerpt', () => {
  const { records } = parseLogChunk(rawFixture('logs/votemax-normal-vv.log'));

  it('skips every DEBUG record but still tracks the heartbeat and the last line', () => {
    const r = extractEvents('votemax', records, 'logfile');
    expect(r.events).toEqual([]);
    expect(r.lastHeartbeatAt).toBe(Date.UTC(2026, 8, 28, 22, 21, 26, 350));
    expect(r.lastWalletSyncAt).toBeNull();
    expect(r.lastLineAt).toBe(Math.max(...records.map((x) => x.at)));
    expect(r.state.heartbeat).toEqual({ version: '2026.8', state: 'RUNNING' });
  });

  it('never lets a DEBUG record produce an event even if it looks like one', () => {
    const debugLooksLikeEvent = rec({
      at: T0,
      logger: 'freqtrade.freqtradebot',
      level: 'DEBUG',
      message: 'Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.',
    });
    const debugFatal = rec({ at: T0, logger: 'freqtrade', level: 'DEBUG', message: 'Fatal exception!' });
    expect(extractEvents('b', [debugLooksLikeEvent, debugFatal], 'logfile').events).toEqual([]);
  });
});

describe('extractEvents redaction', () => {
  const webhook = 'https://discord.com/api/webhooks/123456789012345678/FAKE_tok-en_abc123';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

  it('redacts webhook URLs, JWTs and token= values from event messages', () => {
    const text = [
      `2026-09-28 22:20:30,000 - urllib3.connectionpool - DEBUG - https://discord.com:443 "POST ${new URL(webhook).pathname} HTTP/1.1" 204 0`,
      `2026-09-28 22:20:32,000 - freqtrade.rpc.webhook - ERROR - Could not post to ${webhook}: token=${jwt} failed`,
      `2026-09-28 22:20:33,000 - freqtrade.freqtradebot - WARNING - Unable to create trade for ETH/USD: denied for ${jwt}`,
      '',
    ].join('\n');
    const { events } = extractEvents('votemax', parseLogChunk(text).records, 'logfile');
    expect(events.map((e) => e.type)).toEqual(['error', 'order_failed']);
    const flat = JSON.stringify(events);
    expect(flat).not.toContain('FAKE_tok-en_abc123');
    expect(flat).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(events[0]!.message).toContain('/api/webhooks/[REDACTED]');
    expect(events[0]!.message).toContain('token=[REDACTED]');
  });

  it('also redacts messages of hand-built records (defence in depth)', () => {
    const { events } = extractEvents(
      'votemax',
      [rec({ at: T0, logger: 'x', level: 'ERROR', message: `boom ${webhook}` })],
      'logfile',
    );
    expect(events[0]!.message).not.toContain('FAKE_tok-en_abc123');
  });
});

describe('extractEvents rules', () => {
  it('startup, process_died and fatal carry no pair/order and use the documented matches', () => {
    const { events } = extractEvents(
      'dca',
      [
        rec({ at: T0 + 1, logger: 'freqtrade.loggers', level: 'INFO', message: 'Logfile configured' }),
        rec({ at: T0 + 2, logger: 'freqtrade.loggers', level: 'INFO', message: 'Verbosity set to 2' }),
        rec({
          at: T0 + 3,
          logger: 'freqtrade.rpc.rpc_manager',
          level: 'INFO',
          message: "Sending rpc message: {'type': status, 'status': 'process died'}",
        }),
        rec({
          at: T0 + 4,
          logger: 'freqtrade',
          level: 'ERROR',
          message: 'Fatal exception!',
          continuation: ['Traceback (most recent call last):', '  File "x", line 1', 'KeyError: 42', ''],
        }),
        rec({ at: T0 + 5, logger: 'freqtrade', level: 'ERROR', message: 'Fatal exception!' }),
        rec({ at: T0 + 6, logger: 'other', level: 'ERROR', message: 'Fatal exception!' }),
      ],
      'logfile',
    );
    expect(events.map((e) => [e.type, e.message])).toEqual([
      ['startup', undefined],
      ['process_died', undefined],
      ['fatal', 'KeyError: 42'],
      ['fatal', 'Fatal exception!'],
      ['error', 'Fatal exception!'],
    ]);
    expect(events.every((e) => e.botId === 'dca' && e.source === 'logfile')).toBe(true);
    expect(events[0]).not.toHaveProperty('pair');
  });

  it('enriches order_created from the last signal of the same pair within 5 s only', () => {
    const signal = (at: number, pair: string, stake: string, price: string) =>
      rec({
        at,
        logger: 'freqtrade.freqtradebot',
        level: 'INFO',
        message: `Long signal found: about create a new trade for ${pair} with stake_amount: ${stake} and price: ${price} ...`,
      });
    const order = (at: number, id: string, pair: string) =>
      rec({
        at,
        logger: 'freqtrade.freqtradebot',
        level: 'INFO',
        message: `Order ${id} was created for ${pair} and status is open.`,
      });

    const { events } = extractEvents(
      'votemax',
      [
        signal(T0, 'ETH/USD', '36.95835', '2651.84'),
        order(T0 + 143, 'OX2D7A-ROVIF-A3YVZW', 'ETH/USD'),
        order(T0 + 5_143, 'OORUYZ-2BWGK-SAYX6T', 'ETH/USD'), // 5.143 s after the signal: too late
        order(T0 + 100, 'O3OVJH-YNYDT-L5RGHT', 'BTC/USD'), // other pair
        order(T0 - 1, 'OIGQLC-43TRW-7GOJFP', 'ETH/USD'), // before the signal (out of order line)
      ],
      'logfile',
    );
    const byId = Object.fromEntries(events.map((e) => [e.orderId, e]));
    expect(byId['OX2D7A-ROVIF-A3YVZW']).toMatchObject({ pair: 'ETH/USD', price: 2651.84, stakeUsd: 36.95835 });
    expect(byId['OORUYZ-2BWGK-SAYX6T']).not.toHaveProperty('price');
    expect(byId['O3OVJH-YNYDT-L5RGHT']).not.toHaveProperty('stakeUsd');
    expect(byId['OIGQLC-43TRW-7GOJFP']).not.toHaveProperty('price');
  });

  it('carries the signal across calls through the parser state and does not mutate the input state', () => {
    const state0 = createParserState();
    const a = extractEvents(
      'votemax',
      [
        rec({
          at: T0,
          logger: 'freqtrade.freqtradebot',
          level: 'INFO',
          message:
            'Long signal found: about create a new trade for BTC/USD with stake_amount: 10.5 and price: 83000.1 ...',
        }),
      ],
      'logfile',
      state0,
    );
    expect(state0).toEqual(createParserState());
    const b = extractEvents(
      'votemax',
      [
        rec({
          at: T0 + 200,
          logger: 'freqtrade.freqtradebot',
          level: 'INFO',
          message: 'Order OFIOKH-SRO73-LZZ66Q was created for BTC/USD and status is closed.',
        }),
      ],
      'logfile',
      a.state,
    );
    expect(b.events[0]).toMatchObject({ price: 83000.1, stakeUsd: 10.5 });
  });

  it('order_failed needs WARNING/ERROR and the exact prefix; harmless warnings stay silent', () => {
    const at = T0;
    const { events } = extractEvents(
      'votemax',
      [
        rec({
          at,
          logger: 'freqtrade.freqtradebot',
          level: 'WARNING',
          message: 'Unable to create trade for ETH/USD: Could not get balance due to ExchangeNotAvailable.',
        }),
        rec({
          at: at + 1,
          logger: 'freqtrade.freqtradebot',
          level: 'ERROR',
          message: 'Unable to create trade for BTC/USD: nope',
        }),
        rec({
          at: at + 2,
          logger: 'freqtrade.freqtradebot',
          level: 'INFO',
          message: 'Unable to create trade for BTC/USD: info only',
        }),
        rec({
          at: at + 3,
          logger: 'freqtrade.data.dataprovider',
          level: 'WARNING',
          message: 'No data found for (ETH/USD, 1w, ).',
        }),
        rec({
          at: at + 4,
          logger: 'freqtrade.wallets',
          level: 'WARNING',
          message: 'Minimum stake amount > available balance. 2.78 > 2.27',
        }),
      ],
      'logfile',
    );
    expect(events.map((e) => [e.type, e.pair, e.message])).toEqual([
      ['order_failed', 'ETH/USD', 'Could not get balance due to ExchangeNotAvailable.'],
      ['order_failed', 'BTC/USD', 'nope'],
    ]);
  });

  it('order_canceled needs a txid plus cancel/timeout on an INFO/WARNING line', () => {
    const { events } = extractEvents(
      'votemax',
      [
        rec({
          at: T0,
          logger: 'freqtrade.freqtradebot',
          level: 'INFO',
          message: 'Cancelling order OX2D7A-ROVIF-A3YVZW due to timeout.',
        }),
        rec({
          at: T0 + 1,
          logger: 'freqtrade.freqtradebot',
          level: 'WARNING',
          message: 'Order OORUYZ-2BWGK-SAYX6T timeout reached',
        }),
        rec({
          at: T0 + 2,
          logger: 'freqtrade.strategy',
          level: 'INFO',
          message: "Strategy using unfilledtimeout: {'entry': 10}",
        }),
        rec({
          at: T0 + 3,
          logger: 'freqtrade.freqtradebot',
          level: 'INFO',
          message: 'Buy order timeout for Trade(id=3)',
        }),
        rec({
          at: T0 + 4,
          logger: 'freqtrade.freqtradebot',
          level: 'ERROR',
          message: 'Cancelling order OX2D7A-ROVIF-A3YVZW failed',
        }),
      ],
      'logfile',
    );
    expect(events.map((e) => [e.type, e.orderId])).toEqual([
      ['order_canceled', 'OX2D7A-ROVIF-A3YVZW'],
      ['order_canceled', 'OORUYZ-2BWGK-SAYX6T'],
      ['error', undefined],
    ]);
  });

  it('turns other ERROR/CRITICAL records into error events, adding the last traceback line', () => {
    const { events } = extractEvents(
      'votemax',
      [
        rec({
          at: T0,
          logger: 'freqtrade.exchange.exchange',
          level: 'ERROR',
          message: 'Could not fetch ticker',
          continuation: ['Traceback', 'ccxt.errors.NetworkError: down'],
        }),
        rec({ at: T0 + 1, logger: 'freqtrade.worker', level: 'CRITICAL', message: 'Out of memory' }),
        rec({ at: T0 + 2, logger: 'freqtrade.worker', level: 'WARNING', message: 'Something odd' }),
      ],
      'logfile',
    );
    expect(events.map((e) => [e.type, e.message])).toEqual([
      ['error', 'Could not fetch ticker | ccxt.errors.NetworkError: down'],
      ['error', 'Out of memory'],
    ]);
  });

  it('clips very long messages', () => {
    const { events } = extractEvents(
      'b',
      [rec({ at: T0, logger: 'x', level: 'ERROR', message: 'e'.repeat(2_000) })],
      'logfile',
    );
    expect(events[0]!.message!.length).toBe(500);
  });

  it('returns the state fields even without records', () => {
    expect(extractEvents('b', [], 'logfile')).toMatchObject({
      events: [],
      lastWalletSyncAt: null,
      lastHeartbeatAt: null,
      lastLineAt: null,
    });
  });
});

describe('fingerprints', () => {
  const line = rec({
    at: T0,
    logger: 'freqtrade.freqtradebot',
    level: 'INFO',
    message: 'Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.',
  });

  it('are idempotent per line and independent of the source, but differ per bot, type and time', () => {
    const file = extractEvents('votemax', [line], 'logfile').events[0]!;
    const api = extractEvents('votemax', [line], 'api-logs').events[0]!;
    expect(file.fingerprint).toBe(api.fingerprint);
    expect(file.fingerprint).toBe(`votemax:order_created:${T0}:OX2D7A-ROVIF-A3YVZW`);
    expect(extractEvents('dca', [line], 'logfile').events[0]!.fingerprint).not.toBe(file.fingerprint);
    expect(extractEvents('votemax', [{ ...line, at: T0 + 1 }], 'logfile').events[0]!.fingerprint).not.toBe(
      file.fingerprint,
    );
  });

  it('distinguish different failures logged in the same millisecond', () => {
    const mk = (msg: string) =>
      rec({
        at: T0,
        logger: 'freqtrade.freqtradebot',
        level: 'WARNING',
        message: `Unable to create trade for ETH/USD: ${msg}`,
      });
    const { events } = extractEvents('b', [mk('one'), mk('two'), mk('one')], 'logfile');
    expect(events[0]!.fingerprint).not.toBe(events[1]!.fingerprint);
    expect(events[0]!.fingerprint).toBe(events[2]!.fingerprint);
  });

  it('eventFingerprint omits an empty discriminator', () => {
    expect(eventFingerprint('dca', 'startup', 5, undefined)).toBe('dca:startup:5');
  });
});

describe('api-logs source', () => {
  it('extracts the same events from /logs rows and marks them api-logs', () => {
    const records = parseApiLogs({
      logs: [
        [
          '2026-09-28 21:29:48',
          1790630988187.5,
          'freqtrade.freqtradebot',
          'INFO',
          'Long signal found: about create a new trade for ETH/USD with stake_amount: 12 and price: 2600.5 ...',
        ],
        [
          '2026-09-28 21:29:48',
          1790630988300.2,
          'freqtrade.freqtradebot',
          'INFO',
          'Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.',
        ],
      ],
    });
    const { events } = extractEvents('votemax', records, 'api-logs');
    expect(events).toEqual([
      {
        botId: 'votemax',
        at: 1790630988300,
        type: 'order_created',
        source: 'api-logs',
        orderId: 'OX2D7A-ROVIF-A3YVZW',
        pair: 'ETH/USD',
        price: 2600.5,
        stakeUsd: 12,
        fingerprint: 'votemax:order_created:1790630988300:OX2D7A-ROVIF-A3YVZW',
      },
    ]);
  });
});
