import { describe, expect, it } from 'vitest';
import type { Allocation } from '@/shared/types/domain';
import { ack, balance, openTrade } from '../../../test/fixtures/incident/builders';
import { buildAccountSnapshot } from './account';
import { ackCoverage, botClaimedQty, buildAllocation, findAssetAck, isAckActive } from './allocation';

const NOW = 1_000_000;

function total(a: Allocation): number {
  return (
    a.usdCash + a.botPositions.reduce((s, b) => s + b.valueUsd, 0) + a.acknowledgedUsd + a.untrackedUsd + a.dustUsd
  );
}

function snapshotOf(balances: ReturnType<typeof balance>[], prices: Record<string, number>) {
  return buildAccountSnapshot({ kraken: { balances, balancesAt: NOW }, wallets: [], prices })!;
}

describe('buildAllocation', () => {
  const prices = { USD: 1, BTC: 80_000, ETH: 2_500, SHIB: 0.000005645, BABY: 0.0133 };

  it('splits the live-like account into cash, bot positions, acknowledged, untracked and dust (invariant +-0.01)', () => {
    const snapshot = snapshotOf(
      [
        balance('USD', 1461.9925, 1),
        balance('BTC', 0.00046744, null),
        balance('ETH', 0.113, null),
        balance('SHIB', 1_901_628.18, null),
        balance('BABY', 0.21895, null),
      ],
      prices,
    );
    const alloc = buildAllocation({
      snapshot,
      bots: [
        { botId: 'votemax', openTrades: [openTrade('votemax', 'BTC', 0.00046744, 80_000)] },
        { botId: 'dca', openTrades: [] },
      ],
      acks: [ack({ id: 7, subject: 'SHIB' })],
      now: NOW,
    });
    expect(alloc.totalUsd).toBeCloseTo(snapshot.totalUsd, 9);
    expect(Math.abs(total(alloc) - alloc.totalUsd)).toBeLessThan(0.01);
    expect(alloc.usdCash).toBeCloseTo(1461.9925, 9);
    expect(alloc.botPositions).toEqual([
      { botId: 'votemax', valueUsd: expect.closeTo(0.00046744 * 80_000, 9) },
      { botId: 'dca', valueUsd: 0 },
    ]);
    expect(alloc.acknowledgedUsd).toBeCloseTo(1_901_628.18 * 0.000005645, 9);
    expect(alloc.untrackedUsd).toBeCloseTo(0.113 * 2_500, 9);
    expect(alloc.dustUsd).toBeCloseTo(0.21895 * 0.0133, 9);

    const by = (asset: string) => alloc.holdings.find((h) => h.asset === asset)!;
    expect(by('USD').status).toBe('cash');
    expect(by('BTC')).toMatchObject({ status: 'bot', byBot: [{ botId: 'votemax', qty: 0.00046744 }], untrackedQty: 0 });
    expect(by('ETH').status).toBe('untracked');
    expect(by('SHIB')).toMatchObject({ status: 'manual', ackId: 7 });
    expect(by('SHIB').acknowledgedQty).toBeCloseTo(1_901_628.18, 6);
    expect(by('BABY').status).toBe('dust');
  });

  it('honours a quantity baseline: the part above the baseline is untracked again', () => {
    const snapshot = snapshotOf([balance('ETH', 1, null)], prices);
    const alloc = buildAllocation({ snapshot, bots: [], acks: [ack({ subject: 'ETH', qtyBaseline: 0.6 })], now: NOW });
    const eth = alloc.holdings[0]!;
    expect(eth.acknowledgedQty).toBeCloseTo(0.6, 12);
    expect(eth.untrackedQty).toBeCloseTo(0.4, 12);
    expect(eth.status).toBe('untracked');
    expect(alloc.acknowledgedUsd).toBeCloseTo(1500, 9);
    expect(alloc.untrackedUsd).toBeCloseTo(1000, 9);
    expect(Math.abs(total(alloc) - alloc.totalUsd)).toBeLessThan(0.01);
  });

  it('ignores expired and revoked acknowledgements', () => {
    const snapshot = snapshotOf([balance('ETH', 1, null)], prices);
    const expired = buildAllocation({ snapshot, bots: [], acks: [ack({ subject: 'ETH', expiresAt: NOW })], now: NOW });
    expect(expired.untrackedUsd).toBeCloseTo(2500, 9);
    const revoked = buildAllocation({
      snapshot,
      bots: [],
      acks: [ack({ subject: 'ETH', revokedAt: NOW - 1 })],
      now: NOW,
    });
    expect(revoked.acknowledgedUsd).toBe(0);
  });

  it('scales bot claims down when they exceed what the account holds, keeping the invariant', () => {
    const snapshot = snapshotOf([balance('ETH', 1, null)], prices);
    const alloc = buildAllocation({
      snapshot,
      bots: [
        { botId: 'a', openTrades: [openTrade('a', 'ETH', 1.5, 2500)] },
        { botId: 'b', openTrades: [openTrade('b', 'ETH', 0.5, 2500)] },
      ],
      acks: [],
      now: NOW,
    });
    expect(alloc.botPositions[0]!.valueUsd).toBeCloseTo(1875, 9);
    expect(alloc.botPositions[1]!.valueUsd).toBeCloseTo(625, 9);
    expect(alloc.untrackedUsd).toBe(0);
    expect(Math.abs(total(alloc) - alloc.totalUsd)).toBeLessThan(0.01);
  });

  it('leaves unpriced assets out of the sums but still flags a real untracked quantity', () => {
    const snapshot = snapshotOf([balance('USD', 10, 1), balance('MYSTERY', 3, null), balance('TINY', 0, null)], {
      USD: 1,
    });
    const alloc = buildAllocation({ snapshot, bots: [], acks: [], now: NOW });
    expect(alloc.totalUsd).toBe(10);
    expect(alloc.untrackedUsd).toBe(0);
    const m = alloc.holdings.find((h) => h.asset === 'MYSTERY')!;
    expect(m).toMatchObject({ valueUsd: null, untrackedUsd: null, untrackedQty: 3, status: 'untracked' });
    expect(alloc.holdings.some((h) => h.asset === 'TINY')).toBe(false);
    expect(Math.abs(total(alloc) - alloc.totalUsd)).toBeLessThan(0.01);
  });

  it('shows a bot-owned holding with sub-dollar dust left over as bot, not dust', () => {
    const snapshot = snapshotOf([balance('BTC', 0.0100004, null)], { BTC: 100 });
    const alloc = buildAllocation({
      snapshot,
      bots: [{ botId: 'votemax', openTrades: [openTrade('votemax', 'BTC', 0.01, 100)] }],
      acks: [],
      now: NOW,
    });
    expect(alloc.holdings[0]!.status).toBe('bot');
    expect(alloc.dustUsd).toBeCloseTo(0.00004, 9);
    expect(Math.abs(total(alloc) - alloc.totalUsd)).toBeLessThan(0.01);
  });
});

