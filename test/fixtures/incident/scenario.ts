// Scenario builder for the 2026-09-28 incident regression (docs/PLAN.md section 8.3).
//
// Yields one CheckInput every 5 s from 03:59:00 to 06:20:00 UTC, simulating what the poller and the log tailer would
// have handed the checks engine. Inputs: the real log timeline (raw/incident/timeline.json), the synthetic Kraken
// private fixtures (ClosedOrders.incident, BalanceEx.before/after, TradeVolume) and the real freqtrade samples.
//
// Poller model (documented so WP8 can be held to it):
//  - health every 10 s, /status every 15 s, /trades and the wallet every 60 s, all on the 5 s grid starting 03:59:00;
//    a poll succeeds iff the bot is reachable at that instant. There is no back-off and no event-triggered refresh, so
//    detection latencies here are conservative.
//  - Kraken: OpenOrders every 15 s, ClosedOrders and BalanceEx every 30 s (same grid).
//  - the log tailer delivers a record at the first 5 s step at or after its timestamp.
// The votemax bot is unreachable within [fatal - 0.3 s, next startup + 2 s] for every fatal record. It never knows any
// order created in the incident; the dca bot is healthy throughout.
import { withPnl } from '@/server/accounting';
import { DEFAULT_CHECK_CONFIG } from '@/server/checks/config';
import type { BotCheckView, CheckInput, KrakenCheckView } from '@/server/checks/types';
import type {
  Acknowledgement,
  Asset,
  BotEvent,
  BotHealth,
  BotTrade,
  FtWalletView,
  KrakenBalanceEntry,
  KrakenOrder,
  Ms,
} from '@/shared/types/domain';
import timelineRaw from '../raw/incident/timeline.json';
import closedOrdersRaw from '../raw/kraken/private/ClosedOrders.incident.json';
import balanceBeforeRaw from '../raw/kraken/private/BalanceEx.before.json';
import balanceAfterRaw from '../raw/kraken/private/BalanceEx.after.json';
import tradeVolumeRaw from '../raw/kraken/private/TradeVolume.json';
import { healthyBot } from './builders';
import { dcaClosedTrades, votemaxClosedTrades } from './ftFixtures';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export const SCENARIO_START = Date.UTC(2026, 8, 28, 3, 59, 0);
export const SCENARIO_END = Date.UTC(2026, 8, 28, 6, 20, 0);
export const SCENARIO_STEP = 5 * SECOND;
export const RECON_START_AT = Date.UTC(2026, 5, 1, 0, 0, 0);

const HEALTH_EVERY = 10 * SECOND;
const STATUS_EVERY = 15 * SECOND;
const SLOW_EVERY = MINUTE;
const OPEN_ORDERS_EVERY = 15 * SECOND;
const KRAKEN_SLOW_EVERY = 30 * SECOND;

const PRICES: Record<Asset, number> = { USD: 1, BTC: 83_400, ETH: 2_649, SHIB: 0.000005645, BABY: 0.01334 };
const PAIR_BY_ALTNAME: Record<string, string> = { XBTUSD: 'BTC/USD', ETHUSD: 'ETH/USD', SHIBUSD: 'SHIB/USD' };
const KRAKEN_ASSET: Record<Asset, string> = { USD: 'ZUSD', BTC: 'XXBT', ETH: 'XETH', SHIB: 'SHIB', BABY: 'BABY' };
const BOT_INITIAL_STARTUP = Date.UTC(2026, 8, 28, 0, 0, 0);
const BOT_FIRST_START = 1_775_330_841_000;

// ---------------------------------------------------------------------------------------------------------------------
// Fixture loading

interface RawTimelineEvent {
  type: string;
  at: number;
  pair?: string;
  price?: number;
  stakeUsd?: number;
  orderId?: string;
  message?: string;
}

interface RawClosedOrder {
  status: string;
  reason: string | null;
  opentm: number;
  closetm: number;
  userref: number;
  descr: { pair: string; type: string; ordertype: string; price: string };
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
}

type RawBalances = Record<string, { balance: string }>;

const timeline = (timelineRaw as { events: RawTimelineEvent[] }).events;
const closedOrders = (closedOrdersRaw as unknown as { result: { closed: Record<string, RawClosedOrder> } }).result
  .closed;
const balanceBefore = (balanceBeforeRaw as { result: RawBalances }).result;
const balanceAfter = (balanceAfterRaw as { result: RawBalances }).result;
const tradeVolume = (
  tradeVolumeRaw as { result: { fees: Record<string, { fee: string }>; fees_maker: Record<string, { fee: string }> } }
).result;

