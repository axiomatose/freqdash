import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KrakenOrder } from '@/shared/types/domain';
import { installTempDb, type TempDb } from '../testing';
import { getOrdersByTxids, listKrakenOrders, upsertKrakenOrders, type KrakenOrderInput } from './krakenOrders';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

function order(txid: string, over: Partial<KrakenOrderInput> = {}): KrakenOrderInput {
  return {
    txid,
    pair: 'ETH/USD',
    krakenPair: 'XETHZUSD',
    side: 'buy',
    orderType: 'limit',
    status: 'closed',
    openedAt: 1_790_568_007_000,
    closedAt: 1_790_568_037_000,
    vol: 0.004,
    volExec: 0.004,
    costUsd: 11.5,
    feeUsd: 0.046,
    avgPrice: 2875,
    limitPrice: 2876,
    userref: null,
    clOrdId: null,
    reason: null,
    ...over,
  };
}

const txids = (orders: KrakenOrder[]): string[] => orders.map((o) => o.txid);

describe('upsertKrakenOrders', () => {
  it('round-trips a normalized order without its raw field', () => {
    const input = order('OJPZKJ-OPTQY-YWQU6O', { userref: 42, clOrdId: 'cl-1', reason: 'User requested' });
    upsertKrakenOrders([{ ...input, raw: { descr: { pair: 'ETHUSD' } } }], 10);

    expect(getOrdersByTxids(['OJPZKJ-OPTQY-YWQU6O'])).toEqual([input]);
    const raw = temp.db.prepare('SELECT raw_json FROM kraken_orders').get() as { raw_json: string };
    expect(JSON.parse(raw.raw_json)).toEqual({ descr: { pair: 'ETHUSD' } });
  });

  it('stores the normalized order as raw_json when no raw record is supplied', () => {
    upsertKrakenOrders([order('OBBBBB')], 10);
    const raw = temp.db.prepare('SELECT raw_json FROM kraken_orders').get() as { raw_json: string };
    expect(JSON.parse(raw.raw_json)).toMatchObject({ txid: 'OBBBBB', vol: 0.004 });
  });

  it('keeps first_seen_at and advances updated_at on every upsert', () => {
    upsertKrakenOrders([order('OCCCCC', { status: 'open', closedAt: null })], 100);
    upsertKrakenOrders([order('OCCCCC')], 200);

    const row = temp.db.prepare('SELECT first_seen_at, updated_at, status FROM kraken_orders').get();
    expect(row).toEqual({ first_seen_at: 100, updated_at: 200, status: 'closed' });
  });

  it('keeps known values when a later observation lacks them', () => {
    upsertKrakenOrders([order('ODDDDD', { userref: 7, reason: 'r', avgPrice: 2875 })], 1);
    upsertKrakenOrders(
      [order('ODDDDD', { pair: null, closedAt: null, avgPrice: null, limitPrice: null, userref: null, reason: null })],
      2,
    );
    expect(getOrdersByTxids(['ODDDDD'])[0]).toMatchObject({
      pair: 'ETH/USD',
      closedAt: 1_790_568_037_000,
      avgPrice: 2875,
      limitPrice: 2876,
      userref: 7,
      reason: 'r',
    });
  });

  it('updates mutable fields, e.g. an open order that fills', () => {
    upsertKrakenOrders([order('OEEEEE', { status: 'open', closedAt: null, volExec: 0, costUsd: 0, feeUsd: 0 })], 1);
    upsertKrakenOrders([order('OEEEEE', { volExec: 0.004, costUsd: 11.5 })], 2);
    expect(getOrdersByTxids(['OEEEEE'])[0]).toMatchObject({ status: 'closed', volExec: 0.004, costUsd: 11.5 });
  });

  it('never regresses a terminal order to open/pending with a stale observation', () => {
    upsertKrakenOrders([order('OFFFFF', { status: 'canceled', volExec: 0 })], 1);
    upsertKrakenOrders([order('OFFFFF', { status: 'open', closedAt: null, volExec: 0.001 })], 2);
    upsertKrakenOrders([order('OFFFFF', { status: 'pending', closedAt: null })], 3);

    expect(getOrdersByTxids(['OFFFFF'])[0]).toMatchObject({ status: 'canceled', volExec: 0 });
    const row = temp.db.prepare('SELECT updated_at FROM kraken_orders').get();
    expect(row).toEqual({ updated_at: 1 });
  });

  it('still lets a terminal status replace another terminal status', () => {
    upsertKrakenOrders([order('OGGGGG', { status: 'canceled' })], 1);
    upsertKrakenOrders([order('OGGGGG', { status: 'closed' })], 2);
    expect(getOrdersByTxids(['OGGGGG'])[0]?.status).toBe('closed');
  });

  it('is a no-op for an empty batch and atomic for a bad one', () => {
    upsertKrakenOrders([], 1);
    const bad = { ...order('OBAD'), vol: undefined } as unknown as KrakenOrderInput;
    expect(() => upsertKrakenOrders([order('OGOOD'), bad], 1)).toThrow();
    expect(listKrakenOrders()).toEqual([]);
  });
});

describe('listKrakenOrders', () => {
  beforeEach(() => {
    upsertKrakenOrders(
      [
        order('O1', { openedAt: 1000, pair: 'ETH/USD', status: 'closed' }),
        order('O2', { openedAt: 2000, pair: 'BTC/USD', status: 'open', closedAt: null }),
        order('O3', { openedAt: 3000, pair: 'ETH/USD', status: 'canceled', volExec: 0 }),
        order('O4', { openedAt: 4000, pair: null, status: 'closed' }),
      ],
      1,
    );
  });

  it('returns newest first by default and oldest first on request', () => {
    expect(txids(listKrakenOrders())).toEqual(['O4', 'O3', 'O2', 'O1']);
    expect(txids(listKrakenOrders({ order: 'asc' }))).toEqual(['O1', 'O2', 'O3', 'O4']);
  });

  it('filters by since (inclusive), pair and statuses', () => {
    expect(txids(listKrakenOrders({ since: 3000 }))).toEqual(['O4', 'O3']);
    expect(txids(listKrakenOrders({ pair: 'ETH/USD' }))).toEqual(['O3', 'O1']);
    expect(txids(listKrakenOrders({ statuses: ['open', 'pending'] }))).toEqual(['O2']);
    expect(txids(listKrakenOrders({ pair: 'ETH/USD', since: 2000, statuses: ['canceled', 'closed'] }))).toEqual(['O3']);
    expect(listKrakenOrders({ statuses: [] })).toEqual([]);
  });

  it('applies limit after ordering', () => {
    expect(txids(listKrakenOrders({ limit: 2 }))).toEqual(['O4', 'O3']);
  });
});

describe('getOrdersByTxids', () => {
  it('returns matches in the requested order, skipping unknown ids and duplicates', () => {
    upsertKrakenOrders([order('O1'), order('O2'), order('O3')], 1);
    expect(txids(getOrdersByTxids(['O3', 'NOPE', 'O1', 'O3']))).toEqual(['O3', 'O1']);
    expect(getOrdersByTxids([])).toEqual([]);
  });

  it('handles more ids than one statement chunk', () => {
    const many = Array.from({ length: 1200 }, (_, i) => `OTX-${String(i).padStart(4, '0')}`);
    upsertKrakenOrders(
      many.map((txid) => order(txid)),
      1,
    );
    const found = getOrdersByTxids([...many].reverse());
    expect(found).toHaveLength(1200);
    expect(found[0]?.txid).toBe('OTX-1199');
  });
});
