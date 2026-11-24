import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding, RawFinding } from '@/shared/types/findings';
import { closeDb } from '../db/client';
import {
  createAcks,
  insertEquitySnapshot,
  insertEvents,
  listAcks,
  saveLifecycle,
  upsertFlows,
  upsertKrakenOrders,
  upsertLedgerEntries,
} from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { buildAcks, createAcksFromBody, revokeAckById } from './acks';
import { botStatus } from './common';
import { buildBotDetail } from './bots';
import { buildEquity } from './equity';
import { buildFindings } from './findings';
import { buildKrakenOrders } from './krakenOrders';
import { buildOverview } from './overview';
import { buildPositions } from './positions';
import { buildStatus } from './status';
import { buildSummary } from './summary';
import { NOW, seededContext } from './testing';
import { buildTrades } from './trades';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => {
  temp.cleanup();
  closeDb();
});

function addFinding(
  over: Partial<RawFinding> & { silenced?: boolean; status?: 'active' | 'resolved' | 'pending' } = {},
): void {
  const raw: RawFinding = {
    rule: 'ORPHAN_KRAKEN_ORDER',
    fingerprint: over.fingerprint ?? 'ORPHAN_KRAKEN_ORDER:ETH/USD',
    severity: over.severity ?? 'critical',
    title: over.title ?? 'Orphan Kraken orders',
    detail: 'd',
    subject: { pair: 'ETH/USD' },
    evidence: {},
    evidenceKeys: over.evidenceKeys ?? ['a', 'b'],
  };
  const draft: Omit<Finding, 'id'> & { id: null } = {
    ...raw,
    evidenceKeys: raw.evidenceKeys ?? [],
    id: null,
    status: over.status ?? 'active',
    maxSeverity: raw.severity,
    firstSeenAt: NOW - 100_000,
    episodeStartAt: NOW - 100_000,
    activeSince: NOW - 90_000,
    lastSeenAt: NOW - 1_000,
    clearedAt: null,
    resolvedAt: over.status === 'resolved' ? NOW - 10_000 : null,
    occurrences: 1,
    flapCount: 0,
    silenced: over.silenced ? { at: NOW, by: null, note: null, severity: raw.severity, evidenceCount: 2 } : null,
    notifiedAt: null,
    notifiedSeverity: null,
    notifiedEvidenceCount: null,
  };
  saveLifecycle([draft]);
}

describe('summary', () => {
  it('reports mode, monitor, bots and finding counts', () => {
    addFinding();
    addFinding({ fingerprint: 'X:1', severity: 'warning', title: 'w' });
    addFinding({ fingerprint: 'X:2', severity: 'info', silenced: true });
    addFinding({ fingerprint: 'X:3', status: 'pending' });
    const s = buildSummary(seededContext());
    expect(s.mode).toBe('freqtrade-only');
    expect(s.monitor.stalled).toBe(false);
    expect(s.findings).toMatchObject({ critical: 1, warning: 1, info: 0, silenced: 1 });
    expect(s.findings.top?.title).toBe('Orphan Kraken orders');
    expect(s.bots.map((b) => b.botId).sort()).toEqual(['dca', 'votemax']);
  });

  it('marks monitoring as stalled when the last cycle is older than 60 s', () => {
    const ctx = seededContext((s) => {
      s.monitor.lastCycleAt = NOW - 61_000;
    });
    expect(buildSummary(ctx).monitor.stalled).toBe(true);
  });

  it('computes the bot status pill in priority order', () => {
    const ctx = seededContext();
    const bot = ctx.state.bots.votemax!;
    const at = (h: Partial<NonNullable<typeof bot.health>>, loop = false) =>
      botStatus({ ...bot, health: { ...bot.health!, ...h } }, NOW, loop);
    expect(at({ botStartupAt: 0, lastProcessAt: NOW - 1000 })).toBe('running');
    expect(at({ authFailed: true, reachable: false })).toBe('auth_error');
    expect(at({ reachable: false, unreachableSince: NOW - 40_000 })).toBe('down');
    expect(at({ reachable: false, unreachableSince: NOW - 5_000 })).toBe('restarting');
    expect(at({ botStartupAt: NOW - 30_000 })).toBe('restarting');
    expect(at({ botStartupAt: 0 }, true)).toBe('restarting');
    expect(at({ botStartupAt: 0, lastProcessAt: NOW - 200_000 })).toBe('stale');
    expect(botStatus({ ...bot, health: null }, NOW, false)).toBe('unknown');
    expect(
      botStatus(
        {
          ...bot,
          health: { ...bot.health!, botStartupAt: 0, lastProcessAt: NOW },
          config: { ...bot.config!, state: 'stopped' },
        },
        NOW,
        false,
      ),
    ).toBe('stopped');
  });
});

