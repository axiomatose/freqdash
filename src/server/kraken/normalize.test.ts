import { describe, expect, it, vi } from 'vitest';
import ohlcEth240 from '../../../test/fixtures/raw/kraken/public/OHLC.ETHUSD.240.json';
import ohlcXbt240 from '../../../test/fixtures/raw/kraken/public/OHLC.XBTUSD.240.json';
import ohlcXbt60 from '../../../test/fixtures/raw/kraken/public/OHLC.XBTUSD.60.json';
import rawAssets from '../../../test/fixtures/raw/kraken/public/Assets.json';
import rawPairs from '../../../test/fixtures/raw/kraken/public/AssetPairs.json';
import rawTicker from '../../../test/fixtures/raw/kraken/public/Ticker.json';
import balance from '../../../test/fixtures/raw/kraken/private/Balance.json';
import balanceEx from '../../../test/fixtures/raw/kraken/private/BalanceEx.json';
import balanceExBefore from '../../../test/fixtures/raw/kraken/private/BalanceEx.before.json';
import balanceExWallets from '../../../test/fixtures/raw/kraken/private/BalanceEx.wallets.json';
import closedIncident from '../../../test/fixtures/raw/kraken/private/ClosedOrders.incident.json';
import closedNormal from '../../../test/fixtures/raw/kraken/private/ClosedOrders.normal.json';
import openEmpty from '../../../test/fixtures/raw/kraken/private/OpenOrders.empty.json';
import tradeVolume from '../../../test/fixtures/raw/kraken/private/TradeVolume.json';
import { buildAssetCatalog, emptyAssetCatalog } from './assets';
import {
  normalizeBalance,
  normalizeBalanceEx,
  flowsOf,
  normalizeLedgerEntries,
  normalizeOhlc,
  normalizeOrders,
  normalizeTicker,
  normalizeTradeVolume,
} from './normalize';

const catalog = buildAssetCatalog(rawAssets, rawPairs);
const byAsset = <T extends { asset: string; wallet: string }>(entries: T[], asset: string, wallet = 'spot') =>
  entries.find((entry) => entry.asset === asset && entry.wallet === wallet);

