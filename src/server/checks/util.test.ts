import { describe, expect, it } from 'vitest';
import {
  T0,
  ack,
  balance,
  baseTrade,
  botOrder,
  event,
  healthyBot,
  krakenOrder,
  krakenView,
  openTrade,
} from '../../../test/fixtures/incident/builders';
import type { Acknowledgement } from '@/shared/types/domain';
import type { Finding } from '@/shared/types/findings';
import {
  coveredByAcks,
  allBotOrders,
  baseOf,
  clusterStarts,
  duration,
  errorSignature,
  eventsOf,
  fingerprint,
  groupBy,
  hashString,
  isKnownOrder,
  isPositive,
  isoTime,
  krakenOrderMap,
  maxSeverity,
  orderAcked,
  qty,
  severityRank,
  tradedAssets,
  usd,
} from './util';
import { withPnl } from '@/server/accounting';

describe('severity helpers', () => {
  it('ranks info < warning < critical and picks the higher', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('warning'));
    expect(severityRank('warning')).toBeLessThan(severityRank('critical'));
    expect(maxSeverity('info', 'warning')).toBe('warning');
    expect(maxSeverity('critical', 'warning')).toBe('critical');
    expect(maxSeverity('warning', 'warning')).toBe('warning');
  });
});

describe('fingerprint', () => {
  it('joins the rule and parts with colons and is the rule alone without parts', () => {
    expect(fingerprint('BOT_FATAL_LOG', 'votemax')).toBe('BOT_FATAL_LOG:votemax');
    expect(fingerprint('FEE_ANOMALY', 'votemax', 3, 'sell')).toBe('FEE_ANOMALY:votemax:3:sell');
    expect(fingerprint('CLOCK_SKEW')).toBe('CLOCK_SKEW');
  });
});

describe('hashString / errorSignature', () => {
  it('hashes deterministically to 8 hex digits and separates different inputs', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashString('')).toBe('811c9dc5');
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('strips txids, hex, numbers and repeated whitespace, and truncates', () => {
    expect(errorSignature('Order OX2D7A-ROVIF-A3YVZW  failed 3 times at 0xDEADBEEF12 (1.25 s)', 200)).toBe(
      'Order <txid> failed # times at <hex> (# s)',
    );
    expect(errorSignature('x'.repeat(300), 120)).toHaveLength(120);
    expect(errorSignature('  padded  ', 50)).toBe('padded');
  });
});

describe('clusterStarts', () => {
  it('starts a new cluster only when an event is more than the gap after the first of the current one', () => {
    expect(clusterStarts([], 10_000)).toEqual([]);
    expect(clusterStarts([1000, 5000, 11_000], 10_000)).toEqual([1000]);
    expect(clusterStarts([1000, 11_001], 10_000)).toEqual([1000, 11_001]);
    expect(clusterStarts([30_000, 1000, 2000], 10_000)).toEqual([1000, 30_000]);
  });
});

describe('eventsOf', () => {
  it('filters by bot, type and a [now - window, now] range, both ends inclusive', () => {
    const events = [
      event({ at: T0 - 10, type: 'fatal' }),
      event({ at: T0 - 11, type: 'fatal' }),
      event({ at: T0, type: 'fatal' }),
      event({ at: T0 + 1, type: 'fatal' }),
      event({ at: T0 - 5, type: 'startup' }),
      event({ at: T0 - 5, type: 'fatal', botId: 'dca' }),
    ];
    expect(eventsOf(events, 'votemax', ['fatal'], T0, 10).map((e) => e.at)).toEqual([T0 - 10, T0]);
  });
});

describe('order helpers', () => {
  it('orderAcked matches active kraken_order acks by txid only', () => {
    const acks = [
      ack({ kind: 'kraken_order', subject: 'OJPZKJ-OPTQY-YWQU6O' }),
      ack({ id: 2, kind: 'kraken_order', subject: 'OT2EE5-X67HW-VBHF2W', revokedAt: 1 }),
      ack({ id: 3, kind: 'asset', subject: 'O5Q3U2-R6SWA-P4SYTU' }),
    ];
    expect(orderAcked(acks, 'OJPZKJ-OPTQY-YWQU6O', T0)).toBe(true);
    expect(orderAcked(acks, 'OT2EE5-X67HW-VBHF2W', T0)).toBe(false);
    expect(orderAcked(acks, 'O5Q3U2-R6SWA-P4SYTU', T0)).toBe(false);
  });

  it('isKnownOrder only sees own keys', () => {
    expect(isKnownOrder({ OAAAAA: { botId: 'a', tradeId: 1 } }, 'OAAAAA')).toBe(true);
    expect(isKnownOrder({}, 'toString')).toBe(false);
  });

  it('krakenOrderMap lets open orders override persisted ones', () => {
    const kraken = krakenView({
      orders: [krakenOrder({ txid: 'OJPZKJ-OPTQY-YWQU6O', volExec: 0 })],
      openOrders: [krakenOrder({ txid: 'OJPZKJ-OPTQY-YWQU6O', volExec: 1 })],
    });
    expect(krakenOrderMap(kraken).get('OJPZKJ-OPTQY-YWQU6O')?.volExec).toBe(1);
    expect(krakenOrderMap(kraken).size).toBe(1);
  });

  it('allBotOrders lists the orders of open and closed trades of every bot', () => {
    const closed = withPnl(baseTrade({ tradeId: 1, orders: [botOrder({ orderId: 'O6OHYH-GTGCF-WB57UJ' })] }), null);
    const bots = [
      healthyBot('votemax', T0, {
        openTrades: [openTrade('votemax', 'ETH', 1, 1, { tradeId: 2 })],
        closedTrades: [closed],
      }),
      healthyBot('dca', T0),
    ];
    const refs = allBotOrders(bots);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.bot.botId)).toEqual(['votemax', 'votemax']);
  });

  it('groupBy keeps first-seen key order', () => {
    const m = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? 'even' : 'odd'));
    expect([...m.keys()]).toEqual(['odd', 'even']);
    expect(m.get('odd')).toEqual([1, 3, 5]);
  });
});

