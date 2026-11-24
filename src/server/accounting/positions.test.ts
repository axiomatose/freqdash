import { describe, expect, it } from 'vitest';
import type { Allocation, HoldingAttribution, LedgerEntry } from '@/shared/types/domain';
import { ack, krakenOrder } from '../../../test/fixtures/incident/builders';
import { buildManualPositions, replayAsset } from './positions';

const NONE: ReadonlySet<string> = new Set();

function allocationOf(...holdings: Partial<HoldingAttribution>[]): Allocation {
  return {
    totalUsd: 0,
    usdCash: 0,
    botPositions: [],
    acknowledgedUsd: 0,
    untrackedUsd: 0,
    dustUsd: 0,
    holdings: holdings.map((h) => ({
      asset: 'ETH',
      total: 1,
      valueUsd: 3000,
      byBot: [],
      acknowledgedQty: 1,
      ackId: 1,
      untrackedQty: 0,
      untrackedUsd: 0,
      status: 'manual' as const,
      ...h,
    })),
  };
}

const buy = (txid: string, at: number, vol: number, cost: number, fee: number) =>
  krakenOrder({ txid, side: 'buy', volExec: vol, costUsd: cost, feeUsd: fee, closedAt: at, openedAt: at });
const sell = (txid: string, at: number, vol: number, cost: number, fee: number) =>
  krakenOrder({ txid, side: 'sell', volExec: vol, costUsd: cost, feeUsd: fee, closedAt: at, openedAt: at });

describe('replayAsset', () => {
  it('averages buys with their fees into the cost', () => {
    const r = replayAsset('ETH', [buy('a', 1, 1, 2000, 8), buy('b', 2, 1, 3000, 12)], NONE);
    expect(r.qty).toBe(2);
    expect(r.cost).toBe(5020);
    expect(r.feesUsd).toBe(20);
    expect([r.firstBuyAt, r.lastBuyAt]).toEqual([1, 2]);
  });

  it('realizes a sell against the average cost and keeps the average for the rest', () => {
    const r = replayAsset('ETH', [buy('a', 1, 2, 4000, 0), sell('s', 2, 1, 3000, 12)], NONE);
    expect(r.realizedUsd).toBeCloseTo(3000 - 12 - 2000, 9);
    expect(r.qty).toBe(1);
    expect(r.cost).toBe(2000);
  });

  it('prices only the known part of a sell larger than the replay holds', () => {
    const r = replayAsset('ETH', [buy('a', 1, 1, 2000, 0), sell('s', 2, 2, 6000, 0)], NONE);
    expect(r.qty).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.realizedUsd).toBeCloseTo(3000 - 2000, 9);
  });

  it('skips excluded orders, other assets, other quotes, unfilled and pair-less orders', () => {
    const r = replayAsset(
      'ETH',
      [
        buy('bot', 1, 1, 2000, 0),
        krakenOrder({ txid: 'btc', pair: 'BTC/USD' }),
        krakenOrder({ txid: 'eur', pair: 'ETH/EUR' }),
        krakenOrder({ txid: 'none', pair: null }),
        krakenOrder({ txid: 'cancelled', volExec: 0 }),
        buy('mine', 3, 0.5, 1000, 4),
      ],
      new Set(['bot']),
    );
    expect(r.orders).toBe(1);
    expect(r.qty).toBe(0.5);
  });

  it('replays in time order regardless of input order', () => {
    const r = replayAsset('ETH', [sell('s', 2, 1, 3000, 0), buy('a', 1, 1, 2000, 0)], NONE);
    expect(r.realizedUsd).toBe(1000);
    expect(r.qty).toBe(0);
  });
});

