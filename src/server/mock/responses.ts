// MOCK DATA (WP0a). Type-correct sample payloads for every /api/v1/* route so the UI work packages can start
// before the real views exist. WP9 replaces the route handlers that use these builders; this module stays as
// shared sample data. Nothing here reads state, the database or the network, and none of it is real, so it does
// not import server-only and tests may import it directly.
import { APP_VERSION, CADENCE_MS, sourceKey, toFreshness } from '@/shared/constants';
import type {
  Acknowledgement,
  AccountSnapshot,
  Allocation,
  BotConfigInfo,
  BotEvent,
  BotHealth,
  BotOrder,
  BotStats,
  BotTrade,
  Candle,
  ChartData,
  Freshness,
  FtWalletView,
  IndicatorSeries,
  KrakenBalanceEntry,
  KrakenFlow,
  KrakenOrder,
  Ms,
  SeriesPoint,
} from '@/shared/types/domain';
import type { Finding } from '@/shared/types/findings';
import type {
  BotCard,
  BotDetailResponse,
  EquityRange,
  EquityResponse,
  FindingLite,
  FindingsResponse,
  KrakenOrdersResponse,
  OverviewResponse,
  StatusResponse,
  SummaryResponse,
  TradesResponse,
} from '@/shared/types/api';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FEE_RATE = 0.004;

export const MOCK_HEADER = 'X-Freqdash-Mock';

/** Parses a non-negative integer query parameter; anything else is undefined. */
export function intParam(value: string | null): number | undefined {
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

export function mockJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', [MOCK_HEADER]: '1' } });
}

const BOTS = [
  { botId: 'votemax', name: 'VoteMax', color: '#4F8CFF', strategy: 'VoteMaxStrategy', maxOpen: 3, adjust: false },
  { botId: 'dca', name: 'DCA', color: '#B38CFF', strategy: 'DcaBot', maxOpen: 2, adjust: true },
] as const;
type MockBot = (typeof BOTS)[number];

const PRICES: Record<string, number> = { BTC: 83_900, ETH: 3_230, SHIB: 0.00001, USD: 1 };

function fresh(source: string, label: string, cadenceMs: number, now: Ms, ageMs: number): Freshness {
  return toFreshness(
    source,
    label,
    { cadenceMs, lastOkAt: now - ageMs, lastAttemptAt: now - ageMs, consecutiveFailures: 0 },
    now,
  );
}

function freshnessList(now: Ms): Freshness[] {
  const list: Freshness[] = [];
  for (const b of BOTS) {
    list.push(fresh(sourceKey.bot(b.botId, 'health'), `${b.name} health`, CADENCE_MS['ft.health'], now, 4_000));
    list.push(fresh(sourceKey.bot(b.botId, 'status'), `${b.name} open trades`, CADENCE_MS['ft.status'], now, 9_000));
  }
  list.push(fresh(sourceKey.logtail('votemax'), 'VoteMax log tail', CADENCE_MS.logtail, now, 3_000));
  // Deliberately aging (4x cadence) so the UI has a non-fresh state to render.
  list.push(fresh(sourceKey.logtail('dca'), 'DCA log tail', CADENCE_MS.logtail, now, 20_000));
  list.push(fresh(sourceKey.kraken('balance'), 'Kraken balance', CADENCE_MS['kraken.balance'], now, 12_000));
  list.push(fresh(sourceKey.kraken('openOrders'), 'Kraken open orders', CADENCE_MS['kraken.openOrders'], now, 6_000));
  list.push(fresh(sourceKey.market('ticker'), 'Market prices', CADENCE_MS['market.ticker'], now, 8_000));
  return list;
}

function botConfig(b: MockBot): BotConfigInfo {
  return {
    botId: b.botId,
    botName: b.name,
    strategy: b.strategy,
    timeframe: '4h',
    timeframeMs: 4 * HOUR,
    stakeCurrency: 'USD',
    maxOpenTrades: b.maxOpen,
    dryRun: false,
    tradingMode: 'spot',
    state: 'running',
    runmode: 'live',
    version: '2026.8',
    positionAdjustment: b.adjust,
    exchange: 'kraken',
  };
}

function botHealth(now: Ms): BotHealth {
  return {
    reachable: true,
    authFailed: false,
    lastProcessAt: now - 3_000,
    botStartAt: now - 40 * DAY,
    botStartupAt: now - 6 * HOUR,
    unreachableSince: null,
  };
}

interface OrderSpec {
  orderId: string;
  price: number;
  qty: number;
  at: Ms;
}

