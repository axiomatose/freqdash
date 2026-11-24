import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from './index';
import {
  getMeta,
  insertEquitySnapshot,
  insertEvents,
  listEquity,
  listEvents,
  listFindings,
  listNotifications,
  logNotification,
  prune,
  saveLifecycle,
  upsertKrakenOrders,
  vacuumIfDue,
  VACUUM_INTERVAL_MS,
  listKrakenOrders,
  type FindingDraft,
} from './index';
import { installTempDb, type TempDb } from './testing';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_568_000_000;

function finding(fingerprint: string, over: Partial<FindingDraft>): FindingDraft {
  return {
    id: null,
    rule: 'BOT_FATAL_LOG',
    fingerprint,
    severity: 'critical',
    maxSeverity: 'critical',
    status: 'resolved',
    title: 't',
    detail: 'd',
    subject: { botId: 'votemax' },
    evidence: {},
    evidenceKeys: [],
    firstSeenAt: NOW - 200 * DAY,
    episodeStartAt: NOW - 200 * DAY,
    activeSince: NOW - 200 * DAY,
    lastSeenAt: NOW - 200 * DAY,
    clearedAt: null,
    resolvedAt: NOW - 200 * DAY,
    occurrences: 1,
    flapCount: 0,
    silenced: null,
    notifiedAt: null,
    notifiedSeverity: null,
    notifiedEvidenceCount: null,
    ...over,
  };
}

describe('public surface', () => {
  it('exports every repo function the plan lists', () => {
    const expected = [
      'getDb',
      'getMeta',
      'setMeta',
      'saveSourceState',
      'loadSourceStates',
      'markOrdersSeen',
      'getKnownOrders',
      'insertEvents',
      'listEvents',
      'getCursor',
      'saveCursor',
      'upsertKrakenOrders',
      'listKrakenOrders',
      'getOrdersByTxids',
      'upsertFlows',
      'listFlows',
      'insertEquitySnapshot',
      'listEquity',
      'upsertSignals',
      'listSignals',
      'listFindings',
      'getFinding',
      'saveLifecycle',
      'silence',
      'unsilence',
      'listAcks',
      'createAcks',
      'revokeAck',
      'logNotification',
      'prune',
    ];
    for (const name of expected) expect(typeof (db as Record<string, unknown>)[name], name).toBe('function');
  });
});

describe('prune', () => {
  it('honors the retention table and reports what it deleted', () => {
    insertEvents([
      { botId: 'votemax', at: NOW - 100 * DAY, type: 'startup', source: 'logfile', fingerprint: 'old-startup' },
      { botId: 'votemax', at: NOW - 80 * DAY, type: 'startup', source: 'logfile', fingerprint: 'recent-startup' },
      { botId: 'votemax', at: NOW - 300 * DAY, type: 'order_created', source: 'logfile', fingerprint: 'order-300d' },
      { botId: 'votemax', at: NOW - 400 * DAY, type: 'order_canceled', source: 'logfile', fingerprint: 'order-400d' },
    ]);
    saveLifecycle([
      finding(':old-resolved', { resolvedAt: NOW - 91 * DAY }),
      finding(':recent-resolved', { resolvedAt: NOW - 89 * DAY }),
      finding(':open', { status: 'active', resolvedAt: null }),
    ]);
    for (const [i, age] of [31, 29].entries()) {
      logNotification({
        at: NOW - age * DAY,
        channel: 'discord',
        fingerprint: `n${i}`,
        kind: 'opened',
        severity: 'warning',
        ok: true,
      });
    }
    for (const age of [0, 30, 400, 900]) {
      insertEquitySnapshot({
        at: NOW - age * DAY,
        source: 'kraken',
        totalUsd: 1000,
        usdCash: 1,
        holdings: [],
      });
    }
    upsertKrakenOrders(
      [
        {
          txid: 'OANCIENT',
          pair: 'ETH/USD',
          krakenPair: 'XETHZUSD',
          side: 'buy',
          orderType: 'limit',
          status: 'closed',
          openedAt: NOW - 800 * DAY,
          closedAt: NOW - 800 * DAY,
          vol: 1,
          volExec: 1,
          costUsd: 1,
          feeUsd: 0,
          avgPrice: 1,
          limitPrice: 1,
          userref: null,
          clOrdId: null,
          reason: null,
        },
      ],
      NOW - 800 * DAY,
    );

    // old-startup (100 d > 90 d) and order-400d (> 365 d) go; order-300d and recent-startup stay.
    expect(prune(NOW)).toEqual({ botEvents: 2, findings: 1, notifications: 1, pushTradeEvents: 0, sessions: 0 });

    expect(
      listEvents()
        .map((e) => e.fingerprint)
        .sort(),
    ).toEqual(['order-300d', 'recent-startup']);
    expect(
      listFindings()
        .map((f) => f.fingerprint)
        .sort(),
    ).toEqual([':open', ':recent-resolved']);
    expect(listNotifications().map((n) => n.fingerprint)).toEqual(['n1']);
    expect(listEquity(0, 100)).toHaveLength(4);
    expect(listKrakenOrders().map((o) => o.txid)).toEqual(['OANCIENT']);
  });

  it('is idempotent', () => {
    insertEvents([{ botId: 'a', at: NOW - 100 * DAY, type: 'error', source: 'logfile', fingerprint: 'x' }]);
    expect(prune(NOW).botEvents).toBe(1);
    expect(prune(NOW)).toEqual({ botEvents: 0, findings: 0, notifications: 0, pushTradeEvents: 0, sessions: 0 });
  });

  it('rolls back all deletions when one of them fails', () => {
    insertEvents([{ botId: 'a', at: NOW - 100 * DAY, type: 'error', source: 'logfile', fingerprint: 'x' }]);
    temp.db.exec('DROP TABLE notifications_log');
    expect(() => prune(NOW)).toThrow(/notifications_log/);
    expect(listEvents()).toHaveLength(1);
  });
});

describe('vacuumIfDue', () => {
  it('runs when it never ran, then waits for the interval', () => {
    expect(vacuumIfDue(NOW)).toBe(true);
    expect(getMeta('last_vacuum_at')).toBe(String(NOW));
    expect(vacuumIfDue(NOW + VACUUM_INTERVAL_MS - 1)).toBe(false);
    expect(vacuumIfDue(NOW + VACUUM_INTERVAL_MS)).toBe(true);
    expect(getMeta('last_vacuum_at')).toBe(String(NOW + VACUUM_INTERVAL_MS));
  });

  it('honors a custom interval and keeps the database usable afterwards', () => {
    expect(vacuumIfDue(NOW, 1000)).toBe(true);
    expect(vacuumIfDue(NOW + 999, 1000)).toBe(false);
    expect(vacuumIfDue(NOW + 1000, 1000)).toBe(true);
    expect(temp.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(temp.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
