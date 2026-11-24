import { CADENCE_MS, sourceKey } from '@/shared/constants';
import type { Ms, SourceKey } from '@/shared/types/domain';
import {
  getMeta,
  getMetaNumber,
  listKrakenOrders,
  setMeta,
  upsertFlows,
  upsertKrakenOrders,
  upsertLedgerEntries,
} from '../../db';
import { isKrakenError } from '../../kraken/errors';
import {
  flowsOf,
  normalizeBalance,
  normalizeBalanceEx,
  normalizeOrders,
  normalizeTradeVolume,
} from '../../kraken/normalize';
import { queryOrdersByTxid, syncClosedOrders, syncLedgerEntries } from '../../kraken/sync';
import type { KrakenCaller } from '../../kraken/types';
import { describeError } from '../../log';
import type { PollerContext } from '../context';

// Kraken private polling (read-only). Cadences and costs: docs/PLAN.md section 6.3. Every job throws on failure so the
// scheduler backs off; the outcome is also recorded on the source and in `state.kraken.errors`.

/** Endpoints whose failure degrades the mode; Ledgers and TradeVolume are optional. */
const REQUIRED = new Set(['Balance', 'BalanceEx', 'OpenOrders', 'ClosedOrders']);

export const BACKFILL_DONE_KEY = 'kraken_backfill_complete';
export const CLOSED_CURSOR_KEY = 'kraken_closed_cursor_sec';
export const LEDGER_CURSOR_KEY = 'kraken_ledger_cursor_sec';
/** The reconciliation start a finished ledger backfill began at; an earlier start means history is missing again. */
export const LEDGER_BACKFILL_FROM_KEY = 'kraken_ledger_backfill_from_sec';

function client(ctx: PollerContext): KrakenCaller {
  if (ctx.kraken === null) throw new Error('Kraken is not configured');
  return ctx.kraken;
}

export function updateKrakenStatus(ctx: PollerContext): void {
  ctx.store.update((s) => {
    const k = s.kraken;
    if (ctx.kraken === null) {
      k.status = 'disabled';
      k.statusReason = 'No Kraken API key is configured';
      return;
    }
    const auth = k.errors.find((e) => e.kind === 'auth');
    const required =
      k.errors.find((e) => REQUIRED.has(e.endpoint) && e.kind !== 'permission') ??
      k.errors.find((e) => REQUIRED.has(e.endpoint));
    if (auth !== undefined) {
      k.status = 'error';
      k.statusReason = auth.message;
    } else if (required !== undefined) {
      k.status = 'degraded';
      k.statusReason = required.message;
    } else {
      k.status = 'ok';
      k.statusReason = null;
    }
  });
}

function noteSuccess(ctx: PollerContext, endpoints: readonly string[]): void {
  ctx.store.update((s) => {
    s.kraken.errors = s.kraken.errors.filter((e) => !endpoints.includes(e.endpoint));
    s.kraken.permissionDenied = s.kraken.permissionDenied.filter((e) => !endpoints.includes(e));
  });
  updateKrakenStatus(ctx);
}

function noteFailure(ctx: PollerContext, endpoint: string, err: unknown): void {
  const at = ctx.now();
  const kind = isKrakenError(err) ? err.kind : 'network';
  const message = describeError(err).slice(0, 300);
  ctx.store.update((s) => {
    const prev = s.kraken.errors.find((e) => e.endpoint === endpoint && e.kind === kind);
    s.kraken.errors = s.kraken.errors.filter((e) => e.endpoint !== endpoint);
    s.kraken.errors.push({ kind, endpoint, since: prev?.since ?? at, message });
    if (kind === 'permission' && !s.kraken.permissionDenied.includes(endpoint))
      s.kraken.permissionDenied.push(endpoint);
  });
  updateKrakenStatus(ctx);
  ctx.store.requestRecheck();
}

async function run(
  ctx: PollerContext,
  key: SourceKey,
  label: string,
  cadence: Ms,
  endpoint: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await ctx.ensureCatalog();
    await body();
    ctx.recordOk(key, label, cadence);
  } catch (err) {
    noteFailure(ctx, isKrakenError(err) && err.endpoint !== null ? err.endpoint : endpoint, err);
    ctx.recordFail(key, label, cadence, err);
    throw err;
  } finally {
    ctx.touchCycle();
  }
}