function filledOrder(
  botId: string,
  tradeId: number,
  pair: string,
  side: 'buy' | 'sell',
  spec: OrderSpec,
  tag: string | null,
): BotOrder {
  return {
    botId,
    tradeId,
    orderId: spec.orderId,
    pair,
    side,
    isEntry: side === 'buy',
    tag,
    status: 'closed',
    orderType: 'limit',
    amount: spec.qty,
    filled: spec.qty,
    remaining: 0,
    price: spec.price,
    cost: spec.price * spec.qty,
    placedAt: spec.at,
    filledAt: spec.at + 20_000,
    isOpen: false,
  };
}

interface TradeSpec {
  bot: MockBot;
  tradeId: number;
  pair: string;
  entries: OrderSpec[];
  exit?: OrderSpec;
  mark?: number;
  tag?: string | null;
}

function makeTrade(t: TradeSpec): BotTrade {
  const qty = t.entries.reduce((sum, e) => sum + e.qty, 0);
  const entryCost = t.entries.reduce((sum, e) => sum + e.qty * e.price, 0);
  const feeOpen = entryCost * FEE_RATE;
  const costBasis = entryCost + feeOpen;
  const exitProceeds = t.exit ? t.exit.qty * t.exit.price : 0;
  const feeClose = exitProceeds * FEE_RATE;
  const realized = t.exit ? exitProceeds - costBasis - feeClose : 0;
  const mark = t.exit ? null : (t.mark ?? null);
  const unrealized = t.exit ? 0 : mark === null ? null : qty * mark * (1 - FEE_RATE) - costBasis;
  const total = unrealized === null ? null : realized + unrealized;
  const [base = '', quote = ''] = t.pair.split('/');
  const first = t.entries[0] as OrderSpec;
  const orders = [
    ...t.entries.map((e) => filledOrder(t.bot.botId, t.tradeId, t.pair, 'buy', e, t.tag ?? null)),
    ...(t.exit ? [filledOrder(t.bot.botId, t.tradeId, t.pair, 'sell', t.exit, 'roi')] : []),
  ];
  return {
    botId: t.bot.botId,
    tradeId: t.tradeId,
    key: `${t.bot.botId}:${t.tradeId}`,
    pair: t.pair,
    base,
    quote,
    isOpen: !t.exit,
    strategy: t.bot.strategy,
    enterTag: t.tag ?? null,
    exitReason: t.exit ? 'roi' : null,
    amount: t.exit ? 0 : qty,
    stakeAmount: entryCost,
    maxStakeAmount: entryCost,
    openRate: entryCost / qty,
    closeRate: t.exit?.price ?? null,
    botCurrentRate: mark,
    openedAt: first.at,
    openFilledAt: first.at + 20_000,
    closedAt: t.exit ? t.exit.at + 20_000 : null,
    feeOpenRate: FEE_RATE,
    feeOpenCost: feeOpen,
    feeCloseRate: t.exit ? FEE_RATE : null,
    feeCloseCost: t.exit ? feeClose : null,
    entries: t.entries.length,
    exits: t.exit ? 1 : 0,
    hasOpenOrders: false,
    orders,
    ftProfitAbs: total,
    pnl: {
      entryQty: qty,
      exitQty: t.exit?.qty ?? 0,
      openQty: t.exit ? 0 : qty,
      entryCostUsd: entryCost,
      exitProceedsUsd: exitProceeds,
      feesUsd: feeOpen + feeClose,
      costBasisUsd: costBasis,
      realizedUsd: realized,
      unrealizedUsd: unrealized,
      totalUsd: total,
      roiOnStake: total === null ? null : total / costBasis,
      markPrice: mark,
      markSource: mark === null ? null : 'kraken',
    },
  };
}

function mockTrades(now: Ms): BotTrade[] {
  const [votemax, dca] = BOTS;
  return [
    makeTrade({
      bot: votemax,
      tradeId: 8,
      pair: 'BTC/USD',
      mark: PRICES.BTC,
      tag: 'vote_entry',
      entries: [{ orderId: 'O6ROFS-APVH7-255LCC', price: 83_450, qty: 0.00046744, at: now - 3 * HOUR }],
    }),
    makeTrade({
      bot: dca,
      tradeId: 4,
      pair: 'ETH/USD',
      mark: PRICES.ETH,
      tag: 'dca_entry',
      entries: [
        { orderId: 'OTOGGE-TNK2B-4JCLKL', price: 3_180, qty: 0.0217, at: now - 2 * DAY },
        { orderId: 'OG2HPM-JWOQI-JZUMXB', price: 3_120, qty: 0.0217, at: now - 1 * DAY },
      ],
    }),
    makeTrade({
      bot: votemax,
      tradeId: 7,
      pair: 'ETH/USD',
      tag: 'vote_entry',
      entries: [{ orderId: 'ORUJRJ-4V7YP-KEUKYV', price: 3_050, qty: 0.0205, at: now - 9 * DAY }],
      exit: { orderId: 'O65RJB-OEQZN-YE72RL', price: 3_190, qty: 0.0205, at: now - 8 * DAY },
    }),
    makeTrade({
      bot: dca,
      tradeId: 3,
      pair: 'BTC/USD',
      tag: 'dca_entry',
      entries: [{ orderId: 'OPF6VN-SUL7J-4DYG3J', price: 82_100, qty: 0.00079, at: now - 15 * DAY }],
      exit: { orderId: 'OR6WR5-MSO5G-45BFW5', price: 81_000, qty: 0.00079, at: now - 14 * DAY },
    }),
  ];
}