describe('normalizeBalance / normalizeBalanceEx', () => {
  const prices = { BTC: 83_214.5, ETH: { usd: 2_674.51 }, SHIB: 0.000005613 };

  it('normalizes Balance (plain string amounts) and maps Kraken codes to assets', () => {
    const entries = normalizeBalance(balance, catalog);
    expect(entries.map((e) => e.asset)).toEqual(['BABY', 'BTC', 'ETH', 'SHIB', 'USD']);
    expect(byAsset(entries, 'BTC')).toEqual({
      asset: 'BTC',
      krakenAsset: 'XXBT',
      wallet: 'spot',
      total: 0.00046744,
      hold: 0,
      available: 0.00046744,
      priceUsd: null,
      valueUsd: null,
    });
    expect(byAsset(entries, 'USD')).toMatchObject({
      krakenAsset: 'ZUSD',
      total: 1461.9925,
      priceUsd: 1,
      valueUsd: 1461.9925,
    });
    expect(byAsset(entries, 'SHIB')?.total).toBe(1901628.18);
  });

  it('prices holdings from either price shape, with USD always 1 and unknown assets unpriced', () => {
    const entries = normalizeBalanceEx(balanceEx, catalog, prices);
    expect(byAsset(entries, 'BTC')).toMatchObject({ priceUsd: 83_214.5 });
    expect(byAsset(entries, 'BTC')?.valueUsd).toBeCloseTo(0.00046744 * 83_214.5, 8);
    expect(byAsset(entries, 'ETH')).toMatchObject({ priceUsd: 2_674.51 });
    expect(byAsset(entries, 'ETH')?.valueUsd).toBeCloseTo(0.1130240889 * 2_674.51, 6);
    expect(byAsset(entries, 'USD')).toMatchObject({ priceUsd: 1, valueUsd: 1461.9925 });
    expect(byAsset(entries, 'BABY')).toMatchObject({ priceUsd: null, valueUsd: null });
  });

  it('reads BalanceEx (with credit fields) and matches Balance on the totals', () => {
    const ex = normalizeBalanceEx(balanceEx, catalog);
    expect(ex.map((e) => [e.krakenAsset, e.total])).toEqual(
      normalizeBalance(balance, catalog).map((e) => [e.krakenAsset, e.total]),
    );
    for (const entry of ex) expect([entry.hold, entry.available]).toEqual([0, entry.total]);
  });

  it('accepts BalanceEx without credit fields (the before-incident fixture)', () => {
    const entries = normalizeBalanceEx(balanceExBefore, catalog);
    expect(byAsset(entries, 'USD')).toMatchObject({ total: 1801.7694, hold: 0, available: 1801.7694 });
    expect(byAsset(entries, 'ETH')?.total).toBe(8.9e-9);
  });

  it('handles wallet suffixes, holds and codes the catalog does not know', () => {
    const entries = normalizeBalanceEx(balanceExWallets, catalog);
    expect(entries.map((e) => `${e.asset}/${e.wallet}/${e.krakenAsset}`)).toEqual([
      'BTC/earn/XBT.F',
      'BTC/spot/XXBT',
      'DOT/staked/DOT.S',
      'USD/other/USD.HOLD',
      'USD/spot/ZUSD',
    ]);
    expect(byAsset(entries, 'USD')).toMatchObject({ total: 250.1234, hold: 20, available: 230.1234 });
    expect(byAsset(entries, 'BTC', 'earn')).toMatchObject({ total: 0.001, krakenAsset: 'XBT.F' });
    expect(byAsset(entries, 'DOT', 'staked')).toMatchObject({ total: 12.5, priceUsd: null });
    expect(byAsset(entries, 'USD', 'other')).toMatchObject({ total: 5, priceUsd: 1, valueUsd: 5 });
  });

  it('computes available as balance + credit - credit_used - hold_trade', () => {
    const entries = normalizeBalanceEx(
      { ZUSD: { balance: '10.0', credit: '5.0', credit_used: '2.0', hold_trade: '3.0' } },
      catalog,
    );
    expect(entries[0]).toMatchObject({ total: 10, hold: 3, available: 10 });
    const overheld = normalizeBalanceEx({ ZUSD: { balance: '1.0', hold_trade: '3.0' } }, catalog);
    expect(overheld[0]?.available).toBe(0);
  });

  it('tolerates a mixed shape, partial data and garbage', () => {
    const entries = normalizeBalanceEx(
      {
        ZUSD: '12.5',
        XXBT: { balance: '0.1' },
        BAD1: { balance: 'nan' },
        BAD2: { hold_trade: '1' },
        BAD3: null,
        BAD4: '',
      },
      catalog,
    );
    expect(entries.map((e) => [e.krakenAsset, e.total])).toEqual([
      ['XXBT', 0.1],
      ['ZUSD', 12.5],
    ]);
    for (const garbage of [null, undefined, 'x', 5, []]) {
      expect(normalizeBalance(garbage, catalog)).toEqual([]);
      expect(normalizeBalanceEx(garbage, catalog)).toEqual([]);
    }
  });

  it('accepts the bare result as well as the envelope', () => {
    expect(normalizeBalance(balance.result, catalog)).toEqual(normalizeBalance(balance, catalog));
  });

  it('works without a populated catalog (static aliases and suffix parsing only)', () => {
    const entries = normalizeBalanceEx(balanceExWallets, emptyAssetCatalog());
    expect(entries.map((e) => `${e.asset}/${e.wallet}`)).toContain('BTC/earn');
    expect(entries.map((e) => `${e.asset}/${e.wallet}`)).toContain('USD/spot');
  });
});