export function toKrakenOrder(txid: string, o: RawClosedOrder): KrakenOrder {
  const avg = Number(o.price);
  const limit = Number(o.descr.price);
  return {
    txid,
    pair: PAIR_BY_ALTNAME[o.descr.pair] ?? null,
    krakenPair: o.descr.pair,
    side: o.descr.type === 'sell' ? 'sell' : 'buy',
    orderType: o.descr.ordertype,
    status: o.status === 'canceled' || o.status === 'expired' ? o.status : 'closed',
    openedAt: Math.round(o.opentm * 1000),
    closedAt: Math.round(o.closetm * 1000),
    vol: Number(o.vol),
    volExec: Number(o.vol_exec),
    costUsd: Number(o.cost),
    feeUsd: Number(o.fee),
    avgPrice: avg > 0 ? avg : null,
    limitPrice: limit > 0 ? limit : null,
    userref: o.userref === 0 ? null : o.userref,
    clOrdId: null,
    reason: o.reason,
  };
}

const ALL_ORDERS: KrakenOrder[] = Object.entries(closedOrders)
  .map(([txid, o]) => toKrakenOrder(txid, o))
  .sort((a, b) => a.openedAt - b.openedAt);

const LOGGED_TXIDS = timeline.filter((e) => e.type === 'order_created' && e.orderId).map((e) => e.orderId as string);
/** The Kraken-only order that closes the 0.0043 ETH gap (no log line, PLAN F12). */
export const SYNTHETIC_ORPHAN_TXID = 'OWDY2Z-TVWRN-IJBALL';
export const INCIDENT_TXIDS: readonly string[] = [...LOGGED_TXIDS, SYNTHETIC_ORPHAN_TXID];
const INCIDENT_SET = new Set(INCIDENT_TXIDS);
export const MANUAL_SHIB_TXID = 'OYYVFI-FJISQ-5N6DW5';
export const ZERO_FILL_TXID = 'O5GCGD-X5FJN-JFUFDO';

export const KRAKEN_ORDERS: readonly KrakenOrder[] = ALL_ORDERS;
export const LOG_TIMELINE: readonly RawTimelineEvent[] = timeline;
export const SHIB_QTY = Number(balanceAfter['SHIB']!.balance);
export const ETH_FINAL_QTY = Number(balanceAfter['XETH']!.balance);

const TRADE_VOLUME_PAIR: Record<string, string> = { XXBTZUSD: 'BTC/USD', XETHZUSD: 'ETH/USD' };

/** TradeVolume percentages as fractions, keyed by pair. */
export const FEE_TIER: Record<string, { taker: number; maker: number }> = Object.fromEntries(
  Object.entries(tradeVolume.fees).map(([key, v]) => [
    TRADE_VOLUME_PAIR[key] ?? key,
    { taker: Number(v.fee) / 100, maker: Number(tradeVolume.fees_maker[key]?.fee ?? v.fee) / 100 },
  ]),
);

function logEvents(): BotEvent[] {
  const out: BotEvent[] = [];
  for (const e of timeline) {
    if (e.type === 'entry_signal') continue;
    const event: BotEvent = {
      botId: 'votemax',
      at: e.at,
      type: e.type as BotEvent['type'],
      source: 'logfile',
      fingerprint: `votemax:${e.type}:${e.at}:${e.orderId ?? ''}`,
    };
    if (e.orderId) event.orderId = e.orderId;
    if (e.pair) event.pair = e.pair;
    if (e.price !== undefined) event.price = e.price;
    if (e.stakeUsd !== undefined) event.stakeUsd = e.stakeUsd;
    if (e.message) event.message = e.message;
    out.push(event);
  }
  return out;
}