function statsOf(trades: BotTrade[]): BotStats {
  const closed = trades.filter((t) => !t.isOpen);
  const open = trades.filter((t) => t.isOpen);
  const sum = (list: BotTrade[], pick: (t: BotTrade) => number): number => list.reduce((s, t) => s + pick(t), 0);
  const realized = sum(closed, (t) => t.pnl.realizedUsd);
  const unrealized = sum(open, (t) => t.pnl.unrealizedUsd ?? 0);
  const closedBasis = sum(closed, (t) => t.pnl.costBasisUsd);
  const openBasis = sum(open, (t) => t.pnl.costBasisUsd);
  const wins = closed.filter((t) => t.pnl.realizedUsd > 0).length;
  const peak = Math.max(0, ...trades.map((t) => t.pnl.costBasisUsd));
  return {
    closedTrades: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? wins / closed.length : null,
    realizedUsd: realized,
    unrealizedUsd: unrealized,
    totalUsd: realized + unrealized,
    closedCostBasisUsd: closedBasis,
    roiOnStake: closedBasis ? realized / closedBasis : null,
    openTrades: open.length,
    openCostBasisUsd: openBasis,
    openMarketValueUsd: open.length ? sum(open, (t) => t.pnl.openQty * (t.pnl.markPrice ?? 0)) : null,
    peakConcurrentStakeUsd: peak,
    returnOnPeakStake: peak ? (realized + unrealized) / peak : null,
    feesUsd: sum(trades, (t) => t.pnl.feesUsd),
    firstTradeAt: Math.min(...trades.map((t) => t.openedAt)),
    lastTradeAt: Math.max(...trades.map((t) => t.openedAt)),
  };
}

function botCard(b: MockBot, trades: BotTrade[], now: Ms): BotCard {
  return {
    botId: b.botId,
    name: b.name,
    color: b.color,
    status: 'running',
    config: botConfig(b),
    health: botHealth(now),
    stats: statsOf(trades.filter((t) => t.botId === b.botId)),
    uptimeSince: now - 6 * HOUR,
    restarts24h: b.botId === 'votemax' ? 1 : 0,
    sources: [sourceKey.bot(b.botId, 'health'), sourceKey.bot(b.botId, 'status'), sourceKey.logtail(b.botId)],
  };
}

function holding(asset: string, krakenAsset: string, total: number, hold = 0): KrakenBalanceEntry {
  const priceUsd = PRICES[asset] ?? null;
  return {
    asset,
    krakenAsset,
    wallet: 'spot',
    total,
    hold,
    available: total - hold,
    priceUsd,
    valueUsd: priceUsd === null ? null : total * priceUsd,
  };
}

function mockAccount(now: Ms): AccountSnapshot {
  const holdings = [
    holding('USD', 'ZUSD', 141.06),
    holding('BTC', 'XXBT', 0.00046744),
    holding('ETH', 'XETH', 0.1130240889),
    holding('SHIB', 'SHIB', 1_901_628.18),
  ];
  const totalUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  return {
    source: 'kraken',
    estimatedFromBot: null,
    asOf: now - 12_000,
    totalUsd,
    usdCash: 141.06,
    usdAvailable: 141.06,
    holdings,
    unpricedAssets: [],
  };
}

