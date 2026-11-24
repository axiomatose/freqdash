import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAW = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(RAW, '..');
const SELF = fileURLToPath(import.meta.url);

const TXID = /^O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}$/;
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

// ---------------------------------------------------------------- helpers and shapes

function readText(rel: string): string {
  return fs.readFileSync(path.join(RAW, rel), 'utf8');
}
function readJson<T>(rel: string): T {
  return JSON.parse(readText(rel)) as T;
}
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

interface KrakenOrderRaw {
  refid: string | null;
  userref: number;
  status: string;
  reason: string | null;
  opentm: number;
  closetm: number;
  descr: { pair: string; type: string; ordertype: string; price: string; order: string };
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
}
interface ClosedOrders {
  error: string[];
  result: { closed: Record<string, KrakenOrderRaw>; count: number };
}
interface TimelineEvent {
  type: string;
  at: number;
  pair?: string;
  orderId?: string;
  price?: number;
  stakeUsd?: number;
  message?: string;
}
interface Timeline {
  counts: Record<string, number>;
  totals: { orderStakeUsd: number; orderVolEth: number; signalStakeUsd: number; signalVolEth: number };
  firstOrder: { orderId: string; at: number };
  lastOrder: { orderId: string; at: number };
  events: TimelineEvent[];
  outsideWindowEvents: TimelineEvent[];
}
interface BotOrderSample {
  order_id: string;
  ft_order_side: string;
  filled: number;
  amount: number;
}
interface BotTradeSample {
  trade_id: number;
  orders: BotOrderSample[];
}

const INCIDENT_FROM_S = Date.parse('2026-09-28T04:00:00Z') / 1000;
const INCIDENT_TO_S = Date.parse('2026-09-28T05:20:00Z') / 1000;
const ALTNAMES = new Set(['XBTUSD', 'ETHUSD', 'SHIBUSD', 'BABYUSD']);

const timeline = readJson<Timeline>('incident/timeline.json');
const closedNormal = readJson<ClosedOrders>('kraken/private/ClosedOrders.normal.json');
const closedIncident = readJson<ClosedOrders>('kraken/private/ClosedOrders.incident.json');

