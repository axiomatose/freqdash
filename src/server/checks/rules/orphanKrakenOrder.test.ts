import { describe, expect, it } from 'vitest';
import type { BotCheckView, CheckInput } from '../types';
import {
  DAY,
  MIN,
  SEC,
  T0,
  ack,
  event,
  healthyBot,
  input,
  krakenOrder,
  krakenView,
} from '../../../../test/fixtures/incident/builders';
import { orphanKrakenOrder } from './orphanKrakenOrder';

const TXID = 'OWDY2Z-TVWRN-IJBALL';
const polled = (ago = 5 * SEC, over: Partial<BotCheckView> = {}) =>
  healthyBot('votemax', T0, { lastStatusOkAt: T0 - ago, lastTradesOkAt: T0 - ago, ...over });
const orphan = (over = {}) =>
  krakenOrder({ txid: TXID, openedAt: T0 - 90 * SEC, volExec: 0.01, status: 'closed', ...over });
const run = (over: Partial<CheckInput> = {}, order = orphan()) =>
  orphanKrakenOrder(input({ bots: [polled()], kraken: krakenView({ orders: [order] }), ...over }));

describe('ORPHAN_KRAKEN_ORDER', () => {
  it('flags a filled Kraken order that no bot knows: critical, per pair, with the order in the evidence', () => {
    const [f, ...rest] = run();
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'ORPHAN_KRAKEN_ORDER',
      fingerprint: 'ORPHAN_KRAKEN_ORDER:ETH/USD',
      severity: 'critical',
      subject: { pair: 'ETH/USD' },
      evidenceKeys: [TXID],
    });
    expect(f!.evidence).toMatchObject({
      count: 1,
      totalVol: 0.01,
      totalCostUsd: 26,
      orders: [{ txid: TXID, side: 'buy', createdByBot: null }],
    });
    expect(f!.detail).toContain('acknowledge');
  });

  it('is silent without Kraken data (freqtrade-only mode)', () => {
    expect(orphanKrakenOrder(input({ bots: [polled()], kraken: null }))).toEqual([]);
  });

  it('waits for 60 s of age (boundary)', () => {
    expect(run({}, orphan({ openedAt: T0 - 60 * SEC + 1 }))).toEqual([]);
    expect(run({}, orphan({ openedAt: T0 - 60 * SEC }))).toHaveLength(1);
  });

  it('ignores orders from before reconciliation started (boundary: the start itself counts)', () => {
    const reconStartAt = T0 - 90 * SEC;
    expect(run({ reconStartAt })).toHaveLength(1);
    expect(run({ reconStartAt: reconStartAt + 1 })).toEqual([]);
  });

  it('needs a fill or a live order: unfilled closed/canceled orders are not orphans, open and pending ones are', () => {
    expect(run({}, orphan({ status: 'canceled', volExec: 0 }))).toEqual([]);
    expect(run({}, orphan({ status: 'closed', volExec: 0 }))).toEqual([]);
    expect(run({}, orphan({ status: 'expired', volExec: 0 }))).toEqual([]);
    expect(run({}, orphan({ status: 'open', volExec: 0 }))[0]!.severity).toBe('critical');
    expect(run({}, orphan({ status: 'pending', volExec: 0 }))).toHaveLength(1);
  });

  it('is silent for orders a bot knows or that are acknowledged (active acks only)', () => {
    expect(run({ knownOrders: { [TXID]: { botId: 'dca', tradeId: 1 } } })).toEqual([]);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID })] })).toEqual([]);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID, revokedAt: 1 })] })).toHaveLength(1);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID, expiresAt: T0 })] })).toHaveLength(1);
  });

  describe('bot freshness gate', () => {
    it('waits until every reachable bot fetched /status and /trades more than 5 s after the order (boundary)', () => {
      const at = 90 * SEC;
      expect(run({ bots: [polled(at - 5 * SEC)] })).toEqual([]);
      expect(run({ bots: [polled(at - 5 * SEC - 1)] })).toHaveLength(1);
      expect(run({ bots: [polled(5 * SEC, { lastTradesOkAt: T0 - at + 5 * SEC })] })).toEqual([]);
      expect(run({ bots: [polled(5 * SEC, { lastStatusOkAt: null })] })).toEqual([]);
      expect(run({ bots: [polled(5 * SEC, { lastTradesOkAt: null })] })).toEqual([]);
    });

    it('is held back by any one stale bot', () => {
      const stale = healthyBot('dca', T0, { lastStatusOkAt: T0 - 5 * MIN, lastTradesOkAt: T0 - 5 * MIN });
      expect(run({ bots: [polled(), stale] })).toEqual([]);
    });

    it('ignores a bot that has been down for more than 5 minutes (boundary), but not a shorter outage', () => {
      const down = (ms: number) =>
        healthyBot('dca', T0, {
          firstFailureAt: T0 - ms,
          lastStatusOkAt: T0 - 20 * MIN,
          lastTradesOkAt: T0 - 20 * MIN,
        });
      expect(run({ bots: [polled(), down(5 * MIN + 1)] })).toHaveLength(1);
      expect(run({ bots: [polled(), down(5 * MIN)] })).toEqual([]);
    });

    it('with no bots there is nothing to wait for', () => {
      expect(run({ bots: [] })).toHaveLength(1);
    });
  });

  describe('severity', () => {
    const old = (over = {}) => orphan({ openedAt: T0 - 8 * DAY, ...over });
    it('is critical for a fill younger than 7 days and a warning from 7 days on (boundary)', () => {
      const reconStartAt = T0 - 30 * DAY;
      expect(run({ reconStartAt }, orphan({ openedAt: T0 - 7 * DAY + 1 }))[0]!.severity).toBe('critical');
      expect(run({ reconStartAt }, orphan({ openedAt: T0 - 7 * DAY }))[0]!.severity).toBe('warning');
      expect(run({ reconStartAt }, old())[0]!.severity).toBe('warning');
    });
    it('is critical for an old order that is still open', () => {
      expect(run({ reconStartAt: T0 - 30 * DAY }, old({ status: 'open', volExec: 0 }))[0]!.severity).toBe('critical');
    });
  });

  it('records which bot logged the order when a matching order_created event exists', () => {
    const events = [event({ type: 'order_created', botId: 'votemax', orderId: TXID, at: T0 - 91 * SEC })];
    const [f] = run({ events });
    expect(f!.evidence).toMatchObject({ orders: [{ createdByBot: 'votemax' }] });
    expect(f!.detail).toContain('votemax');
  });

  it('groups by pair, falls back to the Kraken pair name when the pair is unknown, and lists each order once', () => {
    const kraken = krakenView({
      openOrders: [orphan({ txid: 'OQCITX-BEFEM-LM4TJE', status: 'open', volExec: 0 })],
      orders: [
        orphan({ txid: 'OQCITX-BEFEM-LM4TJE', status: 'open', volExec: 0 }),
        orphan({ txid: 'OLUF74-GBHX6-NZAAWS', pair: 'BTC/USD', krakenPair: 'XBTUSD', openedAt: T0 - 100 * SEC }),
        orphan({ txid: 'OXGS7S-6P5GW-O67JNZ', pair: null, krakenPair: 'SHIBUSD' }),
      ],
    });
    const found = orphanKrakenOrder(input({ bots: [polled()], kraken }));
    expect(found.map((f) => f.fingerprint).sort()).toEqual([
      'ORPHAN_KRAKEN_ORDER:BTC/USD',
      'ORPHAN_KRAKEN_ORDER:ETH/USD',
      'ORPHAN_KRAKEN_ORDER:SHIBUSD',
    ]);
    expect(found.find((f) => f.subject.pair === 'ETH/USD')!.evidenceKeys).toEqual(['OQCITX-BEFEM-LM4TJE']);
  });

  it('a single finding lists every order of a pair, oldest first, with totals', () => {
    const kraken = krakenView({
      orders: [
        orphan({ txid: 'OIRD2R-6OG6L-GGSQMI', openedAt: T0 - 70 * SEC, volExec: 0.02, costUsd: 52 }),
        orphan({ txid: 'OS3SYM-GMO5O-5HDGV2', openedAt: T0 - 80 * SEC, volExec: 0.01, costUsd: 26 }),
      ],
    });
    const [f] = orphanKrakenOrder(input({ bots: [polled()], kraken }));
    expect(f!.evidenceKeys).toEqual(['OS3SYM-GMO5O-5HDGV2', 'OIRD2R-6OG6L-GGSQMI']);
    expect(f!.evidence).toMatchObject({ count: 2, totalVol: 0.03, totalCostUsd: 78 });
    expect(f!.title).toContain('2 Kraken orders');
  });
});
