import { describe, expect, it } from 'vitest';
import type { BotEvent } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import {
  MIN,
  SEC,
  T0,
  ack,
  baseTrade,
  botOrder,
  event,
  healthyBot,
  input,
  krakenOrder,
  krakenView,
} from '../../../../test/fixtures/incident/builders';
import { withPnl } from '@/server/accounting';
import { orderStorm } from './orderStorm';

const id = (n: number) => `OSTORM-AAAAA-${String(n).padStart(6, '0')}`;
const created = (n: number, agoMs: number, over: Partial<BotEvent> = {}) =>
  event({ type: 'order_created', at: T0 - agoMs, orderId: id(n), pair: 'ETH/USD', ...over });
const attempts = (count: number) => Array.from({ length: count }, (_, i) => created(i, (i + 1) * 30 * SEC));
const run = (over: Partial<CheckInput> = {}) => orderStorm(input(over));

describe('ORDER_STORM', () => {
  it('needs 4 attempts on a pair in 10 minutes for a warning', () => {
    expect(run({ events: attempts(3) })).toEqual([]);
    const [f] = run({ events: attempts(4) });
    expect(f).toMatchObject({
      rule: 'ORDER_STORM',
      fingerprint: 'ORDER_STORM:ETH/USD',
      severity: 'warning',
      subject: { pair: 'ETH/USD' },
    });
    expect(f!.evidence).toMatchObject({ count: 4, windowMs: 10 * MIN });
    expect(run({ events: attempts(5) })[0]!.severity).toBe('warning');
  });

  it('is critical from 6 attempts (boundary)', () => {
    expect(run({ events: attempts(6) })[0]!.severity).toBe('critical');
  });

  it('counts a txid once across Kraken, the log and the bot records', () => {
    const kraken = krakenView({
      orders: [0, 1, 2, 3].map((n) => krakenOrder({ txid: id(n), openedAt: T0 - (n + 1) * 30 * SEC })),
    });
    const trade = withPnl(
      baseTrade({ orders: [0, 1, 2, 3].map((n) => botOrder({ orderId: id(n), placedAt: T0 - (n + 1) * 30 * SEC })) }),
      null,
    );
    const found = run({ events: attempts(4), kraken, bots: [healthyBot('votemax', T0, { closedTrades: [trade] })] });
    expect(found[0]!.evidence).toMatchObject({ count: 4 });
    expect(found[0]!.severity).toBe('warning');
  });

  it('counts each source on its own: Kraken alone, bot records alone, logs alone', () => {
    const kraken = krakenView({
      orders: [0, 1, 2, 3].map((n) => krakenOrder({ txid: id(n), openedAt: T0 - (n + 1) * 30 * SEC })),
    });
    expect(run({ kraken })).toHaveLength(1);
    const openKraken = krakenView({
      openOrders: [0, 1, 2, 3].map((n) =>
        krakenOrder({ txid: id(n), status: 'open', openedAt: T0 - (n + 1) * 30 * SEC }),
      ),
    });
    expect(run({ kraken: openKraken })).toHaveLength(1);
    const trade = withPnl(
      baseTrade({ orders: [0, 1, 2, 3].map((n) => botOrder({ orderId: id(n), placedAt: T0 - (n + 1) * 30 * SEC })) }),
      null,
    );
    expect(run({ bots: [healthyBot('votemax', T0, { openTrades: [trade] })] })).toHaveLength(1);
  });

  it('counts failed attempts, each on its own', () => {
    const failed = [0, 1, 2, 3].map((n) =>
      event({ type: 'order_failed', at: T0 - (n + 1) * 20 * SEC, pair: 'ETH/USD' }),
    );
    expect(run({ events: failed })).toHaveLength(1);
    const same = [0, 1, 2, 3].map(() => event({ type: 'order_failed', at: T0 - 20 * SEC, pair: 'ETH/USD' }));
    expect(run({ events: same })).toEqual([]);
  });

  it('looks back exactly 10 minutes (boundary)', () => {
    const edge = [created(0, 10 * MIN), created(1, 9 * MIN), created(2, 8 * MIN), created(3, 7 * MIN)];
    expect(run({ events: edge })).toHaveLength(1);
    const old = [created(0, 10 * MIN + 1), ...edge.slice(1)];
    expect(run({ events: old })).toEqual([]);
  });

  it('keeps pairs apart and ignores attempts without a pair, in the future, or that are acknowledged', () => {
    const mixed = [
      created(0, 10 * SEC),
      created(1, 20 * SEC),
      created(2, 30 * SEC, { pair: 'BTC/USD' }),
      created(3, 40 * SEC, { pair: 'BTC/USD' }),
    ];
    expect(run({ events: mixed })).toEqual([]);
    expect(run({ events: [...attempts(3), created(9, 5 * SEC, { pair: undefined })] })).toEqual([]);
    expect(run({ events: [...attempts(3), created(9, -5 * SEC)] })).toEqual([]);
    const acks = [ack({ kind: 'kraken_order', subject: id(0) })];
    expect(run({ events: attempts(4), acks })).toEqual([]);
    const kraken = krakenView({ orders: [krakenOrder({ txid: id(9), openedAt: T0 - 5 * SEC })] });
    expect(run({ events: attempts(3), kraken, acks: [ack({ kind: 'kraken_order', subject: id(9) })] })).toEqual([]);
    const trade = withPnl(baseTrade({ orders: [botOrder({ orderId: id(9), placedAt: T0 - 5 * SEC })] }), null);
    expect(
      run({
        events: attempts(3),
        bots: [healthyBot('votemax', T0, { closedTrades: [trade] })],
        acks: [ack({ kind: 'kraken_order', subject: id(9) })],
      }),
    ).toEqual([]);
  });

  it('uses the Kraken pair name when the pair is unknown, and works without Kraken data', () => {
    const kraken = krakenView({
      orders: [0, 1, 2, 3].map((n) =>
        krakenOrder({ txid: id(n), pair: null, krakenPair: 'SHIBUSD', openedAt: T0 - (n + 1) * SEC }),
      ),
    });
    expect(run({ kraken })[0]!.fingerprint).toBe('ORDER_STORM:SHIBUSD');
    expect(run({ kraken: null, events: attempts(4) })).toHaveLength(1);
  });
});