describe('assets', () => {
  it('baseOf takes the part before the slash', () => {
    expect(baseOf('ETH/USD')).toBe('ETH');
    expect(baseOf('ETHUSD')).toBe('ETHUSD');
  });

  it('tradedAssets is the bases of all whitelists and open trades', () => {
    const bots = [
      healthyBot('a', T0, { whitelist: ['BTC/USD', 'ETH/USD'] }),
      healthyBot('b', T0, { whitelist: ['DOGE/USD'], openTrades: [openTrade('b', 'SOL', 1, 1)] }),
    ];
    expect([...tradedAssets(bots)].sort()).toEqual(['BTC', 'DOGE', 'ETH', 'SOL']);
    expect(tradedAssets([]).size).toBe(0);
  });
});

describe('formatting', () => {
  it('formats money, quantities, times and durations', () => {
    expect(usd(1234.5)).toBe('$1234.50');
    expect(qty(0.1130240889)).toBe('0.11302409');
    expect(qty(2)).toBe('2');
    expect(qty(0.000000001)).toBe('0');
    expect(isoTime(Date.UTC(2026, 8, 28, 4, 1, 2))).toBe('04:01:02 UTC');
    expect(duration(0)).toBe('0s');
    expect(duration(45_000)).toBe('45s');
    expect(duration(185_000)).toBe('3m 05s');
    expect(duration(2 * 3_600_000 + 10 * 60_000)).toBe('2h 10m');
    expect(duration(50 * 3_600_000)).toBe('2d 02h');
    expect(duration(-5)).toBe('0s');
  });

  it('isPositive accepts only finite positive numbers', () => {
    expect(isPositive(1)).toBe(true);
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) expect(isPositive(v)).toBe(false);
  });
});

describe('fixtures sanity', () => {
  it('the balance builder computes the value from the price', () => {
    expect(balance('ETH', 2, 100).valueUsd).toBe(200);
    expect(balance('ETH', 2, null).valueUsd).toBeNull();
  });
});

describe('coveredByAcks', () => {
  const NOW = 1_000_000;
  const mkAck = (
    kind: 'kraken_order' | 'asset',
    subject: string,
    over: Partial<Acknowledgement> = {},
  ): Acknowledgement => ({
    id: 1,
    kind,
    subject,
    label: 'manual',
    note: null,
    qtyBaseline: null,
    createdAt: 0,
    createdBy: null,
    expiresAt: null,
    revokedAt: null,
    ...over,
  });
  const finding = (rule: string, extra: Partial<Finding> = {}): Finding =>
    ({ rule, subject: {}, evidenceKeys: [], ...extra }) as unknown as Finding;

  it('covers an order finding only when every order id is acked', () => {
    const f = finding('ORPHAN_KRAKEN_ORDER', { evidenceKeys: ['A', 'B'] });
    expect(coveredByAcks(f, [mkAck('kraken_order', 'A'), mkAck('kraken_order', 'B')], NOW)).toBe(true);
    expect(coveredByAcks(f, [mkAck('kraken_order', 'A')], NOW)).toBe(false);
  });
  it('ignores revoked and expired acks, and an order ack for a different kind of subject', () => {
    const f = finding('UNPERSISTED_ORDER', { evidenceKeys: ['A'] });
    expect(coveredByAcks(f, [mkAck('kraken_order', 'A', { revokedAt: 5 })], NOW)).toBe(false);
    expect(coveredByAcks(f, [mkAck('kraken_order', 'A', { expiresAt: NOW - 1 })], NOW)).toBe(false);
    expect(coveredByAcks(f, [mkAck('asset', 'A')], NOW)).toBe(false);
  });
  it('covers a holding finding by its asset ack and nothing else', () => {
    const f = finding('UNTRACKED_HOLDING', { subject: { asset: 'ETH' } });
    expect(coveredByAcks(f, [mkAck('asset', 'ETH')], NOW)).toBe(true);
    expect(coveredByAcks(f, [mkAck('asset', 'BTC')], NOW)).toBe(false);
  });
  it('never fast-clears other rules or order findings with no ids', () => {
    expect(coveredByAcks(finding('BOT_FATAL_LOG'), [mkAck('asset', 'ETH')], NOW)).toBe(false);
    expect(coveredByAcks(finding('ORPHAN_KRAKEN_ORDER'), [mkAck('kraken_order', 'A')], NOW)).toBe(false);
  });
});
