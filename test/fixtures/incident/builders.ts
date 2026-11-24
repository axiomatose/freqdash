// Small builders for domain objects, shared by the accounting and rule tests. Every builder takes overrides.
import { withPnl } from '@/server/accounting';
import { DEFAULT_CHECK_CONFIG } from '@/server/checks/config';
import type { BotCheckView, CheckInput, KrakenCheckView } from '@/server/checks/types';
import type {
  Acknowledgement,
  BotEvent,
  BotOrder,
  BotTrade,
  BotTradeBase,
  KrakenBalanceEntry,
  KrakenOrder,
} from '@/shared/types/domain';

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** 2026-09-28 04:00:00 UTC, the moment the incident starts (give or take 8 s). */
export const T0 = Date.UTC(2026, 8, 28, 4, 0, 0);

export function botOrder(over: Partial<BotOrder> = {}): BotOrder {
  return {
    botId: 'votemax',
    tradeId: 1,
    orderId: 'OORUYZ-2BWGK-SAYX6T',
    pair: 'ETH/USD',
    side: 'buy',
    isEntry: true,
    tag: null,
    status: 'closed',
    orderType: 'limit',
    amount: 0.01,
    filled: 0.01,
    remaining: 0,
    price: 2600,
    cost: 26,
    placedAt: T0 - HOUR,
    filledAt: T0 - HOUR + 10 * SEC,
    isOpen: false,
    ...over,
  };
}

export function baseTrade(over: Partial<BotTradeBase> = {}): BotTradeBase {
  const orders = over.orders ?? [botOrder()];
  return {
    botId: 'votemax',
    tradeId: 1,
    key: 'votemax:1',
    pair: 'ETH/USD',
    base: 'ETH',
    quote: 'USD',
    isOpen: true,
    strategy: 'VoteMaxMulti',
    enterTag: null,
    exitReason: null,
    amount: 0.01,
    stakeAmount: 26,
    maxStakeAmount: 26,
    openRate: 2600,
    closeRate: null,
    botCurrentRate: 2610,
    openedAt: T0 - HOUR,
    openFilledAt: T0 - HOUR + 10 * SEC,
    closedAt: null,
    feeOpenRate: 0.004,
    feeOpenCost: null,
    feeCloseRate: 0.004,
    feeCloseCost: null,
    entries: 1,
    exits: 0,
    hasOpenOrders: false,
    ftProfitAbs: null,
    ...over,
    orders,
  };
}

/** An open trade holding `qty` of `base`, marked at `mark`. */
export function openTrade(
  botId: string,
  base: string,
  qty: number,
  mark = 100,
  over: Partial<BotTradeBase> = {},
): BotTrade {
  const id = over.tradeId ?? 1;
  const orderId = `O${base.slice(0, 5).padEnd(5, 'X')}-${botId.slice(0, 5).padEnd(5, 'X').toUpperCase()}-${String(id).padStart(6, '0')}`;
  return withPnl(
    baseTrade({
      botId,
      tradeId: id,
      key: `${botId}:${id}`,
      pair: `${base}/USD`,
      base,
      amount: qty,
      openRate: mark,
      orders: [
        botOrder({
          botId,
          tradeId: id,
          orderId,
          pair: `${base}/USD`,
          filled: qty,
          amount: qty,
          price: mark,
          cost: qty * mark,
        }),
      ],
      ...over,
    }),
    { price: mark, source: 'kraken' },
  );
}

export function krakenOrder(over: Partial<KrakenOrder> = {}): KrakenOrder {
  return {
    txid: 'OCRD7C-H4YUJ-WY3ODU',
    pair: 'ETH/USD',
    krakenPair: 'ETHUSD',
    side: 'buy',
    orderType: 'limit',
    status: 'closed',
    openedAt: T0 - HOUR,
    closedAt: T0 - HOUR + 30 * SEC,
    vol: 0.01,
    volExec: 0.01,
    costUsd: 26,
    feeUsd: 0.104,
    avgPrice: 2600,
    limitPrice: 2600,
    userref: null,
    clOrdId: null,
    reason: null,
    ...over,
  };
}

export function balance(
  asset: string,
  total: number,
  priceUsd: number | null,
  over: Partial<KrakenBalanceEntry> = {},
): KrakenBalanceEntry {
  return {
    asset,
    krakenAsset: asset,
    wallet: 'spot',
    total,
    hold: 0,
    available: total,
    priceUsd,
    valueUsd: priceUsd === null ? null : total * priceUsd,
    ...over,
  };
}

export function healthyBot(botId = 'votemax', now = T0, over: Partial<BotCheckView> = {}): BotCheckView {
  return {
    botId,
    name: botId,
    firstFailureAt: null,
    lastStatusOkAt: now - 5 * SEC,
    lastTradesOkAt: now - 5 * SEC,
    health: {
      reachable: true,
      authFailed: false,
      lastProcessAt: now - 3 * SEC,
      botStartAt: now - 30 * DAY,
      botStartupAt: now - DAY,
      unreachableSince: null,
    },
    config: {
      botId,
      botName: botId,
      strategy: 'S',
      timeframe: '4h',
      timeframeMs: 4 * HOUR,
      stakeCurrency: 'USD',
      maxOpenTrades: 2,
      dryRun: false,
      tradingMode: 'spot',
      state: 'running',
      runmode: 'live',
      version: '2026.8',
      positionAdjustment: false,
      exchange: 'kraken',
    },
    openTrades: [],
    closedTrades: [],
    wallet: null,
    whitelist: ['BTC/USD', 'ETH/USD'],
    logTail: {
      configured: true,
      file: `/ftlogs/${botId}.log`,
      available: true,
      lastLineAt: now - 20 * SEC,
      lastWalletSyncAt: null,
      lastHeartbeatAt: now - 20 * SEC,
      error: null,
    },
    ...over,
  };
}

export function krakenView(over: Partial<KrakenCheckView> = {}, now = T0): KrakenCheckView {
  return {
    balances: [balance('USD', 500, 1)],
    balancesAt: now - 10 * SEC,
    openOrders: [],
    openOrdersAt: now - 5 * SEC,
    orders: [],
    backfillComplete: true,
    feeTier: null,
    errors: [],
    permissionDenied: [],
    ...over,
  };
}

export function event(over: Partial<BotEvent> = {}): BotEvent {
  const at = over.at ?? T0;
  const type = over.type ?? 'startup';
  return {
    botId: 'votemax',
    at,
    type,
    source: 'logfile',
    fingerprint: `${over.botId ?? 'votemax'}:${type}:${at}:${over.orderId ?? ''}`,
    ...over,
  };
}

export function ack(over: Partial<Acknowledgement> = {}): Acknowledgement {
  return {
    id: 1,
    kind: 'asset',
    subject: 'SHIB',
    label: 'manual',
    note: null,
    qtyBaseline: null,
    createdAt: T0 - DAY,
    createdBy: null,
    expiresAt: null,
    revokedAt: null,
    ...over,
  };
}

export function input(over: Partial<CheckInput> = {}): CheckInput {
  const now = over.now ?? T0;
  return {
    now,
    cfg: DEFAULT_CHECK_CONFIG,
    reconStartAt: now - 30 * DAY,
    bots: [],
    kraken: null,
    prices: { USD: 1 },
    knownOrders: {},
    events: [],
    acks: [],
    clockSkewMs: null,
    notifierFailures: 0,
    ...over,
  };
}