describe('normalizeOrders', () => {
  it('normalizes a ClosedOrders response using the real shapes', () => {
    const orders = normalizeOrders(closedNormal, catalog);
    expect(orders).toHaveLength(15);
    expect(orders.map((o) => o.openedAt)).toEqual([...orders.map((o) => o.openedAt)].sort((a, b) => a - b));
    expect(orders.find((o) => o.txid === 'O6ROFS-APVH7-255LCC')).toEqual({
      txid: 'O6ROFS-APVH7-255LCC',
      pair: 'BTC/USD',
      krakenPair: 'XBTUSD',
      side: 'buy',
      orderType: 'limit',
      status: 'closed',
      openedAt: 1790628707021,
      closedAt: 1790628758621,
      vol: 0.00046744,
      volExec: 0.00046744,
      costUsd: 38.9894,
      feeUsd: 0.15596,
      avgPrice: 83410.5,
      limitPrice: 83410.5,
      userref: null,
      clOrdId: null,
      reason: null,
    });
    const sell = orders.find((o) => o.txid === 'O3VFJ3-QWXH4-LVC4N7');
    expect(sell).toMatchObject({ side: 'sell', pair: 'ETH/USD', avgPrice: 2303.99, limitPrice: 2301.45 });
  });

  it('treats integer close times and float open times alike (seconds to ms)', () => {
    const order = normalizeOrders(closedNormal, catalog).find((o) => o.txid === 'O3PYSR-H3EAF-G7BP5O');
    expect(order).toMatchObject({ openedAt: 1785528046918, closedAt: 1785528065000 });
  });

  it('reads the incident set: 26 ETH buys that add up to the wallet change, a manual order and a zero-fill cancel', () => {
    const orders = normalizeOrders(closedIncident, catalog);
    expect(orders).toHaveLength(43);
    const ethBuys = orders.filter(
      (o) =>
        o.pair === 'ETH/USD' && o.side === 'buy' && o.status === 'closed' && o.openedAt >= Date.UTC(2026, 8, 28, 3),
    );
    expect(ethBuys).toHaveLength(26);
    expect(ethBuys.reduce((sum, o) => sum + o.volExec, 0)).toBeCloseTo(0.11302408, 9);
    expect(orders.find((o) => o.txid === 'OWDY2Z-TVWRN-IJBALL')).toMatchObject({ pair: 'ETH/USD', status: 'closed' });
    expect(orders.find((o) => o.txid === 'OYYVFI-FJISQ-5N6DW5')).toMatchObject({ pair: 'SHIB/USD', side: 'buy' });
    expect(orders.find((o) => o.txid === 'O5GCGD-X5FJN-JFUFDO')).toEqual(
      expect.objectContaining({
        status: 'canceled',
        reason: 'User requested',
        volExec: 0,
        costUsd: 0,
        feeUsd: 0,
        avgPrice: null,
        limitPrice: 2645.1,
      }),
    );
  });

  it('normalizes OpenOrders, including an empty one', () => {
    expect(normalizeOrders(openEmpty, catalog)).toEqual([]);
    const open = normalizeOrders(
      {
        open: {
          'OAWY5U-HPM3N-PD6PDX': {
            status: 'open',
            opentm: 1790630000.5,
            starttm: 0,
            expiretm: 0,
            userref: 12,
            cl_ord_id: 'my-client-id',
            descr: { pair: 'ETHUSD', type: 'buy', ordertype: 'limit', price: '2600.00', price2: '0' },
            vol: '0.01000000',
            vol_exec: '0.00300000',
            cost: '7.80000',
            fee: '0.03120',
            price: '2600.00000',
          },
        },
      },
      catalog,
    );
    expect(open).toEqual([
      {
        txid: 'OAWY5U-HPM3N-PD6PDX',
        pair: 'ETH/USD',
        krakenPair: 'ETHUSD',
        side: 'buy',
        orderType: 'limit',
        status: 'open',
        openedAt: 1790630000500,
        closedAt: null,
        vol: 0.01,
        volExec: 0.003,
        costUsd: 7.8,
        feeUsd: 0.0312,
        avgPrice: 2600,
        limitPrice: 2600,
        userref: 12,
        clOrdId: 'my-client-id',
        reason: null,
      },
    ]);
  });

  it('reads the QueryOrders shape (a bare txid map) and ignores scalar siblings', () => {
    const closed = (closedNormal.result.closed as Record<string, unknown>)['O6ROFS-APVH7-255LCC'];
    const orders = normalizeOrders({ 'O6ROFS-APVH7-255LCC': closed, count: 1 }, catalog);
    expect(orders.map((o) => o.txid)).toEqual(['O6ROFS-APVH7-255LCC']);
  });

  it('maps market orders, userref 0 and unknown statuses sensibly', () => {
    const entry = (extra: Record<string, unknown>) => ({
      opentm: 1790630000,
      closetm: 1790630001,
      descr: { pair: 'XBTUSD', type: 'sell', ordertype: 'market', price: '0', price2: '0' },
      vol: '1',
      vol_exec: '1',
      cost: '100',
      fee: '0.4',
      price: '100',
      userref: 0,
      ...extra,
    });
    const orders = normalizeOrders(
      { closed: { A: entry({ status: 'closed' }), B: entry({ status: 'weird' }), C: entry({ status: 'pending' }) } },
      catalog,
    );
    expect(orders.find((o) => o.txid === 'A')).toMatchObject({ orderType: 'market', limitPrice: null, userref: null });
    expect(orders.find((o) => o.txid === 'B')?.status).toBe('closed');
    expect(orders.find((o) => o.txid === 'C')?.status).toBe('pending');
    const open = normalizeOrders({ open: { D: entry({ status: 'weird', closetm: 0 }) } }, catalog);
    expect(open[0]).toMatchObject({ status: 'open', closedAt: null });
  });

  it('keeps orders for pairs the catalog does not know, with pair null', () => {
    const orders = normalizeOrders(closedNormal, emptyAssetCatalog());
    expect(orders).toHaveLength(15);
    for (const order of orders) expect(order.pair).toBeNull();
    expect(orders.find((o) => o.txid === 'O6ROFS-APVH7-255LCC')?.krakenPair).toBe('XBTUSD');
  });

  it('converts cost and fee of non-USD quoted pairs only when a quote price is available', () => {
    const btcQuoted = buildAssetCatalog(rawAssets, {
      XETHXXBT: { altname: 'ETHXBT', wsname: 'ETH/XBT', base: 'XETH', quote: 'XXBT', status: 'online' },
    });
    const raw = {
      closed: {
        OX: {
          status: 'closed',
          opentm: 1790630000,
          closetm: 1790630001,
          descr: { pair: 'ETHXBT', type: 'buy', ordertype: 'limit', price: '0.03' },
          vol: '1',
          vol_exec: '1',
          cost: '0.03',
          fee: '0.0001',
          price: '0.03',
        },
      },
    };
    expect(normalizeOrders(raw, btcQuoted)[0]).toMatchObject({ pair: 'ETH/BTC', costUsd: 0, feeUsd: 0 });
    const priced = normalizeOrders(raw, btcQuoted, { prices: { BTC: 80_000 } })[0];
    expect(priced?.costUsd).toBeCloseTo(2400, 6);
    expect(priced?.feeUsd).toBeCloseTo(8, 6);
  });

  it('skips malformed entries and reports them', () => {
    const onSkip = vi.fn();
    const valid = (closedNormal.result.closed as Record<string, unknown>)['O6ROFS-APVH7-255LCC'];
    const orders = normalizeOrders(
      {
        closed: {
          OGOOD: valid,
          ONOSIDE: { opentm: 1, descr: { pair: 'XBTUSD' } },
          ONOTIME: { descr: { pair: 'XBTUSD', type: 'buy' } },
          OSTRING: 'nope',
          ONULL: null,
        },
      },
      catalog,
      { onSkip },
    );
    expect(orders.map((o) => o.txid)).toEqual(['OGOOD']);
    expect(onSkip.mock.calls.map(([txid]) => txid).sort()).toEqual(['ONOSIDE', 'ONOTIME', 'ONULL', 'OSTRING']);
    for (const garbage of [null, undefined, 'x', 5, []]) expect(normalizeOrders(garbage, catalog)).toEqual([]);
  });
});