describe('overview and bot detail', () => {
  it('assembles cards, open positions and combined stats', () => {
    const o = buildOverview(seededContext());
    expect(o.bots).toHaveLength(2);
    expect(o.openPositions.length).toBeGreaterThan(0);
    expect(o.combined.totalUsd).toBeCloseTo(o.combined.realizedUsd + o.combined.unrealizedUsd, 8);
    expect(o.walletViews).toHaveLength(2);
    expect(o.account).toBeNull();
    expect(o.change24h).toBeNull();
  });

  it('reports the 24 h change from stored equity snapshots', () => {
    const ctx = seededContext((s) => {
      s.account = {
        source: 'bot-wallet',
        estimatedFromBot: 'votemax',
        asOf: NOW,
        totalUsd: 110,
        usdCash: 10,
        usdAvailable: null,
        holdings: [],
        unpricedAssets: [],
      };
    });
    insertEquitySnapshot({ at: NOW - 24 * 3_600_000, source: 'bot-wallet', totalUsd: 100, usdCash: 10, holdings: [] });
    const c = buildOverview(ctx).change24h;
    expect(c?.usd).toBeCloseTo(10, 6);
    expect(c?.pct).toBeCloseTo(10, 6);
  });

  it('builds the bot detail with per-pair figures, and null for an unknown bot', () => {
    insertEvents([{ botId: 'votemax', at: NOW - 1000, type: 'startup', source: 'logfile', fingerprint: 'f1' }]);
    const d = buildBotDetail(seededContext(), 'votemax');
    expect(d?.bot.restarts24h).toBe(1);
    expect(d?.recentClosed.length).toBeLessThanOrEqual(20);
    expect(d?.perPair.find((p) => p.pair === 'BTC/USD')?.openQty).toBeGreaterThan(0);
    expect(d?.events).toHaveLength(1);
    expect(buildBotDetail(seededContext(), 'nope')).toBeNull();
  });
});

describe('trades', () => {
  it('filters, paginates and totals', () => {
    const ctx = seededContext();
    const all = buildTrades(ctx, {});
    expect(all.total).toBe(all.trades.length);
    expect(buildTrades(ctx, { status: 'open' }).trades.every((t) => t.isOpen)).toBe(true);
    expect(buildTrades(ctx, { status: 'closed', bot: 'dca' }).trades.every((t) => t.botId === 'dca' && !t.isOpen)).toBe(
      true,
    );
    expect(buildTrades(ctx, { limit: 1 }).trades).toHaveLength(1);
    expect(buildTrades(ctx, { limit: 1, offset: 1 }).trades[0]?.tradeId).not.toBe(
      buildTrades(ctx, { limit: 1 }).trades[0]?.tradeId,
    );
    expect(buildTrades(ctx, { pair: 'NOPE/USD' }).total).toBe(0);
    const t = buildTrades(ctx, {}).totals;
    expect(Number.isFinite(t.realizedUsd + t.unrealizedUsd + t.feesUsd)).toBe(true);
  });

  it('reports "unknown" matches in freqtrade-only mode', () => {
    const t = buildTrades(seededContext(), {}).trades[0]!;
    expect(Object.values(t.krakenMatch).every((m) => m === 'unknown')).toBe(true);
  });

  it('matches bot orders against Kraken orders in kraken mode', () => {
    const base = seededContext();
    const order = base.state.bots.votemax!.openTrades[0]!.orders[0]!;
    const ctx = seededContext((s) => {
      s.kraken.status = 'ok';
      s.kraken.balances = [];
      s.kraken.balancesAt = NOW;
    });
    ctx.kraken.reconStartAt = 0;
    ctx.kraken.configured = true;
    upsertKrakenOrders(
      [
        {
          txid: order.orderId,
          pair: 'BTC/USD',
          krakenPair: 'XBTUSD',
          side: 'buy',
          orderType: 'limit',
          status: 'closed',
          openedAt: NOW - 1000,
          closedAt: NOW,
          vol: order.filled * 2,
          volExec: order.filled * 2,
          costUsd: 1,
          feeUsd: 0,
          avgPrice: 1,
          limitPrice: 1,
          userref: null,
          clOrdId: null,
          reason: null,
        },
      ],
      NOW,
    );
    const match = buildTrades(ctx, { bot: 'votemax', status: 'open' }).trades[0]!.krakenMatch[order.orderId];
    expect(match).toBe('mismatch');
  });
});