describe('buildManualPositions', () => {
  it('shows the fill price as the entry and the fee-inclusive cost as break-even', () => {
    // Bought 10 LTC at 70.97 as a taker (0.80%): Kraken shows 70.97, the cost per unit with the fee is 71.53776.
    const [p] = buildManualPositions({
      allocation: allocationOf({ asset: 'LTC', total: 10, valueUsd: 720, acknowledgedQty: 10 }),
      acks: [ack({ id: 1, subject: 'LTC' })],
      orders: [krakenOrder({ txid: 'ltc', pair: 'LTC/USD', side: 'buy', volExec: 10, costUsd: 709.7, feeUsd: 5.6776 })],
      excludeTxids: NONE,
    });
    expect(p!.avgEntryUsd).toBeCloseTo(70.97, 9);
    expect(p!.breakEvenUsd).toBeCloseTo(71.53776, 9);
    expect(p!.costBasisUsd).toBeCloseTo(715.3776, 9);
    expect(p!.unrealizedUsd).toBeCloseTo(720 - 715.3776, 9);
  });

  it('derives entry, value and unrealized P&L for a manual holding', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({}),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [buy('a', 1, 1, 2000, 8)],
      excludeTxids: NONE,
    });
    expect(p).toMatchObject({
      asset: 'ETH',
      qty: 1,
      basisQty: 1,
      unknownQty: 0,
      avgEntryUsd: 2000,
      breakEvenUsd: 2008,
      costBasisUsd: 2008,
    });
    expect(p!.unrealizedUsd).toBeCloseTo(992, 9);
    expect(p!.unrealizedPct).toBeCloseTo(992 / 2008, 9);
  });

  it('prices only what orders explain and reports the rest as unknown', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({ total: 3, valueUsd: 9000, acknowledgedQty: 3 }),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [buy('a', 1, 1, 2000, 0)],
      excludeTxids: NONE,
    });
    expect(p).toMatchObject({ qty: 3, basisQty: 1, unknownQty: 2, costBasisUsd: 2000, valueUsd: 9000 });
    expect(p!.unrealizedUsd).toBeCloseTo(1000, 9);
  });

  it('has no basis, and no P&L, without a Kraken buy', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({}),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [],
      excludeTxids: NONE,
    });
    expect(p).toMatchObject({
      basisQty: 0,
      unknownQty: 1,
      avgEntryUsd: null,
      breakEvenUsd: null,
      costBasisUsd: null,
      unrealizedUsd: null,
    });
  });

  it('ignores bot-owned buys, ignored acks, cash and unacknowledged holdings; unpriced stays null', () => {
    const out = buildManualPositions({
      allocation: allocationOf(
        { asset: 'ETH', ackId: 1 },
        { asset: 'SHIB', ackId: 2, valueUsd: null },
        { asset: 'BTC', ackId: null, acknowledgedQty: null },
        { asset: 'USD', ackId: 3 },
      ),
      acks: [
        ack({ id: 1, subject: 'ETH' }),
        ack({ id: 2, subject: 'SHIB' }),
        ack({ id: 3, subject: 'USD' }),
        ack({ id: 4, subject: 'XRP', label: 'ignored' }),
      ],
      orders: [buy('bot', 1, 1, 2000, 0), krakenOrder({ txid: 'shib', pair: 'SHIB/USD', volExec: 100, costUsd: 1 })],
      excludeTxids: new Set(['bot']),
    });
    expect(out.map((p) => p.asset)).toEqual(['ETH', 'SHIB']);
    expect(out[0]).toMatchObject({ asset: 'ETH', avgEntryUsd: null });
    expect(out[1]).toMatchObject({ asset: 'SHIB', priceUsd: null, valueUsd: null, unrealizedUsd: null });
  });
});

describe('positions with the ledger', () => {
  const led = (over: Partial<LedgerEntry>): LedgerEntry => ({
    ledgerId: `L${Math.random()}`,
    refid: 'R',
    at: 10,
    type: 'deposit',
    subtype: null,
    asset: 'ETH',
    amount: 1,
    fee: 0,
    ...over,
  });
  const buyCrypto = (refid: string, at: number, usd: number, fee: number, qty: number): LedgerEntry[] => [
    led({ refid, at, type: 'spend', asset: 'USD', amount: -usd, fee }),
    led({ refid, at, type: 'receive', asset: 'ETH', amount: qty }),
  ];

  it('prices a Buy Crypto purchase that has no order, exactly, with its fee', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({}),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [],
      excludeTxids: NONE,
      ledger: buyCrypto('P1', 5, 2000, 8, 1),
    });
    expect(p).toMatchObject({
      basisQty: 1,
      unknownQty: 0,
      avgEntryUsd: 2000,
      breakEvenUsd: 2008,
      ledgerTrades: 1,
      orders: 1,
      firstBuyAt: 5,
    });
    expect(p!.unrealizedUsd).toBeCloseTo(992, 9);
  });

  it('blends order buys and ledger buys by time', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({ total: 2, valueUsd: 6000, acknowledgedQty: 2 }),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [buy('a', 1, 1, 2000, 0)],
      excludeTxids: NONE,
      ledger: buyCrypto('P1', 500_000, 3000, 0, 1),
    });
    expect(p).toMatchObject({ basisQty: 2, avgEntryUsd: 2500, breakEvenUsd: 2500, ledgerTrades: 1, orders: 2 });
  });

  it('explains unpriced quantity by where it came from, without inventing a cost', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({ total: 1.5, valueUsd: 4500, acknowledgedQty: 1.5 }),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [],
      excludeTxids: NONE,
      ledger: [
        led({ type: 'deposit', amount: 1 }),
        led({ type: 'staking', amount: 0.25 }),
        led({ type: 'staking', amount: 0.25 }),
      ],
    });
    expect(p).toMatchObject({
      basisQty: 0,
      unknownQty: 1.5,
      avgEntryUsd: null,
      breakEvenUsd: null,
      costBasisUsd: null,
    });
    expect(p!.inflows).toEqual([
      { kind: 'deposit', qty: 1 },
      { kind: 'reward', qty: 0.5 },
    ]);
  });

  it('counts a ledger buy once when an order records the same trade', () => {
    const [p] = buildManualPositions({
      allocation: allocationOf({}),
      acks: [ack({ id: 1, subject: 'ETH' })],
      orders: [buy('a', 5, 1, 2000, 8)],
      excludeTxids: NONE,
      ledger: buyCrypto('P1', 5, 2000, 8, 1),
    });
    expect(p).toMatchObject({ basisQty: 1, orders: 1, ledgerTrades: 0, avgEntryUsd: 2000, breakEvenUsd: 2008 });
  });
});