describe('normalizeTicker', () => {
  it('reads the last trade price c[0] of USD pairs, keyed by base asset', () => {
    const prices = normalizeTicker(rawTicker, catalog, 1_790_634_730_000);
    expect(prices).toEqual({
      BTC: { usd: 83214.5, at: 1_790_634_730_000 },
      ETH: { usd: 2674.51, at: 1_790_634_730_000 },
      SHIB: { usd: 0.000005613, at: 1_790_634_730_000 },
      BABY: { usd: 0.01312, at: 1_790_634_730_000 },
    });
  });

  it('resolves keys requested by altname and skips everything unusable', () => {
    const withEth = buildAssetCatalog(rawAssets, {
      ...rawPairs.result,
      XETHXXBT: { altname: 'ETHXBT', wsname: 'ETH/XBT', base: 'XETH', quote: 'XXBT', status: 'online' },
    });
    const prices = normalizeTicker(
      {
        XBTUSD: { c: ['80000.0', '1'] },
        ETHXBT: { c: ['0.03', '1'] },
        UNKNOWNUSD: { c: ['1.0', '1'] },
        ETHUSD: { c: ['0', '1'] },
        SHIBUSD: { c: ['not a number', '1'] },
        BABYUSD: { c: [] },
        BROKEN: 'x',
      },
      withEth,
      5,
    );
    expect(prices).toEqual({ BTC: { usd: 80000, at: 5 } });
    for (const garbage of [null, undefined, 'x', 5, []]) expect(normalizeTicker(garbage, catalog, 1)).toEqual({});
  });
});