function mockAllocation(account: AccountSnapshot, trades: BotTrade[]): Allocation {
  const botValue = (botId: string): number =>
    trades.filter((t) => t.botId === botId && t.isOpen).reduce((s, t) => s + t.pnl.openQty * (t.pnl.markPrice ?? 0), 0);
  const value = (asset: string): number => account.holdings.find((h) => h.asset === asset)?.valueUsd ?? 0;
  const dcaQty = trades
    .filter((t) => t.botId === 'dca' && t.isOpen && t.base === 'ETH')
    .reduce((s, t) => s + t.pnl.openQty, 0);
  const ethTotal = account.holdings.find((h) => h.asset === 'ETH')?.total ?? 0;
  const untrackedQty = ethTotal - dcaQty;
  const untrackedUsd = untrackedQty * PRICES.ETH!;
  return {
    totalUsd: account.totalUsd,
    usdCash: account.usdCash,
    botPositions: BOTS.map((b) => ({ botId: b.botId, valueUsd: botValue(b.botId) })),
    acknowledgedUsd: value('SHIB'),
    untrackedUsd,
    dustUsd: 0,
    holdings: [
      {
        asset: 'USD',
        total: account.usdCash,
        valueUsd: account.usdCash,
        byBot: [],
        acknowledgedQty: null,
        ackId: null,
        untrackedQty: 0,
        untrackedUsd: 0,
        status: 'cash',
      },
      {
        asset: 'BTC',
        total: 0.00046744,
        valueUsd: value('BTC'),
        byBot: [{ botId: 'votemax', qty: 0.00046744 }],
        acknowledgedQty: null,
        ackId: null,
        untrackedQty: 0,
        untrackedUsd: 0,
        status: 'bot',
      },
      {
        asset: 'ETH',
        total: ethTotal,
        valueUsd: value('ETH'),
        byBot: [{ botId: 'dca', qty: dcaQty }],
        acknowledgedQty: null,
        ackId: null,
        untrackedQty,
        untrackedUsd,
        status: 'untracked',
      },
      {
        asset: 'SHIB',
        total: 1_901_628.18,
        valueUsd: value('SHIB'),
        byBot: [],
        acknowledgedQty: 1_901_628.18,
        ackId: 1,
        untrackedQty: 0,
        untrackedUsd: 0,
        status: 'manual',
      },
    ],
  };
}

function finding(
  f: Partial<Finding> & Pick<Finding, 'id' | 'rule' | 'fingerprint' | 'severity' | 'title' | 'detail' | 'subject'>,
  now: Ms,
): Finding {
  return {
    status: 'active',
    maxSeverity: f.severity,
    evidence: {},
    firstSeenAt: now - 40 * MIN,
    episodeStartAt: now - 40 * MIN,
    activeSince: now - 39 * MIN,
    lastSeenAt: now - 5_000,
    clearedAt: null,
    resolvedAt: null,
    occurrences: 1,
    flapCount: 0,
    silenced: null,
    notifiedAt: now - 39 * MIN,
    notifiedSeverity: f.severity,
    notifiedEvidenceCount: 0,
    ...f,
  };
}

function mockFindings(now: Ms): Finding[] {
  const orders = [
    { orderId: 'OX2D7A-ROVIF-A3YVZW', at: now - 41 * MIN, price: 3_198.5, stakeUsd: 11.55 },
    { orderId: 'O2EEM4-42O6I-U2U6SJ', at: now - 40 * MIN, price: 3_199.1, stakeUsd: 11.55 },
    { orderId: 'OJ6DEM-PMOHZ-XDLFQB', at: now - 39 * MIN, price: 3_200.2, stakeUsd: 11.55 },
  ];
  return [
    finding(
      {
        id: 1,
        rule: 'UNPERSISTED_ORDER',
        fingerprint: 'UNPERSISTED_ORDER:votemax:ETH/USD',
        severity: 'critical',
        title: '3 orders placed by votemax are missing from its database (ETH/USD)',
        detail: 'The bot log shows orders that the freqtrade API and its trade list do not know about.',
        subject: { botId: 'votemax', pair: 'ETH/USD' },
        evidence: { orders, count: 3, totalStakeUsd: 34.65 },
        evidenceKeys: orders.map((o) => o.orderId),
        occurrences: 1,
        notifiedEvidenceCount: 3,
      },
      now,
    ),
    finding(
      {
        id: 2,
        rule: 'UNTRACKED_HOLDING',
        fingerprint: 'UNTRACKED_HOLDING:ETH',
        severity: 'warning',
        title: 'ETH on Kraken is not owned by any open trade',
        detail: 'About 0.07 ETH (~$226) is held without a matching open position.',
        subject: { asset: 'ETH' },
        evidence: { untrackedQty: 0.07, untrackedUsd: 226.1 },
        evidenceKeys: ['ETH'],
      },
      now,
    ),
    finding(
      {
        id: 3,
        rule: 'FEE_ANOMALY',
        fingerprint: 'FEE_ANOMALY:votemax:3:sell',
        severity: 'info',
        title: 'Exit fee 0.8% on votemax trade 3',
        detail: 'The exit order was charged 0.8%, twice the expected taker fee.',
        subject: { botId: 'votemax', tradeId: 3 },
        evidence: { feeRate: 0.008, expected: 0.004 },
        firstSeenAt: now - 3 * DAY,
        episodeStartAt: now - 3 * DAY,
        activeSince: now - 3 * DAY,
        silenced: { at: now - 2 * DAY, by: 'Demo', note: 'Historic, known', severity: 'info', evidenceCount: 0 },
      },
      now,
    ),
    finding(
      {
        id: 4,
        rule: 'BOT_RESTARTED',
        fingerprint: 'BOT_RESTARTED:votemax',
        severity: 'info',
        title: 'votemax restarted',
        detail: 'One restart was detected in the last 30 minutes.',
        subject: { botId: 'votemax' },
        status: 'resolved',
        firstSeenAt: now - 7 * HOUR,
        episodeStartAt: now - 7 * HOUR,
        activeSince: now - 7 * HOUR,
        lastSeenAt: now - 6 * HOUR,
        clearedAt: now - 6 * HOUR,
        resolvedAt: now - 5 * HOUR,
        notifiedAt: null,
        notifiedSeverity: null,
        notifiedEvidenceCount: null,
      },
      now,
    ),
  ];
}