/** Windows during which votemax does not answer: [fatal - 0.3 s, next startup + 2 s]. */
function outageWindows(): [Ms, Ms][] {
  const startups = timeline
    .filter((e) => e.type === 'startup')
    .map((e) => e.at)
    .sort((a, b) => a - b);
  const windows: [Ms, Ms][] = [];
  for (const f of timeline.filter((e) => e.type === 'fatal')) {
    const next = startups.find((s) => s > f.at);
    windows.push([f.at - 300, (next ?? f.at + 10 * SECOND) + 2 * SECOND]);
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kraken account model

interface Account {
  usd: number;
  eth: number;
}

function accountAt(t: Ms): Account {
  let usd = Number(balanceBefore['ZUSD']!.balance);
  let eth = Number(balanceBefore['XETH']!.balance);
  for (const o of ALL_ORDERS) {
    if (!INCIDENT_SET.has(o.txid) || o.closedAt === null || o.closedAt > t) continue;
    usd -= o.costUsd + o.feeUsd;
    eth += o.volExec;
  }
  return { usd, eth };
}

function balancesAt(t: Ms): KrakenBalanceEntry[] {
  const { usd, eth } = accountAt(t);
  const qty: Record<Asset, number> = {
    USD: usd,
    ETH: eth,
    SHIB: SHIB_QTY,
    BABY: Number(balanceAfter['BABY']!.balance),
  };
  return Object.entries(qty).map(([asset, total]) => ({
    asset,
    krakenAsset: KRAKEN_ASSET[asset] ?? asset,
    wallet: 'spot' as const,
    total,
    hold: 0,
    available: total,
    priceUsd: PRICES[asset] ?? null,
    valueUsd: total * (PRICES[asset] ?? 0),
  }));
}

function walletAt(botId: string, syncAt: Ms): FtWalletView {
  const currencies = balancesAt(syncAt).map((b) => ({
    currency: b.asset,
    balance: b.total,
    free: b.total,
    used: 0,
    botOwned: 0,
    estStakeUsd: b.valueUsd,
    isBotManaged: b.asset === 'USD',
  }));
  return {
    botId,
    fetchedAt: syncAt,
    lastWalletSyncAt: syncAt,
    currencies,
    totalUsd: currencies.reduce((s, c) => s + (c.estStakeUsd ?? 0), 0),
  };
}

const onTick = (t: Ms, every: Ms): boolean => (t - SCENARIO_START) % every === 0;
const lastTick = (t: Ms, every: Ms): Ms => t - ((t - SCENARIO_START) % every);

// ---------------------------------------------------------------------------------------------------------------------
// Simulation

export interface ScenarioOptions {
  /** Kraken key configured: KrakenCheckView present. False = freqtrade-only mode. */
  withKraken: boolean;
  /** Log files are tailed: log events reach the engine. False = health-derived startup events only. */
  withLogs: boolean;
  /**
   * From this time on, the operator has acknowledged every incident order (kraken_order acks) and the ETH holding
   * (asset ack with the current quantity as baseline). Null = never.
   */
  ackAt?: Ms | null;
  /** Last input time (default 06:20:00). Extend it to watch the delayed resolved notices go out. */
  endAt?: Ms;
}

interface BotSim {
  botId: string;
  health: BotHealth;
  firstFailureAt: Ms | null;
  lastStatusOkAt: Ms | null;
  lastTradesOkAt: Ms | null;
  wallet: FtWalletView | null;
  lastWalletSyncAt: Ms | null;
  startupSeen: Ms;
}

function closedTradesOf(bot: 'votemax' | 'dca'): BotTrade[] {
  return (bot === 'votemax' ? votemaxClosedTrades() : dcaClosedTrades()).map((t) => withPnl(t, null));
}

export class IncidentScenario {
  private readonly logs: BotEvent[];
  private readonly outages: [Ms, Ms][];
  private readonly startups: number[];
  private readonly healthEvents: BotEvent[] = [];
  private readonly bots: Record<'votemax' | 'dca', BotSim>;
  private readonly closed = { votemax: closedTradesOf('votemax'), dca: closedTradesOf('dca') };
  private readonly known: CheckInput['knownOrders'];

  constructor(private readonly opts: ScenarioOptions) {
    this.logs = opts.withLogs ? logEvents() : [];
    this.outages = outageWindows();
    this.startups = timeline
      .filter((e) => e.type === 'startup')
      .map((e) => e.at)
      .sort((a, b) => a - b);
    const mk = (botId: 'votemax' | 'dca'): BotSim => ({
      botId,
      health: {
        reachable: true,
        authFailed: false,
        lastProcessAt: null,
        botStartAt: BOT_FIRST_START,
        botStartupAt: BOT_INITIAL_STARTUP,
        unreachableSince: null,
      },
      firstFailureAt: null,
      lastStatusOkAt: null,
      lastTradesOkAt: null,
      wallet: null,
      lastWalletSyncAt: null,
      startupSeen: BOT_INITIAL_STARTUP,
    });
    this.bots = { votemax: mk('votemax'), dca: mk('dca') };
    this.known = {};
    for (const bot of ['votemax', 'dca'] as const) {
      for (const trade of this.closed[bot])
        for (const o of trade.orders) this.known[o.orderId] = { botId: bot, tradeId: trade.tradeId };
    }
  }

  private reachable(botId: string, t: Ms): boolean {
    return botId !== 'votemax' || !this.outages.some(([from, to]) => t >= from && t <= to);
  }

  /** botStartupAt as the API reports it: the last process start, second resolution, the API is up ~1.5 s later. */
  private startupAt(botId: string, t: Ms): Ms {
    if (botId !== 'votemax') return BOT_INITIAL_STARTUP;
    let last = BOT_INITIAL_STARTUP;
    for (const s of this.startups) if (s <= t) last = Math.floor((s + 1500) / 1000) * 1000;
    return last;
  }

  private poll(sim: BotSim, t: Ms): void {
    const up = this.reachable(sim.botId, t);
    if (onTick(t, HEALTH_EVERY)) {
      if (up) {
        const startupAt = this.startupAt(sim.botId, t);
        if (startupAt !== sim.startupSeen) {
          this.healthEvents.push({
            botId: sim.botId,
            at: startupAt,
            type: 'startup',
            source: 'health',
            fingerprint: `${sim.botId}:health-startup:${startupAt}`,
          });
          sim.startupSeen = startupAt;
        }
        sim.health = {
          ...sim.health,
          reachable: true,
          lastProcessAt: t - 2 * SECOND,
          botStartupAt: startupAt,
          unreachableSince: null,
        };
        sim.firstFailureAt = null;
      } else {
        sim.firstFailureAt ??= t;
        sim.health = { ...sim.health, reachable: false, unreachableSince: sim.firstFailureAt };
      }
    }
    if (up && onTick(t, STATUS_EVERY)) sim.lastStatusOkAt = t;
    if (up && onTick(t, SLOW_EVERY)) {
      sim.lastTradesOkAt = t;
      sim.wallet = walletAt(sim.botId, t);
      sim.lastWalletSyncAt = t;
    }
  }

  private krakenAt(t: Ms): KrakenCheckView {
    const pOpen = lastTick(t, OPEN_ORDERS_EVERY);
    const pSlow = lastTick(t, KRAKEN_SLOW_EVERY);
    const closed = ALL_ORDERS.filter((o) => o.closedAt !== null && o.closedAt <= pSlow && o.openedAt >= RECON_START_AT);
    const open = ALL_ORDERS.filter(
      (o) => o.openedAt <= pOpen && (o.closedAt ?? Infinity) > pOpen && o.openedAt >= RECON_START_AT,
    ).map((o): KrakenOrder => ({
      ...o,
      status: 'open',
      closedAt: null,
      volExec: 0,
      costUsd: 0,
      feeUsd: 0,
      avgPrice: null,
    }));
    return {
      balances: balancesAt(pSlow),
      balancesAt: pSlow,
      openOrders: open,
      openOrdersAt: pOpen,
      orders: [...closed, ...open],
      backfillComplete: true,
      feeTier: FEE_TIER,
      errors: [],
      permissionDenied: [],
    };
  }

  private acksAt(t: Ms): Acknowledgement[] {
    const acks: Acknowledgement[] = [
      {
        id: 1,
        kind: 'asset',
        subject: 'SHIB',
        label: 'manual',
        note: 'bought by hand',
        qtyBaseline: SHIB_QTY,
        createdAt: RECON_START_AT,
        createdBy: 'test',
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: 2,
        kind: 'kraken_order',
        subject: MANUAL_SHIB_TXID,
        label: 'manual',
        note: 'manual SHIB buy',
        qtyBaseline: null,
        createdAt: RECON_START_AT,
        createdBy: 'test',
        expiresAt: null,
        revokedAt: null,
      },
    ];
    const ackAt = this.opts.ackAt ?? null;
    if (ackAt !== null && t >= ackAt) {
      INCIDENT_TXIDS.forEach((txid, i) => {
        acks.push({
          id: 100 + i,
          kind: 'kraken_order',
          subject: txid,
          label: 'manual',
          note: 'incident 2026-09-28',
          qtyBaseline: null,
          createdAt: ackAt,
          createdBy: 'test',
          expiresAt: null,
          revokedAt: null,
        });
      });
      acks.push({
        id: 200,
        kind: 'asset',
        subject: 'ETH',
        label: 'manual',
        note: 'incident 2026-09-28',
        qtyBaseline: ETH_FINAL_QTY,
        createdAt: ackAt,
        createdBy: 'test',
        expiresAt: null,
        revokedAt: null,
      });
    }
    return acks;
  }

  private botView(sim: BotSim, t: Ms): BotCheckView {
    const view = healthyBot(sim.botId, t);
    const closedTrades = this.closed[sim.botId as 'votemax' | 'dca'];
    return {
      ...view,
      health: sim.health,
      firstFailureAt: sim.firstFailureAt,
      lastStatusOkAt: sim.lastStatusOkAt,
      lastTradesOkAt: sim.lastTradesOkAt,
      closedTrades,
      openTrades: [],
      wallet: sim.wallet,
      logTail: {
        configured: this.opts.withLogs,
        file: this.opts.withLogs ? `/ftlogs/${sim.botId}.log` : null,
        available: this.opts.withLogs,
        lastLineAt: this.opts.withLogs ? lastTick(t, SLOW_EVERY) : null,
        lastWalletSyncAt: sim.lastWalletSyncAt,
        lastHeartbeatAt: this.opts.withLogs ? lastTick(t, SLOW_EVERY) : null,
        error: null,
      },
    };
  }

  /** The engine input at `t`. Call with strictly increasing t on the 5 s grid. */
  at(t: Ms): CheckInput {
    for (const sim of Object.values(this.bots)) this.poll(sim, t);
    const events = [...this.logs, ...this.healthEvents]
      .filter(
        (e) => e.at <= t && (t - e.at <= 2 * 60 * MINUTE || e.type === 'order_created' || e.type === 'order_canceled'),
      )
      .sort((a, b) => a.at - b.at);
    return {
      now: t,
      cfg: DEFAULT_CHECK_CONFIG,
      reconStartAt: RECON_START_AT,
      bots: [this.botView(this.bots.votemax, t), this.botView(this.bots.dca, t)],
      kraken: this.opts.withKraken ? this.krakenAt(t) : null,
      prices: PRICES,
      knownOrders: this.known,
      events,
      acks: this.acksAt(t),
      clockSkewMs: 120,
      notifierFailures: 0,
    };
  }
}

/** One CheckInput every 5 s from 03:59:00 to 06:20:00 UTC (1693 inputs). */
export function* incidentInputs(opts: ScenarioOptions): Generator<CheckInput> {
  const sim = new IncidentScenario(opts);
  const end = opts.endAt ?? SCENARIO_END;
  for (let t = SCENARIO_START; t <= end; t += SCENARIO_STEP) yield sim.at(t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Variant D: flapping health, no logs, no Kraken

export type FlapKind = 'alternating' | 'outages';

/**
 * `alternating`: health fails and recovers every 10 s for 10 minutes.
 * `outages`: six 45 s outages, one every 5 minutes.
 * The dca bot is healthy throughout; both are sampled every 10 s and the engine runs every 5 s.
 */
export function* flappingInputs(kind: FlapKind): Generator<CheckInput> {
  const t0 = SCENARIO_START;
  const end = t0 + (kind === 'alternating' ? 10 * MINUTE : 35 * MINUTE);
  const down = (t: Ms): boolean => {
    const s = t - t0;
    if (kind === 'alternating') return Math.floor(s / HEALTH_EVERY) % 2 === 1;
    return s % (5 * MINUTE) < 45 * SECOND && s < 30 * MINUTE;
  };
  let health: BotHealth = {
    reachable: true,
    authFailed: false,
    lastProcessAt: t0,
    botStartAt: BOT_FIRST_START,
    botStartupAt: BOT_INITIAL_STARTUP,
    unreachableSince: null,
  };
  let firstFailureAt: Ms | null = null;
  for (let t = t0; t <= end; t += SCENARIO_STEP) {
    if (onTick(t, HEALTH_EVERY)) {
      if (down(t)) {
        firstFailureAt ??= t;
        health = { ...health, reachable: false, unreachableSince: firstFailureAt };
      } else {
        firstFailureAt = null;
        health = { ...health, reachable: true, lastProcessAt: t - 2 * SECOND, unreachableSince: null };
      }
    }
    const votemax = { ...healthyBot('votemax', t), health, firstFailureAt, closedTrades: [], openTrades: [] };
    yield {
      now: t,
      cfg: DEFAULT_CHECK_CONFIG,
      reconStartAt: RECON_START_AT,
      bots: [votemax, healthyBot('dca', t)],
      kraken: null,
      prices: PRICES,
      knownOrders: {},
      events: [],
      acks: [],
      clockSkewMs: null,
      notifierFailures: 0,
    };
  }
}
