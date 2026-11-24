import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTempDb, type TempDb } from '../testing';
import { getKnownOrders, markOrdersSeen, type SeenOrderInput } from './botOrders';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const order = (over: Partial<SeenOrderInput> = {}): SeenOrderInput => ({
  botId: 'votemax',
  orderId: 'OJPZKJ-OPTQY-YWQU6O',
  tradeId: 1,
  pair: 'BTC/USD',
  side: 'buy',
  ...over,
});

interface SeenRow {
  bot_id: string;
  order_id: string;
  trade_id: number;
  first_seen_at: number;
  last_seen_at: number;
}
const rows = (t: TempDb): SeenRow[] =>
  t.db.prepare('SELECT * FROM bot_orders_seen ORDER BY order_id').all() as SeenRow[];

describe('bot orders seen', () => {
  it('is empty at first and ignores an empty batch', () => {
    markOrdersSeen([], 1);
    expect(getKnownOrders()).toEqual({});
  });

  it('records orders and exposes them in CheckInput.knownOrders shape', () => {
    markOrdersSeen([order(), order({ botId: 'dca', orderId: 'OT2EE5-X67HW-VBHF2W', tradeId: 7 })], 100);
    expect(getKnownOrders()).toEqual({
      'OJPZKJ-OPTQY-YWQU6O': { botId: 'votemax', tradeId: 1 },
      'OT2EE5-X67HW-VBHF2W': { botId: 'dca', tradeId: 7 },
    });
  });

  it('keeps first_seen_at and advances last_seen_at when an order is seen again', () => {
    markOrdersSeen([order()], 100);
    markOrdersSeen([order({ tradeId: 9 })], 500);
    markOrdersSeen([order()], 300); // out-of-order observation must not move last_seen_at backwards

    expect(rows(temp)).toEqual([expect.objectContaining({ first_seen_at: 100, last_seen_at: 500, trade_id: 9 })]);
  });

  it('an order id seen by two bots resolves to the bot that saw it first', () => {
    markOrdersSeen([order({ botId: 'dca' })], 200);
    markOrdersSeen([order({ botId: 'votemax' })], 100);
    expect(getKnownOrders()['OJPZKJ-OPTQY-YWQU6O']).toEqual({ botId: 'votemax', tradeId: 1 });
  });

  it('writes a batch atomically', () => {
    const bad = { ...order({ orderId: 'OCCCCC' }), tradeId: undefined } as unknown as SeenOrderInput;
    expect(() => markOrdersSeen([order(), bad], 1)).toThrow();
    expect(rows(temp)).toEqual([]);
  });
});