function lite(f: Finding): FindingLite {
  return {
    id: f.id,
    rule: f.rule,
    severity: f.severity,
    title: f.title,
    subject: f.subject,
    activeSince: f.activeSince,
  };
}

function findingCounts(findings: Finding[]): FindingsResponse['counts'] {
  const active = findings.filter((f) => f.status === 'active' && !f.silenced);
  const count = (s: Finding['severity']): number => active.filter((f) => f.severity === s).length;
  return {
    critical: count('critical'),
    warning: count('warning'),
    info: count('info'),
    silenced: findings.filter((f) => f.status === 'active' && f.silenced).length,
    resolved24h: findings.filter((f) => f.status === 'resolved').length,
  };
}

export function mockSummary(now: Ms = Date.now()): SummaryResponse {
  const findings = mockFindings(now);
  const counts = findingCounts(findings);
  const top = findings.find((f) => f.severity === 'critical' && f.status === 'active');
  return {
    generatedAt: now,
    mode: 'kraken',
    modeReason: null,
    monitor: { startedAt: now - 3 * HOUR, lastCycleAt: now - 4_000, lastEvalAt: now - 6_000, stalled: false },
    findings: {
      critical: counts.critical,
      warning: counts.warning,
      info: counts.info,
      silenced: counts.silenced,
      top: top ? lite(top) : null,
    },
    accountTotalUsd: mockAccount(now).totalUsd,
    accountFreshness: fresh(sourceKey.kraken('balance'), 'Kraken balance', CADENCE_MS['kraken.balance'], now, 12_000),
    killswitch: { mode: 'off', resetAt: null, tripped: null },
    bots: BOTS.map((b) => ({ botId: b.botId, name: b.name, color: b.color, status: 'running' as const })),
  };
}

export function mockOverview(now: Ms = Date.now()): OverviewResponse {
  const trades = mockTrades(now);
  const account = mockAccount(now);
  const cards = BOTS.map((b) => botCard(b, trades, now));
  const stats = cards.flatMap((c) => (c.stats ? [c.stats] : []));
  const total = (pick: (s: BotStats) => number): number => stats.reduce((s, x) => s + pick(x), 0);
  const findings = mockFindings(now);
  const counts = findingCounts(findings);
  return {
    generatedAt: now,
    mode: 'kraken',
    modeReason: null,
    account,
    allocation: mockAllocation(account, trades),
    change24h: { usd: 3.42, pct: 0.0055, netFlowsUsd: 0 },
    walletViews: [
      { botId: 'votemax', usd: 141.06, totalUsd: 622.78, syncedAt: now - 20 * MIN },
      { botId: 'dca', usd: 141.06, totalUsd: 628.02, syncedAt: now - 47 * MIN },
    ],
    bots: cards,
    openPositions: trades.filter((t) => t.isOpen),
    combined: {
      realizedUsd: total((s) => s.realizedUsd),
      unrealizedUsd: total((s) => s.unrealizedUsd),
      totalUsd: total((s) => s.totalUsd),
      openCostBasisUsd: total((s) => s.openCostBasisUsd),
      feesUsd: total((s) => s.feesUsd),
      roiOnStake: total((s) => s.closedCostBasisUsd)
        ? total((s) => s.realizedUsd) / total((s) => s.closedCostBasisUsd)
        : null,
    },
    findings: {
      counts: { critical: counts.critical, warning: counts.warning, info: counts.info },
      top: findings.filter((f) => f.status === 'active' && !f.silenced).map(lite),
    },
    sources: freshnessList(now),
  };
}