describe('normalizeOhlc', () => {
  it.each([
    ['XBTUSD 240', ohlcXbt240, 'XXBTZUSD'],
    ['ETHUSD 240', ohlcEth240, 'XETHZUSD'],
    ['XBTUSD 60', ohlcXbt60, 'XXBTZUSD'],
  ])('%s: ascending unique seconds, only the last row is the live forming candle', (_name, fixture, pairKey) => {
    const result = normalizeOhlc(fixture);
    const { candles } = result;
    expect(result.pairKey).toBe(pairKey);
    expect(candles).toHaveLength(721);
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.time).toBeGreaterThan(candles[i - 1]!.time);
    for (const candle of candles) expect(candle.time).toBeLessThan(1e11); // seconds, not milliseconds
    const live = candles.filter((c) => c.live);
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(candles.at(-1));
    expect(candles.at(-1)!.time).toBeGreaterThan(result.last!);
    expect(candles.at(-2)!.time).toBeLessThanOrEqual(result.last!);
    expect(candles.at(-2)!.live).toBeUndefined();
  });

  it('parses rows as [time, open, high, low, close, vwap, volume, count]', () => {
    const { candles, last } = normalizeOhlc(ohlcXbt240);
    expect(last).toBe(1790611200);
    expect(candles[0]).toEqual({
      time: 1780257600,
      open: 73451.1,
      high: 74070,
      low: 73363.6,
      close: 73570,
      volume: 106.81580314,
    });
    expect(candles.at(-1)).toMatchObject({ time: 1790625600, close: 83214.5, live: true });
  });

  it('sorts, dedupes by time (later row wins) and drops unusable rows', () => {
    const { candles } = normalizeOhlc({
      error: [],
      result: {
        XXBTZUSD: [
          [200, '2', '3', '1', '2.5', '2', '10', 5],
          [100, '1', '2', '0.5', '1.5', '1', '10', 5],
          [200, '2', '4', '1', '3', '2', '11', 6],
          [300, 'x', '1', '1', '1', '1', '1', 1],
          'garbage',
          [Number.NaN, '1', '1', '1', '1', '1', '1', 1],
        ],
        last: 200,
      },
    });
    expect(candles.map((c) => [c.time, c.close, c.volume])).toEqual([
      [100, 1.5, 10],
      [200, 3, 11],
    ]);
    expect(candles.some((c) => c.live)).toBe(false);
  });

  it('marks nothing live when the newest row is committed or "last" is missing', () => {
    const rows = [
      [100, '1', '1', '1', '1', '1', '1', 1],
      [200, '1', '1', '1', '1', '1', '1', 1],
    ];
    expect(normalizeOhlc({ XXBTZUSD: rows, last: 200 }).candles.some((c) => c.live)).toBe(false);
    expect(normalizeOhlc({ XXBTZUSD: rows }).candles.some((c) => c.live)).toBe(false);
    expect(normalizeOhlc({ XXBTZUSD: rows, last: 100 }).candles.map((c) => c.live)).toEqual([undefined, true]);
  });

  it('returns an empty result for garbage', () => {
    for (const garbage of [null, undefined, 'x', 5, [], {}, { last: 5 }]) {
      expect(normalizeOhlc(garbage).candles).toEqual([]);
    }
  });
});

