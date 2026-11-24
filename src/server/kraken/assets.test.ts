import { describe, expect, it } from 'vitest';
import rawAssets from '../../../test/fixtures/raw/kraken/public/Assets.json';
import rawPairs from '../../../test/fixtures/raw/kraken/public/AssetPairs.json';
import { buildAssetCatalog, emptyAssetCatalog, parseKrakenAsset } from './assets';

const catalog = buildAssetCatalog(rawAssets, rawPairs);

describe('parseKrakenAsset (no catalog)', () => {
  it.each([
    ['XXBT', 'BTC', 'spot'],
    ['XBT', 'BTC', 'spot'],
    ['XETH', 'ETH', 'spot'],
    ['ZUSD', 'USD', 'spot'],
    ['XXDG', 'DOGE', 'spot'],
    ['XDG', 'DOGE', 'spot'],
    ['ZEUR', 'EUR', 'spot'],
    ['SHIB', 'SHIB', 'spot'],
    ['xbt.f', 'BTC', 'earn'],
    ['ETH.F', 'ETH', 'earn'],
    ['DOT.S', 'DOT', 'staked'],
    ['XBT.M', 'BTC', 'staked'],
    ['ETH2.B', 'ETH2', 'staked'],
    ['ADA.T', 'ADA', 'other'],
    ['USD.HOLD', 'USD', 'other'],
    ['ZUSD.HOLD', 'USD', 'other'],
  ])('%s -> %s (%s)', (code, asset, wallet) => {
    expect(parseKrakenAsset(code)).toMatchObject({ asset, wallet });
  });

  it('keeps the suffix-free Kraken code', () => {
    expect(parseKrakenAsset('XBT.F').baseKrakenAsset).toBe('XBT');
  });

  it('does not treat unknown suffixes as wallets', () => {
    expect(parseKrakenAsset('FOO.X')).toMatchObject({ asset: 'FOO.X', wallet: 'spot' });
  });
});

describe('buildAssetCatalog assets', () => {
  it.each([
    ['XXBT', 'BTC'],
    ['XBT', 'BTC'],
    ['XETH', 'ETH'],
    ['ETH', 'ETH'],
    ['ZUSD', 'USD'],
    ['USD', 'USD'],
    ['SHIB', 'SHIB'],
    ['BABY', 'BABY'],
  ])('resolves %s to %s', (code, asset) => {
    expect(catalog.resolveAsset(code)).toMatchObject({ asset, wallet: 'spot', krakenAsset: code });
  });

  it('resolves wallet-suffixed codes through the catalog', () => {
    expect(catalog.resolveAsset('ETH.F')).toEqual({
      asset: 'ETH',
      wallet: 'earn',
      krakenAsset: 'ETH.F',
      baseKrakenAsset: 'ETH',
    });
    expect(catalog.resolveAsset('XBT.F')).toMatchObject({ asset: 'BTC', wallet: 'earn' });
    expect(catalog.resolveAsset('USD.HOLD')).toMatchObject({ asset: 'USD', wallet: 'other' });
  });

  it('uses altnames from the catalog for assets without a static alias', () => {
    const custom = buildAssetCatalog(
      {
        XXRP: { altname: 'XRP' },
        XLTC: { altname: 'LTC' },
        XXDG: { altname: 'XDG' },
        DOT: { altname: 'DOT' },
        'DOT.S': { altname: 'DOT.S' },
      },
      {},
    );
    expect(custom.resolveAsset('XXRP')).toMatchObject({ asset: 'XRP' });
    expect(custom.resolveAsset('XRP')).toMatchObject({ asset: 'XRP' });
    expect(custom.resolveAsset('XLTC')).toMatchObject({ asset: 'LTC' });
    expect(custom.resolveAsset('XXDG')).toMatchObject({ asset: 'DOGE' });
    expect(custom.resolveAsset('DOT.S')).toMatchObject({ asset: 'DOT', wallet: 'staked' });
    expect(custom.resolveAsset('DOT.F')).toMatchObject({ asset: 'DOT', wallet: 'earn' });
    expect(custom.resolveAsset('DOT.T')).toMatchObject({ asset: 'DOT', wallet: 'other' });
    expect(custom.resolveAsset('DOT.M')).toMatchObject({ wallet: 'staked' });
    expect(custom.resolveAsset('DOT.B')).toMatchObject({ wallet: 'staked' });
  });

  it('returns null for unknown assets instead of throwing', () => {
    for (const code of ['FOO', 'FOO.F', '', '   ', 'XXXX']) expect(catalog.resolveAsset(code)).toBeNull();
    expect(catalog.resolveAsset(undefined as never)).toBeNull();
    expect(catalog.resolveAsset(42 as never)).toBeNull();
  });
});

