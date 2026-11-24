// Tests of the scenario builder and the harness themselves: the regression is only as good as its inputs.
import { describe, expect, it } from 'vitest';
import type { CheckInput } from '@/server/checks/types';
import { SEC, T0, balance, healthyBot, input, krakenView } from './builders';
import { runChecks } from './harness';
import {
  ETH_FINAL_QTY,
  FEE_TIER,
  IncidentScenario,
  INCIDENT_TXIDS,
  KRAKEN_ORDERS,
  LOG_TIMELINE,
  MANUAL_SHIB_TXID,
  RECON_START_AT,
  SCENARIO_END,
  SCENARIO_START,
  SHIB_QTY,
  SYNTHETIC_ORPHAN_TXID,
  ZERO_FILL_TXID,
  flappingInputs,
  incidentInputs,
  toKrakenOrder,
} from './scenario';

const at = (h: number, m: number, s = 0, ms = 0): number => Date.UTC(2026, 8, 28, h, m, s, ms);
const eth = (i: CheckInput) => i.kraken!.balances.find((b) => b.asset === 'ETH')!.total;
const usd = (i: CheckInput) => i.kraken!.balances.find((b) => b.asset === 'USD')!.total;

describe('incident fixtures', () => {
  it('has the documented incident: 25 logged orders, 26 with the Kraken-only one, ETH ends at 0.1130240889', () => {
    expect(LOG_TIMELINE.filter((e) => e.type === 'order_created')).toHaveLength(25);
    expect(INCIDENT_TXIDS).toHaveLength(26);
    expect(INCIDENT_TXIDS).toContain(SYNTHETIC_ORPHAN_TXID);
    const sum = KRAKEN_ORDERS.filter((o) => INCIDENT_TXIDS.includes(o.txid)).reduce((s, o) => s + o.volExec, 0);
    expect(Math.abs(8.9e-9 + sum - ETH_FINAL_QTY)).toBeLessThan(1e-8);
    expect(KRAKEN_ORDERS.find((o) => o.txid === MANUAL_SHIB_TXID)).toMatchObject({
      pair: 'SHIB/USD',
      side: 'buy',
      status: 'closed',
    });
    expect(KRAKEN_ORDERS.find((o) => o.txid === ZERO_FILL_TXID)).toMatchObject({ status: 'canceled', volExec: 0 });
    expect(SHIB_QTY).toBeCloseTo(1901628.18, 6);
    expect(FEE_TIER).toEqual({
      'BTC/USD': { taker: 0.004, maker: 0.0025 },
      'ETH/USD': { taker: 0.004, maker: 0.0025 },
    });
  });

  it('toKrakenOrder converts seconds to ms, strings to numbers, and maps altnames', () => {
    const o = toKrakenOrder('OJZZRX-X3SZV-V5IP2Y', {
      status: 'expired',
      reason: 'x',
      opentm: 1790568007.965,
      closetm: 1790568037.965,
      userref: 7,
      descr: { pair: 'XBTUSD', type: 'sell', ordertype: 'limit', price: '0' },
      vol: '1.5',
      vol_exec: '0',
      cost: '0',
      fee: '0',
      price: '0',
    });
    expect(o).toMatchObject({
      pair: 'BTC/USD',
      side: 'sell',
      status: 'expired',
      openedAt: 1790568007965,
      closedAt: 1790568037965,
      vol: 1.5,
      avgPrice: null,
      limitPrice: null,
      userref: 7,
    });
    expect(
      toKrakenOrder('OJZZRX-X3SZV-V5IP2Y', {
        ...{
          status: 'closed',
          reason: null,
          opentm: 1,
          closetm: 2,
          userref: 0,
          descr: { pair: 'UNKNOWNPAIR', type: 'buy', ordertype: 'limit', price: '1' },
          vol: '1',
          vol_exec: '1',
          cost: '1',
          fee: '0',
          price: '1',
        },
      }),
    ).toMatchObject({
      pair: null,
      krakenPair: 'UNKNOWNPAIR',
      status: 'closed',
      userref: null,
      avgPrice: 1,
    });
  });
});