describe('normalizeTradeVolume', () => {
  it('turns percent into fractions, keyed by the canonical pair', () => {
    expect(normalizeTradeVolume(tradeVolume, catalog)).toEqual({
      currency: 'ZUSD',
      volume30d: 612.1234,
      feeTier: {
        'BTC/USD': { taker: 0.004, maker: 0.0025 },
        'ETH/USD': { taker: 0.004, maker: 0.0025 },
      },
    });
  });

  it('accepts fees keyed by the requested altname instead of the AssetPairs key', () => {
    const byAltname = {
      error: [],
      result: {
        currency: 'ZUSD',
        volume: '10.0',
        fees: { XBTUSD: { fee: '0.3500' }, ETHUSD: { fee: '0.4000' } },
        fees_maker: { XBTUSD: { fee: '0.2000' }, ETHUSD: { fee: '0.2500' } },
      },
    };
    expect(normalizeTradeVolume(byAltname, catalog).feeTier).toEqual({
      'BTC/USD': { taker: 0.0035, maker: 0.002 },
      'ETH/USD': { taker: 0.004, maker: 0.0025 },
    });
  });

  it('uses the taker fee when a pair has no maker entry, and skips unknown pairs', () => {
    const result = normalizeTradeVolume(
      { fees: { XXBTZUSD: { fee: '0.2600' }, FOOUSD: { fee: '0.1' }, XETHZUSD: {} } },
      catalog,
    );
    expect(result.feeTier).toEqual({ 'BTC/USD': { taker: 0.0026, maker: 0.0026 } });
    expect(result.currency).toBeNull();
    expect(result.volume30d).toBeNull();
  });

  it('copes with a response without fee data', () => {
    expect(normalizeTradeVolume({ currency: 'ZUSD', volume: '0.0000' }, catalog).feeTier).toEqual({});
    expect(normalizeTradeVolume({ fees: [], fees_maker: [] }, catalog).feeTier).toEqual({});
    for (const garbage of [null, undefined, 'x', 5, []]) {
      expect(normalizeTradeVolume(garbage, catalog)).toEqual({ currency: null, volume30d: null, feeTier: {} });
    }
  });
});

describe('normalizeLedgerEntries', () => {
  const ledger = {
    error: [],
    result: {
      ledger: {
        LWDRAW: {
          refid: 'AAAA',
          time: 1790100000.5,
          type: 'withdrawal',
          subtype: '',
          aclass: 'currency',
          asset: 'XXBT',
          amount: '-0.0100000000',
          fee: '0.0005000000',
          balance: '0.0400000000',
        },
        LDEPOS: {
          refid: 'BBBB',
          time: 1790000000.1234,
          type: 'deposit',
          aclass: 'currency',
          asset: 'ZUSD',
          amount: '100.0000',
          fee: '0.0000',
          balance: '100.0000',
        },
        LTRADE: { refid: 'CCCC', time: 1790200000, type: 'trade', asset: 'XETH', amount: '0.1', fee: '0.0001' },
        LXFER: { refid: 'DDDD', time: 1790300000, type: 'transfer', asset: 'DOT.S', amount: '5.0', fee: '0' },
        LBAD1: { time: 'x', type: 'deposit', asset: 'ZUSD', amount: '1' },
        LBAD2: { time: 1790000001, type: 'deposit', asset: 'ZUSD' },
        LBAD3: 'x',
      },
      count: 7,
    },
  };

  it('maps every ledger entry, oldest first, keeping amount signs, refid and subtype', () => {
    expect(normalizeLedgerEntries(ledger, catalog)).toEqual([
      {
        ledgerId: 'LDEPOS',
        refid: 'BBBB',
        at: 1790000000123,
        type: 'deposit',
        subtype: null,
        asset: 'USD',
        amount: 100,
        fee: 0,
      },
      {
        ledgerId: 'LWDRAW',
        refid: 'AAAA',
        at: 1790100000500,
        type: 'withdrawal',
        subtype: null,
        asset: 'BTC',
        amount: -0.01,
        fee: 0.0005,
      },
      {
        ledgerId: 'LTRADE',
        refid: 'CCCC',
        at: 1790200000000,
        type: 'trade',
        subtype: null,
        asset: 'ETH',
        amount: 0.1,
        fee: 0.0001,
      },
      {
        ledgerId: 'LXFER',
        refid: 'DDDD',
        at: 1790300000000,
        type: 'transfer',
        subtype: null,
        asset: 'DOT',
        amount: 5,
        fee: 0,
      },
    ]);
  });

  it('derives the equity flows from deposits and withdrawals only', () => {
    expect(flowsOf(normalizeLedgerEntries(ledger, catalog))).toEqual([
      { ledgerId: 'LDEPOS', at: 1790000000123, type: 'deposit', asset: 'USD', amount: 100, fee: 0 },
      { ledgerId: 'LWDRAW', at: 1790100000500, type: 'withdrawal', asset: 'BTC', amount: -0.01, fee: 0.0005 },
    ]);
  });

  it('returns nothing for garbage or an empty ledger', () => {
    expect(normalizeLedgerEntries({ ledger: {}, count: 0 }, catalog)).toEqual([]);
    for (const garbage of [null, undefined, 'x', 5, [], {}])
      expect(normalizeLedgerEntries(garbage, catalog)).toEqual([]);
  });
});
