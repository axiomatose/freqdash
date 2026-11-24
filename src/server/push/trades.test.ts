import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotOrder, BotTrade } from '@/shared/types/domain';
import { installTempDb, type TempDb } from '../db/testing';
import { announceTrades, claimNewTradeEvents, formatHeld, tradeEventCandidates } from './trades';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 2, 12);

function order(over: Partial<BotOrder>): BotOrder {
  return {
    botId: 'votemax',
    tradeId: 1,
    orderId: 'o1',
    pair: 'ETH/USD',
    side: 'buy',
    isEntry: true,
    tag: null,
    status: 'closed',
    orderType: 'limit',
    amount: 0.02,
    filled: 0.02,
    remaining: 0,
    price: 2500,
    cost: 50,
    placedAt: NOW - HOUR,
    filledAt: NOW - HOUR,
    isOpen: false,
    ...over,
  };
}

function trade(over: Partial<BotTrade> = {}): BotTrade {
  return {
    botId: 'votemax',
    tradeId: 1,
    key: 'votemax:1',
    pair: 'ETH/USD',
    base: 'ETH',
    quote: 'USD',
    isOpen: true,
    strategy: 'VoteMaxMulti',
    enterTag: 'vote_4',
    exitReason: null,
    amount: 0.02,
    stakeAmount: 50,
    maxStakeAmount: 50,
    openRate: 2500,
    closeRate: null,
    botCurrentRate: 2510,
    openedAt: NOW - HOUR,
    openFilledAt: NOW - HOUR,
    closedAt: null,
    feeOpenRate: 0.004,
    feeOpenCost: 0.2,
    feeCloseRate: null,
    feeCloseCost: null,
    entries: 1,
    exits: 0,
    hasOpenOrders: false,
    orders: [order({})],
    ftProfitAbs: null,
    pnl: {
      entryQty: 0.02,
      exitQty: 0,
      openQty: 0.02,
      entryCostUsd: 50,
      exitProceedsUsd: 0,
      feesUsd: 0.2,
      costBasisUsd: 50.2,
      realizedUsd: 0,
      unrealizedUsd: 0,
      totalUsd: 0,
      roiOnStake: 0,
      markPrice: 2510,
      markSource: 'bot',
    },
    ...over,
  };
}

describe('tradeEventCandidates', () => {
  it('announces each filled entry order: the first as a buy, later ones as adds', () => {
    const t = trade({
      orders: [
        order({ orderId: 'o2', filledAt: NOW - 30 * 60_000, cost: 25, filled: 0.01, price: 2400 }),
        order({ orderId: 'o1' }),
        order({ orderId: 'o3', isOpen: true, filled: 0, filledAt: null }), // still open: not yet
        order({ orderId: 'o4', isEntry: false, side: 'sell' }),
      ],
    });
    const events = tradeEventCandidates('VoteMax', [t]);
    expect(events.map((e) => [e.key, e.kind, e.title])).toEqual([
      ['entry:votemax:o1', 'entry', 'VoteMax bought ETH/USD'],
      ['entry:votemax:o2', 'entry', 'VoteMax added to (#2) ETH/USD'],
    ]);
    expect(events[0]?.body).toBe('0.02 ETH @ 2,500 · $50.00 · vote_4');
    expect(events[0]?.url).toBe('/bots/votemax');
  });

  it('announces a closed trade with fee-adjusted P&L, reason and holding time', () => {
    const closed = trade({
      isOpen: false,
      closedAt: NOW,
      closeRate: 2600,
      exitReason: 'roi',
      pnl: { ...trade().pnl, realizedUsd: 1.234, roiOnStake: 0.0246 },
    });
    const exit = tradeEventCandidates('VoteMax', [closed]).find((e) => e.kind === 'exit');
    expect(exit).toMatchObject({
      key: 'exit:votemax:1',
      at: NOW,
      title: 'VoteMax sold ETH/USD · +$1.23 (+2.46%)',
      body: '@ 2,600 · roi · held 1h 0m · fees included',
    });
    const loss = tradeEventCandidates('DCA', [
      { ...closed, pnl: { ...closed.pnl, realizedUsd: -0.5, roiOnStake: -0.01 } },
    ]);
    expect(loss.find((e) => e.kind === 'exit')?.title).toBe('DCA sold ETH/USD · -$0.50 (-1.00%)');
  });

  it('formats holding times', () => {
    expect(formatHeld(5 * 60_000)).toBe('5m');
    expect(formatHeld(3 * HOUR + 12 * 60_000)).toBe('3h 12m');
    expect(formatHeld(50 * HOUR)).toBe('2d 2h');
  });
});

describe('claimNewTradeEvents', () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = installTempDb();
  });
  afterEach(() => temp.cleanup());

  it('replays nothing on the first run, then announces each new event exactly once', () => {
    const old = tradeEventCandidates('VoteMax', [trade()]);
    expect(claimNewTradeEvents(old, NOW)).toEqual([]); // happened before announcements started

    const fresh = tradeEventCandidates('VoteMax', [
      trade({ tradeId: 2, orders: [order({ orderId: 'n1', tradeId: 2, filledAt: NOW + 1000 })] }),
    ]);
    expect(claimNewTradeEvents(fresh, NOW + 2000).map((e) => e.key)).toEqual(['entry:votemax:n1']);
    expect(claimNewTradeEvents(fresh, NOW + 3000)).toEqual([]);
  });

  it('skips events older than 6 hours (no flood after an outage)', () => {
    claimNewTradeEvents([], NOW); // start announcements
    const late = tradeEventCandidates('VoteMax', [
      trade({ orders: [order({ orderId: 'late', filledAt: NOW + HOUR })] }),
    ]);
    expect(claimNewTradeEvents(late, NOW + 8 * HOUR)).toEqual([]);
  });

  it('announceTrades hands only new events to the announcer and never throws', async () => {
    claimNewTradeEvents([], NOW);
    const notifyTrades = vi.fn(async () => {});
    const t = trade({ orders: [order({ orderId: 'x1', filledAt: NOW + 10 })] });
    await announceTrades({ notifyTrades }, 'votemax', 'VoteMax', [t], NOW + 20);
    await announceTrades({ notifyTrades }, 'votemax', 'VoteMax', [t], NOW + 30);
    expect(notifyTrades).toHaveBeenCalledOnce();
    const failing = { notifyTrades: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const t2 = trade({ orders: [order({ orderId: 'x2', filledAt: NOW + 40 })] });
    await expect(announceTrades(failing, 'votemax', 'VoteMax', [t2], NOW + 50)).resolves.toBeUndefined();
  });
});