describe('incident scenario', () => {
  const all = [...incidentInputs({ withKraken: true, withLogs: true })];
  const inputAt = (t: number) => all[(t - SCENARIO_START) / 5000]!;

  it('yields one input every 5 s from 03:59:00 to 06:20:00 and the bots never know the incident orders', () => {
    expect(all).toHaveLength((SCENARIO_END - SCENARIO_START) / 5000 + 1);
    expect(all[0]!.now).toBe(at(3, 59));
    expect(all.at(-1)!.now).toBe(at(6, 20));
    for (const txid of INCIDENT_TXIDS) expect(all.at(-1)!.knownOrders[txid]).toBeUndefined();
    expect(Object.keys(all[0]!.knownOrders).length).toBeGreaterThan(10);
    expect(all[0]!.reconStartAt).toBe(RECON_START_AT);
  });

  it('models Kraken: an order is open from creation to close, closed afterwards, and balances follow the fills', () => {
    const first = 'OX2D7A-ROVIF-A3YVZW';
    const open = inputAt(at(4, 0, 15)).kraken!;
    expect(open.openOrders.find((o) => o.txid === first)).toMatchObject({ status: 'open', volExec: 0, closedAt: null });
    expect(open.orders.filter((o) => o.txid === first)).toHaveLength(1);
    expect(inputAt(at(4, 0, 45)).kraken!.orders.some((o) => o.txid === first)).toBe(false);
    expect(inputAt(at(4, 1, 0)).kraken!.orders.find((o) => o.txid === first)).toMatchObject({
      status: 'closed',
      volExec: 0.01393687,
    });

    expect(eth(inputAt(at(4, 0, 30)))).toBeCloseTo(8.9e-9, 12);
    expect(eth(inputAt(at(4, 1, 0)))).toBeCloseTo(8.9e-9 + 0.01393687 + 0.01218685, 9);
    expect(Math.abs(eth(all.at(-1)!) - ETH_FINAL_QTY)).toBeLessThan(1e-8);
    expect(usd(all[0]!)).toBeCloseTo(1801.7694, 4);
    expect(Math.abs(usd(all.at(-1)!) - 1501.1379)).toBeLessThan(2e-3);
  });

  it('polls Kraken on its own cadences: balances every 30 s, open orders every 15 s', () => {
    const k = inputAt(at(4, 0, 50)).kraken!;
    expect(k.balancesAt).toBe(at(4, 0, 30));
    expect(k.openOrdersAt).toBe(at(4, 0, 45));
  });

  it('keeps the older Kraken history (manual SHIB order, zero-fill cancel) inside the reconciliation window', () => {
    const orders = all[0]!.kraken!.orders;
    expect(orders.some((o) => o.txid === MANUAL_SHIB_TXID)).toBe(true);
    expect(orders.some((o) => o.txid === ZERO_FILL_TXID)).toBe(true);
    expect(orders.every((o) => o.openedAt >= RECON_START_AT)).toBe(true);
    expect(orders.some((o) => o.txid === 'O6ROFS-APVH7-255LCC')).toBe(false);
  });

  it('acknowledges the manual SHIB holding and order from the start, and everything else only from ackAt', () => {
    expect(all[0]!.acks.map((a) => a.subject).sort()).toEqual([MANUAL_SHIB_TXID, 'SHIB']);
    const later = [...incidentInputs({ withKraken: true, withLogs: true, ackAt: at(4, 30) })];
    const before = later[(at(4, 29, 55) - SCENARIO_START) / 5000]!;
    const after = later[(at(4, 30) - SCENARIO_START) / 5000]!;
    expect(before.acks).toHaveLength(2);
    expect(after.acks).toHaveLength(2 + 26 + 1);
    expect(after.acks.find((a) => a.subject === 'ETH')).toMatchObject({ kind: 'asset', qtyBaseline: ETH_FINAL_QTY });
    expect(after.acks.filter((a) => a.kind === 'kraken_order' && INCIDENT_TXIDS.includes(a.subject))).toHaveLength(26);
  });

  it('models the bots: votemax drops out in crash windows, both refresh wallets every minute, restarts show up in health', () => {
    expect(inputAt(at(4, 0, 10)).bots[0]!.health!.reachable).toBe(false);
    expect(inputAt(at(4, 0, 20)).bots[0]!.health!.reachable).toBe(true);
    expect(inputAt(at(4, 0, 20)).bots[0]!.health!.botStartupAt).toBe(at(4, 0, 16));
    expect(inputAt(at(4, 0, 20)).bots[1]!.health!.botStartupAt).toBe(at(0, 0));
    const dca = inputAt(at(4, 1, 30)).bots[1]!;
    expect(dca.wallet!.lastWalletSyncAt).toBe(at(4, 1, 0));
    expect(dca.wallet!.currencies.find((c) => c.currency === 'ETH')!.balance).toBeCloseTo(
      8.9e-9 + 0.01393687 + 0.01218685,
      9,
    );
    expect(dca.logTail).toMatchObject({ configured: true, available: true, lastWalletSyncAt: at(4, 1, 0) });
    const healthStartups = inputAt(at(4, 3)).events.filter((e) => e.source === 'health');
    expect(healthStartups.length).toBeGreaterThan(3);
    expect(healthStartups.every((e) => e.type === 'startup')).toBe(true);
  });

  it('feeds log events at their timestamps, and only recent ones plus order_created', () => {
    expect(inputAt(at(4, 0, 5)).events.filter((e) => e.source === 'logfile')).toEqual([]);
    expect(
      inputAt(at(4, 0, 10))
        .events.filter((e) => e.source === 'logfile')
        .map((e) => e.type),
    ).toEqual(['order_created', 'process_died', 'fatal']);
    const late = inputAt(at(6, 20)).events;
    expect(late.filter((e) => e.type === 'order_created')).toHaveLength(25);
    expect(late.filter((e) => e.type === 'fatal' && e.at < at(4, 30))).toEqual([]);
  });

  it('without logs the log tail is not configured and no log event is delivered; without Kraken there is no Kraken view', () => {
    const noLogs = [...incidentInputs({ withKraken: false, withLogs: false, endAt: at(4, 2) })];
    const last = noLogs.at(-1)!;
    expect(last.kraken).toBeNull();
    expect(last.bots[0]!.logTail).toMatchObject({ configured: false, available: false, file: null, lastLineAt: null });
    expect(last.events.every((e) => e.source === 'health')).toBe(true);
  });

  it('IncidentScenario can be driven step by step', () => {
    const sim = new IncidentScenario({ withKraken: false, withLogs: true });
    expect(sim.at(SCENARIO_START).now).toBe(SCENARIO_START);
    expect(sim.at(SCENARIO_START + 5 * SEC).now).toBe(SCENARIO_START + 5 * SEC);
  });
});

