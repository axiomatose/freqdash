import { describe, expect, it } from 'vitest';
import type { BotEvent } from '@/shared/types/domain';
import {
  DAY,
  HOUR,
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
import type { CheckInput } from '../types';
import { unpersistedOrder } from './unpersistedOrder';

const TXID = 'OX2D7A-ROVIF-A3YVZW';
const created = (agoMs: number, txid = TXID, over: Partial<BotEvent> = {}) =>
  event({
    type: 'order_created',
    at: T0 - agoMs,
    orderId: txid,
    pair: 'ETH/USD',
    price: 2650,
    stakeUsd: 36.5,
    ...over,
  });

/** A bot whose /status and /trades were both fetched successfully `ago` before now. */
const polled = (ago = 5 * SEC, over = {}) =>
  healthyBot('votemax', T0, { lastStatusOkAt: T0 - ago, lastTradesOkAt: T0 - ago, ...over });
const run = (over: Partial<CheckInput> = {}) =>
  unpersistedOrder(input({ bots: [polled()], events: [created(90 * SEC)], ...over }));

describe('UNPERSISTED_ORDER', () => {
  it('flags a logged order the bot never recorded: critical, one finding per bot and pair, with evidence and keys', () => {
    const [f, ...rest] = run();
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'UNPERSISTED_ORDER',
      fingerprint: 'UNPERSISTED_ORDER:votemax:ETH/USD',
      severity: 'critical',
      subject: { botId: 'votemax', pair: 'ETH/USD' },
      evidenceKeys: [TXID],
    });
    expect(f!.evidence).toMatchObject({
      count: 1,
      totalStakeUsd: 36.5,
      orders: [{ orderId: TXID, at: T0 - 90 * SEC, price: 2650, stakeUsd: 36.5, zeroFillCanceled: false }],
    });
    expect(f!.detail).toContain('Kraken order history');
    expect(f!.detail).toContain('acknowledge');
  });

  it('waits for 60 s of age (boundary)', () => {
    expect(run({ events: [created(60 * SEC - 1)] })).toEqual([]);
    expect(run({ events: [created(60 * SEC)] })).toHaveLength(1);
  });

  it('needs both /status and /trades fetched more than 5 s after the order (boundary)', () => {
    const at = 90 * SEC;
    expect(run({ bots: [polled(at - 5 * SEC)] })).toEqual([]);
    expect(run({ bots: [polled(at - 5 * SEC - 1)] })).toHaveLength(1);
    expect(run({ bots: [polled(5 * SEC, { lastTradesOkAt: T0 - at + 5 * SEC })] })).toEqual([]);
    expect(run({ bots: [polled(5 * SEC, { lastStatusOkAt: T0 - at + 5 * SEC })] })).toEqual([]);
    expect(run({ bots: [polled(5 * SEC, { lastTradesOkAt: null })] })).toEqual([]);
    expect(run({ bots: [polled(5 * SEC, { lastStatusOkAt: null })] })).toEqual([]);
  });

  it('is silent when the bot knows the order or an active acknowledgement covers it', () => {
    expect(run({ knownOrders: { [TXID]: { botId: 'votemax', tradeId: 3 } } })).toEqual([]);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID })] })).toEqual([]);
  });

  it('still flags the order when the acknowledgement is revoked, expired, or for another txid/kind', () => {
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID, revokedAt: T0 - 1 })] })).toHaveLength(1);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: TXID, expiresAt: T0 })] })).toHaveLength(1);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: 'O7UOUF-3QLFL-7E7GYF' })] })).toHaveLength(1);
    expect(run({ acks: [ack({ kind: 'asset', subject: TXID })] })).toHaveLength(1);
  });

  it('is critical below 24 h of age and a warning from 24 h on (boundary)', () => {
    expect(run({ events: [created(DAY - 1)] })[0]!.severity).toBe('critical');
    expect(run({ events: [created(DAY)] })[0]!.severity).toBe('warning');
    expect(run({ events: [created(3 * DAY)] })[0]!.severity).toBe('warning');
  });

  it('stays critical while any live order is young, even next to an old one', () => {
    const events = [created(3 * DAY), created(2 * MIN, 'OGXJ7Q-R5ZV2-2CBQW2')];
    expect(run({ events })[0]!.severity).toBe('critical');
  });

  describe('zero-fill canceled orders', () => {
    const cancelledOnKraken = (over = {}) =>
      krakenView(
        {
          orders: [
            krakenOrder({ txid: TXID, status: 'canceled', vol: 0.01, volExec: 0, costUsd: 0, feeUsd: 0, ...over }),
          ],
        },
        T0,
      );

    it('are downgraded to info when Kraken says canceled with nothing filled', () => {
      const [f] = run({ kraken: cancelledOnKraken() });
      expect(f!.severity).toBe('info');
      expect(f!.evidence).toMatchObject({ orders: [{ krakenStatus: 'canceled', volExec: 0, zeroFillCanceled: true }] });
    });

    it('are downgraded to info when the bot log says canceled and Kraken is not consulted', () => {
      const events = [created(90 * SEC), event({ type: 'order_canceled', at: T0 - 30 * SEC, orderId: TXID })];
      expect(run({ events })[0]!.severity).toBe('info');
    });

    it('stay critical when Kraken shows a fill, even if the log says canceled', () => {
      const events = [created(90 * SEC), event({ type: 'order_canceled', at: T0 - 30 * SEC, orderId: TXID })];
      const filled = cancelledOnKraken({ volExec: 0.004, status: 'canceled' });
      expect(run({ events, kraken: filled })[0]!.severity).toBe('critical');
    });

    it('stay critical while the order is still open on Kraken', () => {
      expect(run({ kraken: cancelledOnKraken({ status: 'open' }) })[0]!.severity).toBe('critical');
    });

    it('count as zero-fill when Kraken closed the order without any fill', () => {
      expect(run({ kraken: cancelledOnKraken({ status: 'closed' }) })[0]!.severity).toBe('info');
    });

    it('are counted in the evidence, but severity comes from the orders that did fill', () => {
      const other = 'O7FE34-SXR6D-X2BUR3';
      const kraken = krakenView({
        orders: [
          krakenOrder({ txid: TXID, status: 'canceled', volExec: 0, costUsd: 0 }),
          krakenOrder({ txid: other, status: 'closed', volExec: 0.01 }),
        ],
      });
      const [f] = run({ events: [created(90 * SEC), created(80 * SEC, other)], kraken });
      expect(f!.severity).toBe('critical');
      expect(f!.evidenceKeys).toEqual([TXID, other]);
    });

    it('an old live order next to zero-fill ones is only a warning', () => {
      const other = 'OR532E-CO2VN-2PJOMO';
      const kraken = krakenView({ orders: [krakenOrder({ txid: TXID, status: 'canceled', volExec: 0 })] });
      const [f] = run({ events: [created(90 * SEC), created(2 * DAY, other)], kraken });
      expect(f!.severity).toBe('warning');
    });

    it('a cancel log line for a different bot does not downgrade the order', () => {
      const events = [
        created(90 * SEC),
        event({ type: 'order_canceled', at: T0 - 30 * SEC, orderId: TXID, botId: 'dca' }),
      ];
      expect(run({ events })[0]!.severity).toBe('critical');
    });
  });

  it('groups by pair and reports each pair separately; a missing pair is grouped as unknown', () => {
    const events = [
      created(90 * SEC, 'OJPZKJ-OPTQY-YWQU6O'),
      created(80 * SEC, 'OT2EE5-X67HW-VBHF2W'),
      created(70 * SEC, 'O5Q3U2-R6SWA-P4SYTU', { pair: 'BTC/USD' }),
      created(70 * SEC, 'O2ZNL6-VBIKL-CZWDT7', { pair: undefined }),
    ];
    const found = run({ events });
    expect(found.map((f) => f.fingerprint).sort()).toEqual([
      'UNPERSISTED_ORDER:votemax:BTC/USD',
      'UNPERSISTED_ORDER:votemax:ETH/USD',
      'UNPERSISTED_ORDER:votemax:unknown',
    ]);
    const eth = found.find((f) => f.subject.pair === 'ETH/USD')!;
    expect(eth.evidenceKeys).toEqual(['OJPZKJ-OPTQY-YWQU6O', 'OT2EE5-X67HW-VBHF2W']);
    expect(eth.evidence).toMatchObject({ count: 2, totalStakeUsd: 73 });
  });

  it('counts a txid once even when two log sources reported it', () => {
    const events = [created(90 * SEC), created(89 * SEC, TXID, { source: 'api-logs' })];
    expect(run({ events })[0]!.evidenceKeys).toEqual([TXID]);
  });

  it('ignores other event types, events without txid, future events and events of unknown bots', () => {
    expect(run({ events: [event({ type: 'startup', at: T0 - 90 * SEC })] })).toEqual([]);
    expect(run({ events: [created(90 * SEC, undefined, { orderId: undefined })] })).toEqual([]);
    expect(run({ events: [created(-90 * SEC)] })).toEqual([]);
    expect(run({ events: [created(90 * SEC, TXID, { botId: 'ghost' })] })).toEqual([]);
  });

  it('checks each bot against its own events and polls', () => {
    const dca = healthyBot('dca', T0, { lastStatusOkAt: T0 - HOUR, lastTradesOkAt: T0 - HOUR });
    const found = run({
      bots: [polled(), dca],
      events: [created(90 * SEC), created(90 * SEC, 'OYTHUE-JG2EO-MNLK5H', { botId: 'dca' })],
    });
    expect(found.map((f) => f.subject.botId)).toEqual(['votemax']);
  });
});