describe('ack helpers', () => {
  it('isAckActive / findAssetAck respect revocation and expiry', () => {
    expect(isAckActive(ack({}), NOW)).toBe(true);
    expect(isAckActive(ack({ expiresAt: NOW + 1 }), NOW)).toBe(true);
    expect(isAckActive(ack({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isAckActive(ack({ revokedAt: 1 }), NOW)).toBe(false);
    expect(findAssetAck([ack({ kind: 'kraken_order', subject: 'ETH' })], 'ETH', NOW)).toBeNull();
    expect(findAssetAck([ack({ subject: 'ETH' })], 'ETH', NOW)?.subject).toBe('ETH');
  });

  it('ackCoverage: null baseline covers everything, a baseline covers up to itself, nothing covers nothing', () => {
    expect(ackCoverage(null, 5)).toBe(0);
    expect(ackCoverage(ack({ qtyBaseline: null }), 5)).toBe(5);
    expect(ackCoverage(ack({ qtyBaseline: 2 }), 5)).toBe(2);
    expect(ackCoverage(ack({ qtyBaseline: 9 }), 5)).toBe(5);
    expect(ackCoverage(ack({ qtyBaseline: null }), 0)).toBe(0);
  });

  it('botClaimedQty sums the open quantity of the matching base asset only', () => {
    const trades = [
      openTrade('a', 'ETH', 0.2, 1, { tradeId: 1 }),
      openTrade('a', 'ETH', 0.3, 1, { tradeId: 2 }),
      openTrade('a', 'BTC', 9, 1, { tradeId: 3 }),
    ];
    expect(botClaimedQty(trades, 'ETH')).toBeCloseTo(0.5, 12);
    expect(botClaimedQty(trades, 'DOGE')).toBe(0);
  });
});