function ofType(type: string): TimelineEvent[] {
  return timeline.events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------- generic

describe('fixture files', () => {
  const jsonFiles = walk(RAW).filter((f) => f.endsWith('.json'));

  it('has the expected inventory', () => {
    const rel = (sub: string) => jsonFiles.filter((f) => f.includes(`${path.sep}${sub}${path.sep}`)).length;
    expect(rel('freqtrade')).toBe(32);
    expect(rel('public')).toBe(8);
    expect(rel('errors')).toBe(7);
    expect(fs.existsSync(path.join(RAW, 'logs', 'votemax-incident-2026-09-28.log'))).toBe(true);
    expect(fs.existsSync(path.join(RAW, 'logs', 'votemax-normal-vv.log'))).toBe(true);
  });

  it.each(jsonFiles.map((f) => [path.relative(RAW, f).replaceAll('\\', '/'), f] as const))('parses %s', (_rel, f) => {
    expect(() => JSON.parse(fs.readFileSync(f, 'utf8'))).not.toThrow();
  });

  it('contains no secret patterns anywhere under test/fixtures', () => {
    // Patterns are assembled from parts so this file never matches its own scan.
    const patterns: RegExp[] = [
      /webhooks\/[0-9]+\//,
      /eyJ[A-Za-z0-9_-]{10,}/,
      new RegExp(['tok', 'en='].join('')),
      new RegExp(['Author', 'ization'].join('')),
      new RegExp(['pass', 'word'].join(''), 'i'),
      new RegExp(['cook', 'ie'].join(''), 'i'),
      new RegExp(['discord.com/api/', 'webhooks'].join('')),
      new RegExp(['urllib', '3'].join('')),
    ];
    const offenders: string[] = [];
    for (const f of walk(FIXTURES)) {
      if (f === SELF) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const re of patterns) if (re.test(text)) offenders.push(`${path.relative(FIXTURES, f)} ~ ${re.source}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- freqtrade samples

describe('freqtrade samples', () => {
  it('match the values the adapter work package asserts on', () => {
    const health = readJson<{ last_process_ts: number; bot_startup_ts: number }>('freqtrade/votemax_health.json');
    expect(health.last_process_ts).toBe(1790630988);
    const status = readJson<{ orders: { order_id: string; order_timestamp: number }[]; pair: string }[]>('freqtrade/votemax_status.json');
    expect(status).toHaveLength(1);
    expect(status[0]?.pair).toBe('BTC/USD');
    expect(status[0]?.orders[0]?.order_id).toBe('O6ROFS-APVH7-255LCC');
    expect(status[0]?.orders[0]?.order_timestamp).toBe(1790628707021);
  });

  it('have order ids in Kraken txid format', () => {
    const ids: string[] = [];
    for (const bot of ['votemax', 'dca']) {
      const closed = readJson<{ trades: BotTradeSample[] }>(`freqtrade/${bot}_trades.json`).trades;
      const open = readJson<BotTradeSample[]>(`freqtrade/${bot}_status.json`);
      for (const t of [...closed, ...open]) for (const o of t.orders) ids.push(o.order_id);
    }
    expect(ids).toHaveLength(15);
    for (const id of ids) expect(id).toMatch(TXID);
  });
});

// ---------------------------------------------------------------- incident log and timeline

describe('incident log excerpt', () => {
  const log = readText('logs/votemax-incident-2026-09-28.log');
  const lines = log.split('\n');
  const count = (needle: string) => lines.filter((l) => l.includes(needle)).length;

  it('keeps INFO and above only', () => {
    expect(lines.some((l) => l.includes(' - DEBUG - '))).toBe(false);
  });

  it('matches the documented counts', () => {
    expect(count('Long signal found: about create a new trade')).toBe(26);
    expect(lines.filter((l) => / was created for ETH\/USD and status is open\./.test(l))).toHaveLength(25);
    expect(count('Unable to create trade for ETH/USD')).toBe(1);
    expect(count("'status': 'process died'")).toBe(25);
    expect(count(' - freqtrade - ERROR - Fatal exception!')).toBe(25);
    expect(count('Logfile configured')).toBe(25);
  });

  it('keeps the traceback continuation lines ending in the ValueError', () => {
    const idx = lines.findIndex((l) => l.includes('Fatal exception!'));
    expect(lines[idx + 1]).toBe('Traceback (most recent call last):');
    const tail = lines.slice(idx + 1, idx + 80).find((l) => l.startsWith('ValueError:'));
    expect(tail).toBe("ValueError: invalid literal for int() with base 10: ''");
  });
});

describe('normal -vv log excerpt', () => {
  const lines = readText('logs/votemax-normal-vv.log').split('\n').filter((l) => l !== '');

  it('is DEBUG-heavy and bounded to two minutes', () => {
    const stamps = lines.filter((l) => /^\d{4}-\d{2}-\d{2} /.test(l));
    expect(stamps.length).toBe(lines.length);
    expect(lines.filter((l) => l.includes(' - DEBUG - ')).length).toBeGreaterThan(300);
    expect(lines.filter((l) => l.includes(" - INFO - Bot heartbeat. PID=1, version='2026.8', state='RUNNING'")).length).toBe(2);
    expect(lines[0]?.slice(0, 19)).toBe('2026-09-28 22:20:01');
    expect((lines.at(-1) ?? '').slice(0, 16)).toBe('2026-09-28 22:21');
  });
});

describe('incident timeline', () => {
  it('has the documented counts', () => {
    expect(timeline.counts).toEqual({
      entry_signal: 26,
      order_created: 25,
      order_failed: 1,
      process_died: 25,
      fatal: 25,
      startup: 25,
    });
  });

  it('starts and ends at the documented orders', () => {
    const orders = ofType('order_created');
    expect(orders[0]?.orderId).toBe('OX2D7A-ROVIF-A3YVZW');
    expect(orders[0]?.at).toBe(1790568007965);
    expect(orders.at(-1)?.orderId).toBe('OJ6DEM-PMOHZ-XDLFQB');
    expect(orders.at(-1)?.at).toBe(Date.parse('2026-09-28T05:14:12.349Z'));
    expect(timeline.firstOrder).toEqual({ orderId: 'OX2D7A-ROVIF-A3YVZW', at: 1790568007965 });
    expect(timeline.lastOrder.orderId).toBe('OJ6DEM-PMOHZ-XDLFQB');
    for (const o of orders) expect(o.orderId).toMatch(TXID);
    expect(new Set(orders.map((o) => o.orderId)).size).toBe(25);
  });

  it('is sorted and enriches every order with its signal price and stake', () => {
    const ats = timeline.events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (const o of ofType('order_created')) {
      expect(o.price).toBeGreaterThan(2000);
      expect(o.stakeUsd).toBeGreaterThan(2);
    }
  });

  it('records the nonce failure and the fatal message', () => {
    const failed = ofType('order_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.at).toBe(Date.parse('2026-09-28T04:04:00.099Z'));
    expect(failed[0]?.message).toContain('EAPI:Invalid nonce');
    for (const f of ofType('fatal')) expect(f.message).toBe("ValueError: invalid literal for int() with base 10: ''");
  });

  it('reports the later balance outage that the excerpt windows skip', () => {
    expect(timeline.outsideWindowEvents).toHaveLength(1);
    expect(timeline.outsideWindowEvents[0]?.type).toBe('order_failed');
    expect(timeline.outsideWindowEvents[0]?.message).toContain('EService:Unavailable');
  });

  it('totals match the documented figures', () => {
    expect(timeline.totals.orderStakeUsd).toBeCloseTo(288.05, 2);
    expect(timeline.totals.orderVolEth).toBeCloseTo(0.108725, 6);
    expect(timeline.totals.signalStakeUsd).toBeCloseTo(293.7, 2);
    expect(timeline.totals.signalVolEth).toBeCloseTo(0.110858, 6);
  });
});

// ---------------------------------------------------------------- Kraken public

describe('kraken public captures', () => {
  it('AssetPairs has the pair naming the catalog builder relies on and empty fee arrays', () => {
    const r = readJson<{ result: Record<string, { altname: string; wsname: string; base: string; quote: string; fees: unknown[]; fees_maker: unknown[] }> }>(
      'kraken/public/AssetPairs.json',
    ).result;
    expect(Object.keys(r).sort()).toEqual(['BABYUSD', 'SHIBUSD', 'XETHZUSD', 'XXBTZUSD']);
    expect(r.XXBTZUSD).toMatchObject({ altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD' });
    expect(r.XETHZUSD).toMatchObject({ altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH' });
    expect(r.SHIBUSD).toMatchObject({ altname: 'SHIBUSD', base: 'SHIB', quote: 'ZUSD' });
    for (const p of Object.values(r)) {
      expect(p.fees).toEqual([]);
      expect(p.fees_maker).toEqual([]);
    }
  });

  it('Assets maps XXBT to altname XBT', () => {
    const r = readJson<{ result: Record<string, { altname: string }> }>('kraken/public/Assets.json').result;
    expect(r.XXBT?.altname).toBe('XBT');
    expect(r.ZUSD?.altname).toBe('USD');
    expect(Object.keys(r).sort()).toEqual(['BABY', 'SHIB', 'XETH', 'XXBT', 'ZUSD']);
  });

  it('Ticker carries a last-trade price per pair', () => {
    const r = readJson<{ result: Record<string, { c: string[] }> }>('kraken/public/Ticker.json').result;
    expect(Object.keys(r)).toHaveLength(4);
    for (const t of Object.values(r)) expect(t.c[0]).toMatch(NUMERIC_STRING);
  });

  it('Time has an integer unixtime', () => {
    expect(Number.isInteger(readJson<{ result: { unixtime: number } }>('kraken/public/Time.json').result.unixtime)).toBe(true);
  });

  it.each([
    ['OHLC.XBTUSD.240.json', 'XXBTZUSD', 14400],
    ['OHLC.ETHUSD.240.json', 'XETHZUSD', 14400],
    ['OHLC.XBTUSD.60.json', 'XXBTZUSD', 3600],
  ])('%s is 721 rows whose last row is the forming candle', (file, key, step) => {
    const r = readJson<{ result: Record<string, unknown> }>(`kraken/public/${file}`).result;
    const rows = r[key] as (string | number)[][];
    const last = r.last as number;
    expect(rows).toHaveLength(721);
    expect(rows[0]).toHaveLength(8);
    const lastRow = rows.at(-1) ?? [];
    expect(lastRow[0]).toBeGreaterThan(last);
    expect(rows.at(-2)?.[0]).toBe(last);
    expect((lastRow[0] as number) - (rows.at(-2)?.[0] as number)).toBe(step);
  });
});

// ---------------------------------------------------------------- Kraken private (synthetic)

describe('kraken private fixtures', () => {
  function checkOrders(file: ClosedOrders): void {
    const entries = Object.entries(file.result.closed);
    expect(file.error).toEqual([]);
    expect(file.result.count).toBe(entries.length);
    for (const [txid, o] of entries) {
      expect(txid).toMatch(TXID);
      for (const field of [o.vol, o.vol_exec, o.cost, o.fee, o.price, o.descr.price]) expect(field).toMatch(NUMERIC_STRING);
      expect(typeof o.opentm).toBe('number');
      expect(typeof o.closetm).toBe('number');
      expect(o.closetm).toBeGreaterThanOrEqual(o.opentm);
      expect(ALTNAMES.has(o.descr.pair)).toBe(true);
      expect(o.descr.order.startsWith(`${o.descr.type} ${o.vol} ${o.descr.pair} @ limit`)).toBe(true);
      expect(Number(o.vol_exec)).toBeLessThanOrEqual(Number(o.vol));
    }
    const closetms = entries.map(([, o]) => o.closetm);
    expect(closetms).toEqual([...closetms].sort((a, b) => b - a));
  }

  it('ClosedOrders.normal has shape-correct orders, one per sample bot order', () => {
    checkOrders(closedNormal);
    const sampleIds: string[] = [];
    for (const bot of ['votemax', 'dca']) {
      const closed = readJson<{ trades: BotTradeSample[] }>(`freqtrade/${bot}_trades.json`).trades;
      const open = readJson<BotTradeSample[]>(`freqtrade/${bot}_status.json`);
      for (const t of [...closed, ...open]) for (const o of t.orders) sampleIds.push(o.order_id);
    }
    expect(Object.keys(closedNormal.result.closed).sort()).toEqual([...sampleIds].sort());
    const entry = closedNormal.result.closed['O6ROFS-APVH7-255LCC'];
    expect(entry?.vol_exec).toBe('0.00046744');
    expect(entry?.opentm).toBe(1790628707.021);
    expect(entry?.descr.pair).toBe('XBTUSD');
    expect(Number(entry?.fee)).toBeCloseTo(Number(entry?.cost) * 0.00400006, 4);
  });

  it('ClosedOrders.incident is a superset with the special orders', () => {
    checkOrders(closedIncident);
    const ids = Object.keys(closedIncident.result.closed);
    for (const id of Object.keys(closedNormal.result.closed)) expect(ids).toContain(id);
    expect(ids).toHaveLength(15 + 25 + 3);
    const synth = closedIncident.result.closed['OWDY2Z-TVWRN-IJBALL'];
    expect(synth?.status).toBe('closed');
    const manual = closedIncident.result.closed['OYYVFI-FJISQ-5N6DW5'];
    expect(manual?.descr.pair).toBe('SHIBUSD');
    expect(manual?.vol_exec).toBe('1901628.18000');
    const cancelled = closedIncident.result.closed['O5GCGD-X5FJN-JFUFDO'];
    expect(cancelled).toMatchObject({ status: 'canceled', vol_exec: '0.00000000', cost: '0.00000', reason: 'User requested' });
  });

  it('every logged incident order appears on Kraken with the log time as opentm', () => {
    for (const o of ofType('order_created')) {
      const k = closedIncident.result.closed[o.orderId ?? ''];
      expect(k).toBeDefined();
      expect(k?.opentm).toBe(o.at / 1000);
      expect(k?.closetm).toBeCloseTo((k?.opentm ?? 0) + 30, 3);
      expect(k?.vol).toBe(k?.vol_exec);
      expect(Number(k?.vol)).toBeCloseTo((o.stakeUsd ?? 0) / (o.price ?? 1), 7);
      expect(Number(k?.fee)).toBeCloseTo(Number(k?.cost) * 0.004, 4);
    }
  });

  it('incident ETH volume equals the wallet minus its dust (the Kraken-only order closes the gap)', () => {
    const eth = Object.values(closedIncident.result.closed).filter(
      (o) => o.descr.pair === 'ETHUSD' && o.opentm >= INCIDENT_FROM_S && o.opentm < INCIDENT_TO_S,
    );
    expect(eth).toHaveLength(26);
    const sum = eth.reduce((a, o) => a + Math.round(Number(o.vol_exec) * 1e8), 0) / 1e8;
    expect(Math.abs(sum - (0.1130240889 - 8.9e-9))).toBeLessThanOrEqual(1e-8 + 1e-12);
    const logged = ofType('order_created').reduce((a, o) => a + Math.round(((o.stakeUsd ?? 0) / (o.price ?? 1)) * 1e8), 0) / 1e8;
    expect(logged).toBeCloseTo(timeline.totals.orderVolEth, 8);
    expect(sum - logged).toBeCloseTo(0.0043, 4);
  });

  it('balances follow the extended and legacy shapes', () => {
    type Ex = { result: Record<string, { balance: string; hold_trade: string; credit?: string; credit_used?: string }> };
    const after = readJson<Ex>('kraken/private/BalanceEx.after.json').result;
    const before = readJson<Ex>('kraken/private/BalanceEx.before.json').result;
    const now = readJson<Ex>('kraken/private/BalanceEx.json').result;
    const legacy = readJson<{ error: string[]; result: Record<string, string> }>('kraken/private/Balance.json');
    expect(after.XETH?.balance).toBe('0.1130240889');
    expect(before.XETH?.balance).toBe('0.0000000089');
    expect(Number(before.ZUSD?.balance)).toBeGreaterThan(Number(after.ZUSD?.balance));
    expect(Object.keys(after).sort()).toEqual(['BABY', 'SHIB', 'XETH', 'ZUSD']);
    expect(Object.keys(now).sort()).toEqual(['BABY', 'SHIB', 'XETH', 'XXBT', 'ZUSD']);
    expect(now.XXBT?.balance).toBe('0.0004674400');
    expect(now.SHIB?.balance).toBe('1901628.18000');
    expect(now.BABY?.balance).toBe('0.21895');
    expect(legacy.error).toEqual([]);
    for (const [asset, e] of Object.entries(now)) {
      expect(legacy.result[asset]).toBe(e.balance);
      expect(e.hold_trade).toMatch(NUMERIC_STRING);
    }
    const wallets = readJson<Ex>('kraken/private/BalanceEx.wallets.json').result;
    expect(Object.keys(wallets)).toEqual(['ZUSD', 'XXBT', 'XBT.F', 'DOT.S', 'USD.HOLD']);
    expect(wallets.ZUSD?.hold_trade).toBe('20.0000');
  });

  it('OpenOrders.empty and TradeVolume', () => {
    expect(readJson<{ error: string[]; result: { open: object } }>('kraken/private/OpenOrders.empty.json')).toEqual({ error: [], result: { open: {} } });
    const tv = readJson<{ result: { currency: string; volume: string; fees: Record<string, { fee: string }>; fees_maker: Record<string, { fee: string }> } }>(
      'kraken/private/TradeVolume.json',
    ).result;
    expect(tv.currency).toBe('ZUSD');
    expect(tv.volume).toMatch(NUMERIC_STRING);
    expect(tv.fees.XETHZUSD?.fee).toBe('0.4000');
    expect(tv.fees_maker.XETHZUSD?.fee).toBe('0.2500');
  });

  it.each([
    ['invalid_key', 'EAPI:Invalid key'],
    ['invalid_signature', 'EAPI:Invalid signature'],
    ['permission_denied', 'EGeneral:Permission denied'],
    ['rate_limit', 'EAPI:Rate limit exceeded'],
    ['throttled', 'EService:Throttled'],
    ['invalid_nonce', 'EAPI:Invalid nonce'],
    ['unavailable', 'EService:Unavailable'],
  ])('error fixture %s', (name, message) => {
    expect(readJson<unknown>(`kraken/errors/${name}.json`)).toEqual({ error: [message] });
  });
});