describe('flapping scenarios', () => {
  it('alternates health every 10 s for 10 minutes', () => {
    const inputs = [...flappingInputs('alternating')];
    expect(inputs.at(-1)!.now - inputs[0]!.now).toBe(10 * 60_000);
    const reach = inputs
      .filter((i) => i.now % 10_000 === SCENARIO_START % 10_000)
      .map((i) => i.bots[0]!.health!.reachable);
    expect(new Set(reach)).toEqual(new Set([true, false]));
    expect(inputs.every((i) => i.bots[1]!.health!.reachable)).toBe(true);
  });

  it('has six 45 s outages five minutes apart', () => {
    const inputs = [...flappingInputs('outages')];
    let episodes = 0;
    let prev = true;
    for (const i of inputs) {
      const up = i.bots[0]!.health!.reachable;
      if (prev && !up) episodes += 1;
      prev = up;
    }
    expect(episodes).toBe(6);
  });
});

describe('harness', () => {
  it('discards pending findings that vanish, and tracks state changes and notifications', () => {
    const now = T0;
    const stray = (t: number): CheckInput =>
      input({
        now: t,
        bots: [healthyBot('votemax', t)],
        kraken: krakenView({ balances: [balance('USD', 1, 1), balance('ETH', 0.1, 2500)] }, t),
        prices: { USD: 1, ETH: 2500 },
      });
    const quiet = (t: number): CheckInput =>
      input({
        now: t,
        bots: [healthyBot('votemax', t)],
        kraken: krakenView({ balances: [balance('USD', 1, 1)] }, t),
        prices: { USD: 1 },
      });
    const run = runChecks([stray(now), stray(now + 5 * SEC), quiet(now + 10 * SEC)]);
    expect(run.rows.size).toBe(0);
    expect(run.log.map((e) => [e.fingerprint, e.status])).toEqual([['UNTRACKED_HOLDING:ETH', 'pending']]);
    expect(run.firstActive('UNTRACKED_HOLDING:ETH')).toBeNull();
    expect(run.stateAt('UNTRACKED_HOLDING:ETH', now + 20 * SEC)!.status).toBe('pending');
    expect(run.stateAt('NOPE', now)).toBeNull();
    expect(run.activeBefore(now + 1e9, 'info')).toEqual([]);
    expect(run.notifications).toEqual([]);
    expect([...run.rawFingerprints]).toEqual(['UNTRACKED_HOLDING:ETH']);
  });
});