describe('kraken orders', () => {
  it('is disabled without a key', () => {
    expect(buildKrakenOrders(seededContext(), {})).toMatchObject({ enabled: false, orders: [] });
  });

  it('attributes, filters by match and attaches acks', () => {
    const ctx = seededContext();
    ctx.kraken.configured = true;
    ctx.kraken.reconStartAt = 0;
    const known = ctx.state.bots.votemax!.openTrades[0]!.orders[0]!.orderId;
    const mk = (txid: string, openedAt: number) => ({
      txid,
      pair: 'ETH/USD',
      krakenPair: 'ETHUSD',
      side: 'buy' as const,
      orderType: 'market',
      status: 'closed' as const,
      openedAt,
      closedAt: openedAt + 1,
      vol: 1,
      volExec: 1,
      costUsd: 1,
      feeUsd: 0,
      avgPrice: 1,
      limitPrice: null,
      userref: null,
      clOrdId: null,
      reason: null,
    });
    upsertKrakenOrders(
      [mk(known, NOW - 3000), mk('OS53YL-DSP2B-BRE3O4', NOW - 2000), mk('OSA2VE-ZTAL3-A75NKI', NOW - 1000)],
      NOW,
    );
    insertEvents([
      {
        botId: 'votemax',
        at: NOW - 2000,
        type: 'order_created',
        source: 'logfile',
        orderId: 'OS53YL-DSP2B-BRE3O4',
        fingerprint: 'oc1',
      },
    ]);
    createAcksFromBody(ctx, { kind: 'kraken_order', subjects: ['OSA2VE-ZTAL3-A75NKI'], label: 'manual' }, 'me');

    const all = buildKrakenOrders(ctx, {});
    expect(all.orders.map((o) => o.txid)).toEqual(['OSA2VE-ZTAL3-A75NKI', 'OS53YL-DSP2B-BRE3O4', known]);
    expect(all.orders.find((o) => o.txid === 'OS53YL-DSP2B-BRE3O4')?.createdByBotLog).toBe('votemax');
    expect(buildKrakenOrders(ctx, { match: 'matched' }).orders.map((o) => o.txid)).toEqual([known]);
    expect(buildKrakenOrders(ctx, { match: 'unmatched' }).orders.map((o) => o.txid)).toEqual(['OS53YL-DSP2B-BRE3O4']);
    expect(buildKrakenOrders(ctx, { match: 'acked' }).orders.map((o) => o.txid)).toEqual(['OSA2VE-ZTAL3-A75NKI']);
    expect(buildKrakenOrders(ctx, { limit: 1 }).orders).toHaveLength(1);
  });
});

describe('findings', () => {
  it('splits active, silenced and resolved and counts them', () => {
    addFinding();
    addFinding({ fingerprint: 'S:1', severity: 'warning', silenced: true });
    addFinding({ fingerprint: 'R:1', status: 'resolved', severity: 'info' });
    const ctx = seededContext();
    const active = buildFindings(ctx, {});
    expect(active.findings.map((f) => f.fingerprint)).toEqual(['ORPHAN_KRAKEN_ORDER:ETH/USD']);
    expect(active.counts).toEqual({ critical: 1, warning: 0, info: 0, silenced: 1, resolved24h: 1 });
    expect(buildFindings(ctx, { status: 'silenced' }).findings).toHaveLength(1);
    expect(buildFindings(ctx, { status: 'resolved' }).findings).toHaveLength(1);
    expect(buildFindings(ctx, { status: 'all' }).findings).toHaveLength(3);
    expect(buildFindings(ctx, { status: 'all', severity: 'info' }).findings).toHaveLength(1);
    expect(active.engine).toMatchObject({ rules: 22, mode: 'freqtrade-only' });
  });
});

describe('acks', () => {
  it('creates in bulk, lists and revokes', () => {
    const ctx = seededContext();
    const { acks } = createAcksFromBody(
      ctx,
      { kind: 'asset', subjects: ['SHIB', 'BABY'], label: 'manual', qtyBaseline: 5 },
      'Ada',
    );
    expect(acks).toHaveLength(2);
    expect(buildAcks(ctx).acks).toHaveLength(2);
    expect(revokeAckById(ctx, acks[0]!.id, 'Ada')).toBe(true);
    expect(revokeAckById(ctx, acks[0]!.id, 'Ada')).toBe(false);
    expect(listAcks(NOW)).toHaveLength(1);
  });
});