function botEvents(botId: string, now: Ms): BotEvent[] {
  return [
    {
      botId,
      at: now - 6 * HOUR,
      type: 'startup',
      source: 'logfile',
      message: 'Logfile configured',
      fingerprint: `${botId}:startup:1`,
    },
    {
      botId,
      at: now - 3 * HOUR,
      type: 'order_created',
      source: 'logfile',
      orderId: 'O6ROFS-APVH7-255LCC',
      pair: 'BTC/USD',
      price: 83_450,
      stakeUsd: 39.01,
      fingerprint: `${botId}:order:1`,
    },
    {
      botId,
      at: now - 2 * HOUR,
      type: 'error',
      source: 'logfile',
      message: 'Unable to fetch ticker (mock)',
      fingerprint: `${botId}:error:1`,
    },
  ];
}

export function mockBotDetail(botId: string, now: Ms = Date.now()): BotDetailResponse | null {
  const bot = BOTS.find((b) => b.botId === botId);
  if (!bot) return null;
  const trades = mockTrades(now).filter((t) => t.botId === botId);
  const closed = trades.filter((t) => !t.isOpen);
  const pairs = [...new Set(trades.map((t) => t.pair))];
  const wallet: FtWalletView = {
    botId,
    fetchedAt: now - 30_000,
    lastWalletSyncAt: now - 20 * MIN,
    totalUsd: 622.78,
    currencies: [
      {
        currency: 'USD',
        balance: 141.06,
        free: 141.06,
        used: 0,
        botOwned: null,
        estStakeUsd: null,
        isBotManaged: true,
      },
    ],
  };
  return {
    generatedAt: now,
    bot: botCard(bot, mockTrades(now), now),
    openTrades: trades.filter((t) => t.isOpen),
    recentClosed: closed,
    perPair: pairs.map((pair) => {
      const forPair = trades.filter((t) => t.pair === pair);
      const done = forPair.filter((t) => !t.isOpen);
      const basis = done.reduce((s, t) => s + t.pnl.costBasisUsd, 0);
      const realized = done.reduce((s, t) => s + t.pnl.realizedUsd, 0);
      return {
        pair,
        closedTrades: done.length,
        realizedUsd: realized,
        roiOnStake: basis ? realized / basis : null,
        openQty: forPair.reduce((s, t) => s + t.pnl.openQty, 0),
      };
    }),
    events: botEvents(botId, now),
    whitelist: ['BTC/USD', 'ETH/USD', 'SHIB/USD'],
    locks: [{ pair: 'SHIB/USD', until: now + 3 * HOUR, reason: 'Trading lock' }],
    wallet,
    sources: freshnessList(now),
  };
}

export interface MockTradesQuery {
  bot?: string | null;
  pair?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}

export function mockTradesResponse(now: Ms = Date.now(), q: MockTradesQuery = {}): TradesResponse {
  const status = q.status ?? 'all';
  const filtered = mockTrades(now).filter(
    (t) =>
      (!q.bot || t.botId === q.bot) &&
      (!q.pair || t.pair === q.pair) &&
      (status === 'all' || (status === 'open') === t.isOpen),
  );
  const page = filtered.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200));
  return {
    generatedAt: now,
    total: filtered.length,
    trades: page.map((t) => ({
      ...t,
      krakenMatch: Object.fromEntries(t.orders.map((o) => [o.orderId, 'matched' as const])),
    })),
    totals: {
      realizedUsd: filtered.reduce((s, t) => s + t.pnl.realizedUsd, 0),
      unrealizedUsd: filtered.reduce((s, t) => s + (t.pnl.unrealizedUsd ?? 0), 0),
      feesUsd: filtered.reduce((s, t) => s + t.pnl.feesUsd, 0),
    },
    sources: freshnessList(now),
  };
}

function krakenOrder(
  o: Partial<KrakenOrder> & Pick<KrakenOrder, 'txid' | 'pair' | 'krakenPair' | 'openedAt' | 'vol' | 'avgPrice'>,
): KrakenOrder {
  const cost = o.vol * (o.avgPrice ?? 0);
  return {
    side: 'buy',
    orderType: 'limit',
    status: 'closed',
    closedAt: o.openedAt + 30_000,
    volExec: o.vol,
    costUsd: cost,
    feeUsd: cost * FEE_RATE,
    limitPrice: o.avgPrice,
    userref: null,
    clOrdId: null,
    reason: null,
    ...o,
  };
}

export function mockAcks(now: Ms = Date.now()): Acknowledgement[] {
  return [
    {
      id: 1,
      kind: 'asset',
      subject: 'SHIB',
      label: 'manual',
      note: 'Bought by hand',
      qtyBaseline: 1_901_628.18,
      createdAt: now - 5 * DAY,
      createdBy: 'Demo',
      expiresAt: null,
      revokedAt: null,
    },
  ];
}

