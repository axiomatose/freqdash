import { describe, expect, it } from 'vitest';
import type { Freshness } from '@/shared/types/domain';
import {
  intParam,
  mockAcks,
  mockBotDetail,
  mockChart,
  mockEquityResponse,
  mockFindingById,
  mockFindingsResponse,
  mockJson,
  mockKrakenOrdersResponse,
  mockOverview,
  mockStatusResponse,
  mockSummary,
  mockTradesResponse,
  MOCK_HEADER,
} from './responses';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function roundTrips(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

describe('mock responses', () => {
  it('are deterministic for a given clock and JSON-serializable', () => {
    for (const build of [
      () => mockSummary(NOW),
      () => mockOverview(NOW),
      () => mockBotDetail('votemax', NOW),
      () => mockTradesResponse(NOW),
      () => mockKrakenOrdersResponse(NOW),
      () => mockFindingsResponse(NOW),
      () => mockEquityResponse(NOW),
      () => mockStatusResponse(NOW),
      () => mockChart('votemax', 'BTC/USD', '4h', 100, NOW),
    ]) {
      expect(build()).toEqual(build());
      roundTrips(build());
    }
  });

  it('summary agrees with overview and findings', () => {
    const summary = mockSummary(NOW);
    const overview = mockOverview(NOW);
    expect(summary.mode).toBe('kraken');
    expect(summary.bots.map((b) => b.botId)).toEqual(['votemax', 'dca']);
    expect(summary.findings).toMatchObject({ critical: 1, warning: 1, info: 0, silenced: 1 });
    expect(summary.findings.top?.rule).toBe('UNPERSISTED_ORDER');
    expect(summary.accountTotalUsd).toBe(overview.account?.totalUsd);
    expect(overview.findings.counts).toEqual({ critical: 1, warning: 1, info: 0 });
    expect(summary.monitor.stalled).toBe(false);
  });

  it('allocation adds up to the account total (the plan invariant, within one cent)', () => {
    const { allocation, account } = mockOverview(NOW);
    expect(allocation && account).toBeTruthy();
    if (!allocation || !account) return;
    const sum =
      allocation.usdCash +
      allocation.botPositions.reduce((s, p) => s + p.valueUsd, 0) +
      allocation.acknowledgedUsd +
      allocation.untrackedUsd +
      allocation.dustUsd;
    expect(Math.abs(sum - allocation.totalUsd)).toBeLessThan(0.01);
    expect(allocation.totalUsd).toBeCloseTo(account.totalUsd, 6);
  });

  it('overview shows both freshness extremes so the UI has something to render', () => {
    const states = new Set(mockOverview(NOW).sources.map((s: Freshness) => s.state));
    expect(states.has('fresh')).toBe(true);
    expect(states.has('aging')).toBe(true);
  });

  it('bot detail exists for the two mock bots and is null for an unknown one', () => {
    expect(mockBotDetail('votemax', NOW)?.openTrades.map((t) => t.tradeId)).toEqual([8]);
    expect(mockBotDetail('dca', NOW)?.openTrades.map((t) => t.tradeId)).toEqual([4]);
    expect(mockBotDetail('nope', NOW)).toBeNull();
  });

  it('trades honor filters, paging and totals', () => {
    expect(mockTradesResponse(NOW).total).toBe(4);
    expect(mockTradesResponse(NOW, { status: 'open' }).trades.every((t) => t.isOpen)).toBe(true);
    expect(mockTradesResponse(NOW, { status: 'closed' }).total).toBe(2);
    expect(mockTradesResponse(NOW, { bot: 'dca' }).trades.map((t) => t.botId)).toEqual(['dca', 'dca']);
    expect(mockTradesResponse(NOW, { pair: 'BTC/USD' }).total).toBe(2);
    const page = mockTradesResponse(NOW, { limit: 1, offset: 1 });
    expect(page.trades).toHaveLength(1);
    expect(page.total).toBe(4);
    const all = mockTradesResponse(NOW);
    expect(all.trades[0]?.krakenMatch).toEqual({ 'O6ROFS-APVH7-255LCC': 'matched' });
    expect(all.totals.feesUsd).toBeGreaterThan(0);
  });

  it('trade P&L is internally consistent', () => {
    for (const t of mockTradesResponse(NOW).trades) {
      expect(t.pnl.totalUsd).toBeCloseTo((t.pnl.realizedUsd ?? 0) + (t.pnl.unrealizedUsd ?? 0), 9);
      expect(t.entries).toBe(t.orders.filter((o) => o.isEntry).length);
      expect(t.pnl.openQty).toBeCloseTo(t.pnl.entryQty - t.pnl.exitQty, 12);
    }
  });

  it('findings filter by status and severity and keep counts over the whole set', () => {
    expect(mockFindingsResponse(NOW).findings.map((f) => f.id)).toEqual([1, 2]);
    expect(mockFindingsResponse(NOW, { status: 'silenced' }).findings.map((f) => f.id)).toEqual([3]);
    expect(mockFindingsResponse(NOW, { status: 'resolved' }).findings.map((f) => f.id)).toEqual([4]);
    expect(mockFindingsResponse(NOW, { status: 'all' }).findings).toHaveLength(4);
    expect(mockFindingsResponse(NOW, { status: 'all', severity: 'critical' }).findings.map((f) => f.id)).toEqual([1]);
    expect(mockFindingsResponse(NOW).counts).toEqual({ critical: 1, warning: 1, info: 0, silenced: 1, resolved24h: 1 });
    expect(mockFindingById(2, NOW)?.rule).toBe('UNTRACKED_HOLDING');
    expect(mockFindingById(999, NOW)).toBeNull();
  });

  it('kraken orders filter by match state', () => {
    expect(mockKrakenOrdersResponse(NOW).orders).toHaveLength(3);
    expect(mockKrakenOrdersResponse(NOW, { match: 'matched' }).orders.map((o) => o.txid)).toEqual([
      'O6ROFS-APVH7-255LCC',
    ]);
    expect(mockKrakenOrdersResponse(NOW, { match: 'unmatched' }).orders.map((o) => o.txid)).toEqual([
      'OWDY2Z-TVWRN-IJBALL',
    ]);
    expect(mockKrakenOrdersResponse(NOW, { match: 'acked' }).orders.map((o) => o.txid)).toEqual([
      'OYYVFI-FJISQ-5N6DW5',
    ]);
    expect(mockKrakenOrdersResponse(NOW, { pair: 'ETH/USD' }).orders).toHaveLength(1);
    expect(mockAcks(NOW)).toHaveLength(1);
  });

  it('equity has 60 ascending points per range plus a deposit flow', () => {
    for (const range of ['24h', '7d', '30d', '90d', 'all'] as const) {
      const eq = mockEquityResponse(NOW, range);
      expect(eq.points).toHaveLength(60);
      const times = eq.points.map((p) => p.t);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(new Set(times).size).toBe(60);
      expect(eq.flowsAvailable).toBe(true);
    }
  });

  it('status is complete', () => {
    const status = mockStatusResponse(NOW);
    expect(status.logTails.map((l) => l.botId)).toEqual(['votemax', 'dca']);
    expect(status.kraken.configured).toBe(true);
  });
});

describe('mockChart', () => {
  it('returns ascending unique candle times aligned to the timeframe', () => {
    const chart = mockChart('votemax', 'BTC/USD', '4h', 150, NOW);
    const times = chart.candles.map((c) => c.time);
    expect(chart.candles).toHaveLength(150);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(times.every((t) => t % 14_400 === 0)).toBe(true);
    expect(chart.candles.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))).toBe(
      true,
    );
  });

  it('puts strategy timeframes on the freqtrade source with indicators and markers on existing bars', () => {
    const chart = mockChart('votemax', 'BTC/USD', '4h', 100, NOW);
    const barTimes = new Set(chart.candles.map((c) => c.time));
    expect(chart.source).toBe('freqtrade');
    expect(chart.strategy).toBe('VoteMaxStrategy');
    expect(chart.indicators.map((i) => i.key)).toEqual(['ema20', 'ema50', 'rsi', 'rsi_ob']);
    for (const i of chart.indicators.filter((x) => x.kind !== 'threshold')) expect(i.points).toHaveLength(100);
    expect(chart.signals.map((s) => s.kind)).toEqual(['enter', 'exit']);
    expect(chart.signals.every((s) => barTimes.has(s.time))).toBe(true);
    expect(chart.fills).toHaveLength(1);
    expect(barTimes.has(chart.fills[0]?.time ?? -1)).toBe(true);
    expect(chart.positions).toHaveLength(1);
  });

  it('uses the kraken source without indicators for other timeframes', () => {
    const chart = mockChart('votemax', 'BTC/USD', '1h', 100, NOW);
    expect(chart).toMatchObject({ source: 'kraken', strategy: null, indicators: [], signals: [] });
    expect(chart.meta.liveCandle).toBe(true);
  });

  it('adds the DcaBot signals note only for the dca bot and no fills for other pairs', () => {
    expect(mockChart('dca', 'ETH/USD', '4h', 50, NOW).meta.signalsNote).toContain('DcaBot');
    expect(mockChart('votemax', 'ETH/USD', '4h', 50, NOW).meta.signalsNote).toBeNull();
    expect(mockChart('votemax', 'ETH/USD', '4h', 50, NOW).fills).toEqual([]);
  });

  it('clamps the candle count', () => {
    expect(mockChart('votemax', 'BTC/USD', '4h', 5, NOW).candles).toHaveLength(20);
    expect(mockChart('votemax', 'BTC/USD', '4h', 5000, NOW).candles).toHaveLength(200);
  });
});

describe('helpers', () => {
  it('mockJson marks responses as mock and uncacheable', async () => {
    const res = mockJson({ a: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get(MOCK_HEADER)).toBe('1');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('intParam accepts only plain non-negative integers', () => {
    expect(intParam('25')).toBe(25);
    expect(intParam('0')).toBe(0);
    for (const bad of [null, '', '-1', '1.5', 'abc', '1e3', '12345678901']) expect(intParam(bad)).toBeUndefined();
  });
});