describe('equity', () => {
  it('downsamples, and only offers flows in kraken mode with a ledger sync', () => {
    for (let i = 0; i < 40; i++)
      insertEquitySnapshot({ at: NOW - i * 300_000, source: 'kraken', totalUsd: 100 + i, usdCash: 1, holdings: [] });
    const ctx = seededContext();
    const e = buildEquity(ctx, '24h');
    expect(e.points.length).toBe(40);
    expect(e.flowsAvailable).toBe(false);
    expect(e.flows).toBeNull();

    upsertFlows([{ ledgerId: 'L1', at: NOW - 1000, type: 'deposit', asset: 'USD', amount: 5, fee: 0 }]);
    const kctx = seededContext((s) => {
      s.kraken.status = 'ok';
      s.kraken.balances = [];
      s.kraken.balancesAt = NOW;
      s.sources['kraken:ledgers'] = {
        key: 'kraken:ledgers',
        label: 'l',
        cadenceMs: 1,
        lastOkAt: NOW,
        lastAttemptAt: NOW,
        consecutiveFailures: 0,
        error: null,
        disabled: false,
      };
    });
    const k = buildEquity(kctx, '7d');
    expect(k.flowsAvailable).toBe(true);
    expect(k.flows).toHaveLength(1);
    expect(buildEquity(ctx, 'all').points.length).toBeLessThanOrEqual(500);
  });

  it('has no change without an account', () => {
    expect(buildEquity(seededContext(), '24h').change).toBeNull();
  });
});

describe('status', () => {
  it('reports db counts, sources and log tails', () => {
    addFinding();
    const s = buildStatus(seededContext());
    expect(s.db.findings).toBe(1);
    expect(s.kraken).toMatchObject({ configured: false, tier: 'starter' });
    expect(s.logTails.map((l) => l.botId).sort()).toEqual(['dca', 'votemax']);
    expect(s.sources.find((x) => x.source === 'bot:votemax:status')?.state).toBe('fresh');
  });
});

describe('positions', () => {
  const holding = {
    asset: 'ETH',
    total: 1,
    valueUsd: 3000,
    byBot: [],
    acknowledgedQty: 1,
    ackId: 1,
    untrackedQty: 0,
    untrackedUsd: 0,
    status: 'manual' as const,
  };
  const withAllocation = (s: ReturnType<typeof seededContext>['state']) => {
    (s as { allocation: unknown }).allocation = {
      totalUsd: 3000,
      usdCash: 0,
      botPositions: [],
      acknowledgedUsd: 3000,
      untrackedUsd: 0,
      dustUsd: 0,
      holdings: [holding],
    };
  };

  it('is disabled without Kraken', () => {
    const r = buildPositions(seededContext());
    expect(r).toMatchObject({ enabled: false, positions: [] });
  });

  it('derives a manual position from unowned Kraken orders and totals it', () => {
    const order = (txid: string, costUsd: number, feeUsd: number) => ({
      txid,
      pair: 'ETH/USD',
      krakenPair: 'ETHUSD',
      side: 'buy' as const,
      orderType: 'limit',
      status: 'closed' as const,
      openedAt: NOW - 5_000,
      closedAt: NOW - 4_000,
      vol: 1,
      volExec: 1,
      costUsd,
      feeUsd,
      avgPrice: costUsd,
      limitPrice: null,
      userref: null,
      clOrdId: null,
      reason: null,
    });
    createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);
    upsertKrakenOrders([order('manual-buy', 2000, 8), order('ignored-buy', 999, 0)], NOW);
    createAcks({ kind: 'kraken_order', subjects: ['ignored-buy'], label: 'ignored' }, NOW);
    const ctx = seededContext(withAllocation);
    const r = buildPositions({ ...ctx, kraken: { configured: true, tier: 'starter', reconStartAt: NOW - 10_000 } });
    expect(r.enabled).toBe(true);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({
      asset: 'ETH',
      avgEntryUsd: 2000,
      breakEvenUsd: 2008,
      costBasisUsd: 2008,
      unknownQty: 0,
    });
    expect(r.totals.unrealizedUsd).toBeCloseTo(992, 9);
  });

  it('prices a Buy Crypto purchase from the ledger when no order exists', () => {
    createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);
    const leg = (id: string, type: string, asset: string, amount: number, fee: number) => ({
      ledgerId: id,
      refid: 'P1',
      at: NOW - 4_000,
      type,
      subtype: null,
      asset,
      amount,
      fee,
    });
    upsertLedgerEntries([leg('L1', 'spend', 'USD', -2000, 8), leg('L2', 'receive', 'ETH', 1, 0)]);
    const ctx = seededContext(withAllocation);
    const r = buildPositions({ ...ctx, kraken: { configured: true, tier: 'starter', reconStartAt: NOW - 10_000 } });
    expect(r.positions[0]).toMatchObject({
      asset: 'ETH',
      avgEntryUsd: 2000,
      breakEvenUsd: 2008,
      ledgerTrades: 1,
      unknownQty: 0,
    });
    expect(r.totals.costBasisUsd).toBeCloseTo(2008, 9);
  });
});