export function mockKrakenOrdersResponse(
  now: Ms = Date.now(),
  q: { match?: string | null; pair?: string | null } = {},
): KrakenOrdersResponse {
  const ack = mockAcks(now)[0] ?? null;
  const all: KrakenOrdersResponse['orders'] = [
    {
      ...krakenOrder({
        txid: 'O6ROFS-APVH7-255LCC',
        pair: 'BTC/USD',
        krakenPair: 'XBTUSD',
        openedAt: now - 3 * HOUR,
        vol: 0.00046744,
        avgPrice: 83_450,
      }),
      match: { botId: 'votemax', tradeId: 8 },
      ack: null,
      createdByBotLog: 'votemax',
    },
    {
      ...krakenOrder({
        txid: 'OWDY2Z-TVWRN-IJBALL',
        pair: 'ETH/USD',
        krakenPair: 'ETHUSD',
        openedAt: now - 38 * MIN,
        vol: 0.0035,
        avgPrice: 3_201,
      }),
      match: null,
      ack: null,
      createdByBotLog: null,
    },
    {
      ...krakenOrder({
        txid: 'OYYVFI-FJISQ-5N6DW5',
        pair: 'SHIB/USD',
        krakenPair: 'SHIBUSD',
        openedAt: now - 5 * DAY,
        vol: 1_901_628.18,
        avgPrice: 0.00001,
      }),
      match: null,
      ack,
      createdByBotLog: null,
    },
  ];
  const wanted = q.match ?? 'all';
  const orders = all.filter(
    (o) =>
      (!q.pair || o.pair === q.pair) &&
      (wanted === 'all' ||
        (wanted === 'matched' && o.match !== null) ||
        (wanted === 'unmatched' && o.match === null && o.ack === null) ||
        (wanted === 'acked' && o.ack !== null)),
  );
  return { generatedAt: now, enabled: true, orders, sources: freshnessList(now) };
}

export function mockFindingsResponse(
  now: Ms = Date.now(),
  q: { status?: string | null; severity?: string | null } = {},
): FindingsResponse {
  const all = mockFindings(now);
  const status = q.status ?? 'active';
  const findings = all.filter(
    (f) =>
      (!q.severity || f.severity === q.severity) &&
      (status === 'all' ||
        (status === 'active' && f.status === 'active' && !f.silenced) ||
        (status === 'silenced' && f.status === 'active' && f.silenced !== null) ||
        (status === 'resolved' && f.status === 'resolved')),
  );
  return {
    generatedAt: now,
    findings,
    counts: findingCounts(all),
    engine: { lastEvalAt: now - 6_000, rules: 22, mode: 'kraken' },
  };
}

/** Finding returned by the silence / unsilence mock handlers. */
export function mockFindingById(id: number, now: Ms = Date.now()): Finding | null {
  return mockFindings(now).find((f) => f.id === id) ?? null;
}

const RANGE_MS: Record<EquityRange, number> = {
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  all: 120 * DAY,
};

export function mockEquityResponse(now: Ms = Date.now(), range: EquityRange = '7d'): EquityResponse {
  const span = RANGE_MS[range];
  const points = Array.from({ length: 60 }, (_, i) => {
    const t = now - span + (span * i) / 59;
    const totalUsd = 600 + 18 * Math.sin(i / 6) + i * 0.15;
    return { t: Math.round(t), totalUsd: Math.round(totalUsd * 100) / 100, usdCash: 141.06, source: 'kraken' as const };
  });
  const first = points[0]?.totalUsd ?? 0;
  const last = points[points.length - 1]?.totalUsd ?? 0;
  const flows: KrakenFlow[] = [
    { ledgerId: 'L4L3SN-OCQLE-XMQEAO', at: now - span / 2, type: 'deposit', asset: 'USD', amount: 100, fee: 0 },
  ];
  return {
    generatedAt: now,
    points,
    flows,
    flowsAvailable: true,
    change: { usd: last - first, pct: first ? (last - first) / first : 0, netFlowsUsd: 100 },
  };
}

export function mockStatusResponse(now: Ms = Date.now()): StatusResponse {
  return {
    generatedAt: now,
    version: APP_VERSION,
    startedAt: now - 3 * HOUR,
    mode: 'kraken',
    modeReason: null,
    kraken: {
      configured: true,
      status: 'ok',
      reason: null,
      permissionDenied: [],
      backfillComplete: true,
      reconStartAt: now - 30 * DAY,
      tier: 'starter',
    },
    sources: freshnessList(now),
    logTails: BOTS.map((b) => ({
      botId: b.botId,
      file: `/ftlogs/${b.botId}.log`,
      configured: true,
      available: true,
      lastLineAt: now - 3_000,
      error: null,
    })),
    notifier: { discord: true, lastSentAt: now - 39 * MIN, lastError: null, consecutiveFailures: 0 },
    db: { sizeBytes: 4_718_592, findings: 4, krakenOrders: 31, equityPoints: 8_640 },
    clockSkewMs: 120,
    killswitch: { mode: 'off', resetAt: null, tripped: null },
  };
}