export function openOrdersJob(ctx: PollerContext): Promise<void> {
  return run(
    ctx,
    sourceKey.kraken('openOrders'),
    'Kraken open orders',
    CADENCE_MS['kraken.openOrders'],
    'OpenOrders',
    async () => {
      const raw = await client(ctx).call('OpenOrders');
      const orders = normalizeOrders(raw, ctx.catalog, { prices: ctx.store.get().market.prices });
      const at = ctx.now();
      ctx.store.update((s) => {
        s.kraken.openOrders = orders;
        s.kraken.openOrdersAt = at;
      });
      noteSuccess(ctx, ['OpenOrders']);
      ctx.store.requestRecheck();
    },
  );
}

export function balanceJob(ctx: PollerContext): Promise<void> {
  return run(
    ctx,
    sourceKey.kraken('balance'),
    'Kraken balances',
    CADENCE_MS['kraken.balance'],
    'BalanceEx',
    async () => {
      const prices = ctx.store.get().market.prices;
      let balances;
      try {
        balances = normalizeBalanceEx(await client(ctx).call('BalanceEx'), ctx.catalog, prices);
        noteSuccess(ctx, ['BalanceEx', 'Balance']);
      } catch (err) {
        if (!isKrakenError(err) || err.kind !== 'permission') throw err;
        // A key without access to BalanceEx can still read Balance (no holds, same totals).
        noteFailure(ctx, 'BalanceEx', err);
        balances = normalizeBalance(await client(ctx).call('Balance'), ctx.catalog, prices);
        ctx.store.update((s) => {
          s.kraken.errors = s.kraken.errors.filter((e) => e.endpoint !== 'Balance');
        });
      }
      const at = ctx.now();
      ctx.store.update((s) => {
        s.kraken.balances = balances;
        s.kraken.balancesAt = at;
      });
      updateKrakenStatus(ctx);
      ctx.recompute();
      ctx.store.requestRecheck();
    },
  );
}

export function closedOrdersJob(ctx: PollerContext): Promise<void> {
  return run(
    ctx,
    sourceKey.kraken('closedOrders'),
    'Kraken closed orders',
    CADENCE_MS['kraken.closedOrders'],
    'ClosedOrders',
    async () => {
      const result = await syncClosedOrders(client(ctx), {
        reconStartSec: Math.floor(ctx.reconStartAt / 1000),
        cursorSec: getMetaNumber(CLOSED_CURSOR_KEY),
        backfillComplete: getMeta(BACKFILL_DONE_KEY) === '1',
        catalog: ctx.catalog,
        normalize: { prices: ctx.store.get().market.prices },
      });
      const now = ctx.now();
      upsertKrakenOrders(result.orders, now);
      setMeta(CLOSED_CURSOR_KEY, result.cursorSec);
      if (result.complete) setMeta(BACKFILL_DONE_KEY, '1');
      ctx.store.update((s) => {
        s.kraken.backfillComplete = getMeta(BACKFILL_DONE_KEY) === '1';
      });
      noteSuccess(ctx, ['ClosedOrders']);
      enqueueMissingBotOrders(ctx);
      ctx.store.requestRecheck();
    },
  );
}

const queried = new Set<string>();

/** Bot orders that Kraken's list does not contain (yet): ask Kraken about each one, once. */
export function enqueueMissingBotOrders(ctx: PollerContext): void {
  const now = ctx.now();
  const known = new Set(listKrakenOrders({ since: ctx.reconStartAt - 3_600_000 }).map((o) => o.txid));
  for (const o of ctx.store.get().kraken.openOrders ?? []) known.add(o.txid);
  for (const bot of Object.values(ctx.store.get().bots)) {
    for (const trade of [...bot.openTrades, ...bot.closedTrades]) {
      for (const o of trade.orders) {
        if (o.filled <= 0 || o.placedAt === null || o.placedAt < ctx.reconStartAt || o.placedAt > now - 10 * 60_000)
          continue;
        if (known.has(o.orderId) || queried.has(o.orderId)) continue;
        ctx.queryQueue.add(o.orderId);
      }
    }
  }
}