describe('buildAssetCatalog pairs', () => {
  it.each(['XBTUSD', 'XXBTZUSD', 'XBT/USD', 'BTC/USD', 'xbtusd', ' XBT/USD '])('resolves %j to BTC/USD', (name) => {
    expect(catalog.resolvePair(name)).toMatchObject({ pair: 'BTC/USD', key: 'XXBTZUSD', altname: 'XBTUSD' });
  });

  it.each([
    ['ETHUSD', 'ETH/USD'],
    ['XETHZUSD', 'ETH/USD'],
    ['ETH/USD', 'ETH/USD'],
    ['SHIBUSD', 'SHIB/USD'],
    ['SHIB/USD', 'SHIB/USD'],
    ['BABYUSD', 'BABY/USD'],
  ])('resolves %s to %s', (name, pair) => {
    expect(catalog.resolvePair(name)?.pair).toBe(pair);
  });

  it('exposes pair details', () => {
    expect(catalog.resolvePair('XXBTZUSD')).toEqual({
      pair: 'BTC/USD',
      key: 'XXBTZUSD',
      altname: 'XBTUSD',
      wsname: 'XBT/USD',
      base: 'BTC',
      quote: 'USD',
      krakenBase: 'XXBT',
      krakenQuote: 'ZUSD',
      status: 'online',
      pairDecimals: 1,
      lotDecimals: 8,
      orderMin: 0.00005,
      costMin: 0.5,
    });
    expect(
      catalog
        .pairs()
        .map((p) => p.pair)
        .sort(),
    ).toEqual(['BABY/USD', 'BTC/USD', 'ETH/USD', 'SHIB/USD']);
  });

  it('returns null for unknown pairs instead of throwing', () => {
    for (const name of ['FOOUSD', 'BTC/EUR', '', 'XBT', undefined as never, null as never]) {
      expect(catalog.resolvePair(name)).toBeNull();
    }
  });

  it('lists the altnames of tradable USD pairs for the requested assets, for Ticker', () => {
    expect(catalog.tickerPairsFor(['BTC', 'ETH', 'SHIB', 'DOGE'])).toEqual(['ETHUSD', 'SHIBUSD', 'XBTUSD']);
    expect(catalog.tickerPairsFor(new Set(['BABY']))).toEqual(['BABYUSD']);
    expect(catalog.tickerPairsFor([])).toEqual([]);
    expect(catalog.tickerPairsFor(['USD'])).toEqual([]);
  });

  it('skips pairs that cannot trade and never lets a dark-pool pair shadow the main one', () => {
    const custom = buildAssetCatalog(
      {},
      {
        'XXBTZUSD.d': { altname: 'XBTUSD.d', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
        XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
        OLDUSD: { altname: 'OLDUSD', wsname: 'OLD/USD', base: 'OLD', quote: 'ZUSD', status: 'cancel_only' },
        BROKEN: { altname: 'BROKEN' },
        NOTANOBJECT: 'x',
      },
    );
    expect(custom.resolvePair('XBT/USD')?.key).toBe('XXBTZUSD');
    expect(custom.resolvePair('BTC/USD')?.key).toBe('XXBTZUSD');
    expect(custom.resolvePair('XBTUSD.d')?.key).toBe('XXBTZUSD.d');
    expect(custom.resolvePair('BROKEN')).toBeNull();
    expect(custom.tickerPairsFor(['BTC', 'OLD'])).toEqual(['XBTUSD']);
  });
});

describe('robustness', () => {
  it.each([[null], [undefined], ['x'], [42], [[]], [{ error: ['EGeneral:Internal error'] }]])(
    'builds an empty catalog from %j without throwing',
    (garbage) => {
      const empty = buildAssetCatalog(garbage, garbage);
      expect(empty.pairs()).toEqual([]);
      expect(empty.resolvePair('XBTUSD')).toBeNull();
      expect(empty.tickerPairsFor(['BTC'])).toEqual([]);
    },
  );

  it('accepts bare results as well as full envelopes', () => {
    const bare = buildAssetCatalog(rawAssets.result, rawPairs.result);
    expect(bare.resolvePair('XBTUSD')?.pair).toBe('BTC/USD');
    expect(bare.resolveAsset('XXBT')?.asset).toBe('BTC');
  });

  it('an empty catalog still resolves the static aliases', () => {
    expect(emptyAssetCatalog().resolveAsset('XXBT')).toMatchObject({ asset: 'BTC' });
    expect(emptyAssetCatalog().resolveAsset('SHIB')).toBeNull();
  });
});