const TF_SECONDS: Record<string, number> = { '15m': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400 };

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + (out[i - 1] as number) * (1 - k)));
  return out;
}

export function mockChart(botId: string, pair: string, tf: string, limit = 500, now: Ms = Date.now()): ChartData {
  const bot = BOTS.find((b) => b.botId === botId) ?? BOTS[0];
  const tfSec = TF_SECONDS[tf] ?? 14_400;
  const count = Math.min(Math.max(limit, 20), 200);
  const base = PRICES[pair.split('/')[0] ?? ''] ?? 100;
  const lastOpen = Math.floor(now / 1000 / tfSec) * tfSec - tfSec;
  const candles: Candle[] = Array.from({ length: count }, (_, i) => {
    const drift = Math.sin(i / 9) * 0.03 + Math.sin(i / 3) * 0.008;
    const open = base * (1 + drift);
    const close = base * (1 + Math.sin((i + 1) / 9) * 0.03 + Math.sin((i + 1) / 3) * 0.008);
    return {
      time: lastOpen - (count - 1 - i) * tfSec,
      open,
      close,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      volume: 10 + ((i * 7) % 13),
    };
  });
  const closes = candles.map((c) => c.close);
  const line = (values: number[]): SeriesPoint[] =>
    candles.map((c, i) => ({ time: c.time, value: values[i] as number }));
  const rsi = closes.map((_, i) => 50 + 25 * Math.sin(i / 7));
  const strategyTf = tf === '4h';
  const indicators: IndicatorSeries[] = strategyTf
    ? [
        {
          key: 'ema20',
          label: 'EMA 20',
          placement: 'main',
          pane: null,
          kind: 'line',
          color: '#F5A524',
          lineWidth: 1,
          defaultVisible: true,
          points: line(ema(closes, 20)),
        },
        {
          key: 'ema50',
          label: 'EMA 50',
          placement: 'main',
          pane: null,
          kind: 'line',
          color: '#3E63DD',
          lineWidth: 1,
          defaultVisible: true,
          points: line(ema(closes, 50)),
        },
        {
          key: 'rsi',
          label: 'RSI',
          placement: 'pane',
          pane: 'RSI',
          kind: 'line',
          color: '#B38CFF',
          lineWidth: 1,
          defaultVisible: true,
          points: line(rsi),
        },
        {
          key: 'rsi_ob',
          label: 'RSI overbought',
          placement: 'pane',
          pane: 'RSI',
          kind: 'threshold',
          color: '#8A93A6',
          lineWidth: 1,
          defaultVisible: true,
          points: [{ time: candles[0]?.time ?? 0, value: 70 }],
        },
      ]
    : [];
  const signalIdx = [Math.floor(count * 0.4), Math.floor(count * 0.7)];
  const fillTime = candles[count - 1]?.time ?? lastOpen;
  const hasTrade8 = botId === 'votemax' && pair === 'BTC/USD';
  return {
    botId: bot.botId,
    pair,
    timeframe: tf,
    source: strategyTf ? 'freqtrade' : 'kraken',
    strategy: strategyTf ? bot.strategy : null,
    candles,
    indicators,
    signals: strategyTf
      ? signalIdx.map((idx, n) => ({
          time: candles[idx]?.time ?? 0,
          kind: n === 0 ? ('enter' as const) : ('exit' as const),
          tag: null,
          source: 'dataframe' as const,
        }))
      : [],
    fills: hasTrade8
      ? [
          {
            time: fillTime,
            at: fillTime * 1000 + 50_000,
            botId,
            tradeId: 8,
            orderId: 'O6ROFS-APVH7-255LCC',
            side: 'buy',
            isEntry: true,
            price: 83_450,
            qty: 0.00046744,
            costUsd: 39.01,
            tag: 'vote_entry',
            origin: 'bot',
          },
        ]
      : [],
    positions: hasTrade8 ? [{ botId, tradeId: 8, avgPrice: 83_450, qty: 0.00046744 }] : [],
    meta: {
      lastAnalyzedAt: now - 30_000,
      dataStopAt: (lastOpen + tfSec) * 1000,
      liveCandle: !strategyTf,
      signalsNote:
        bot.botId === 'dca'
          ? 'DcaBot marks signals only on the latest candle; earlier markers are those recorded live by freqdash (mock).'
          : null,
    },
    freshness: freshnessList(now).slice(0, 2),
  };
}