export function queryOrdersJob(ctx: PollerContext): Promise<void> {
  return run(
    ctx,
    'kraken:queryOrders',
    'Kraken order lookup',
    CADENCE_MS['kraken.closedOrders'] * 2,
    'QueryOrders',
    async () => {
      const txids = [...ctx.queryQueue].slice(0, 50);
      if (txids.length === 0) return;
      const orders = await queryOrdersByTxid(client(ctx), txids, ctx.catalog, {
        prices: ctx.store.get().market.prices,
      });
      upsertKrakenOrders(orders, ctx.now());
      for (const id of txids) {
        ctx.queryQueue.delete(id);
        queried.add(id);
      }
      noteSuccess(ctx, ['QueryOrders']);
      ctx.store.requestRecheck();
    },
  );
}

export function tradeVolumeJob(ctx: PollerContext): Promise<void> {
  return run(
    ctx,
    sourceKey.kraken('tradeVolume'),
    'Kraken fee tier',
    CADENCE_MS['kraken.tradeVolume'],
    'TradeVolume',
    async () => {
      const bases = new Set<string>(['BTC', 'ETH']);
      for (const bot of Object.values(ctx.store.get().bots))
        for (const p of bot.whitelist) bases.add(p.split('/')[0] as string);
      const pairs = ctx.catalog.tickerPairsFor(bases).slice(0, 20);
      const raw = await client(ctx).call('TradeVolume', { pair: pairs.length > 0 ? pairs : ['XBTUSD', 'ETHUSD'] });
      const { feeTier } = normalizeTradeVolume(raw, ctx.catalog);
      ctx.store.update((s) => {
        s.kraken.feeTier = feeTier;
      });
      noteSuccess(ctx, ['TradeVolume']);
      ctx.store.requestRecheck();
    },
  );
}

export function ledgersJob(ctx: PollerContext): Promise<void> {
  return run(ctx, sourceKey.kraken('ledgers'), 'Kraken ledger', CADENCE_MS['kraken.ledgers'], 'Ledgers', async () => {
    const reconStartSec = Math.floor(ctx.reconStartAt / 1000);
    const backfilledFrom = getMetaNumber(LEDGER_BACKFILL_FROM_KEY);
    const result = await syncLedgerEntries(client(ctx), {
      reconStartSec,
      cursorSec: getMetaNumber(LEDGER_CURSOR_KEY),
      // Moving RECON_START earlier starts a new backfill; a later one needs none.
      backfillComplete: backfilledFrom !== null && backfilledFrom <= reconStartSec,
      catalog: ctx.catalog,
    });
    upsertLedgerEntries(result.entries);
    upsertFlows(flowsOf(result.entries));
    if (result.complete) {
      setMeta(LEDGER_CURSOR_KEY, result.cursorSec);
      const from = getMetaNumber(LEDGER_BACKFILL_FROM_KEY);
      setMeta(LEDGER_BACKFILL_FROM_KEY, from === null ? reconStartSec : Math.min(from, reconStartSec));
    }
    noteSuccess(ctx, ['Ledgers']);
  });
}

export function registerKrakenJobs(ctx: PollerContext): void {
  if (ctx.kraken === null) {
    for (const [key, label, cadence] of [
      [sourceKey.kraken('balance'), 'Kraken balances', CADENCE_MS['kraken.balance']],
      [sourceKey.kraken('openOrders'), 'Kraken open orders', CADENCE_MS['kraken.openOrders']],
      [sourceKey.kraken('closedOrders'), 'Kraken closed orders', CADENCE_MS['kraken.closedOrders']],
    ] as const) {
      ctx.recordOk(key, label, cadence, true);
    }
    updateKrakenStatus(ctx);
    return;
  }
  const add = (name: string, cadenceMs: Ms, startDelayMs: Ms, fn: (c: PollerContext) => Promise<void>): void =>
    ctx.scheduler.add({ name, cadenceMs, startDelayMs, run: () => fn(ctx) });
  add('kraken.balance', CADENCE_MS['kraken.balance'], 1200, balanceJob);
  add('kraken.openOrders', CADENCE_MS['kraken.openOrders'], 1400, openOrdersJob);
  add('kraken.closedOrders', CADENCE_MS['kraken.closedOrders'], 1600, closedOrdersJob);
  add('kraken.queryOrders', CADENCE_MS['kraken.closedOrders'] * 2, 20_000, queryOrdersJob);
  add('kraken.tradeVolume', CADENCE_MS['kraken.tradeVolume'], 3000, tradeVolumeJob);
  add('kraken.ledgers', CADENCE_MS['kraken.ledgers'], 5000, ledgersJob);
}
