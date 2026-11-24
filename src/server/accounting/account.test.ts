import { describe, expect, it } from 'vitest';
import type { FtWalletView } from '@/shared/types/domain';
import { balance } from '../../../test/fixtures/incident/builders';
import { buildAccountSnapshot, freshestWallet, holdingsByAsset } from './account';

function wallet(
  botId: string,
  fetchedAt: number,
  lastWalletSyncAt: number | null,
  eth: number,
  usd = 100,
): FtWalletView {
  const cur = (currency: string, balanceQty: number, est: number | null) => ({
    currency,
    balance: balanceQty,
    free: balanceQty,
    used: 0,
    botOwned: null,
    estStakeUsd: est,
    isBotManaged: false,
  });
  return {
    botId,
    fetchedAt,
    lastWalletSyncAt,
    totalUsd: 0,
    currencies: [cur('USD', usd, usd), cur('ETH', eth, eth * 2500), cur('WEIRD', 2, null)],
  };
}

describe('buildAccountSnapshot (Kraken mode)', () => {
  it('sums every wallet of every asset at its USD price and lists unpriced assets', () => {
    const snap = buildAccountSnapshot({
      kraken: {
        balancesAt: 1234,
        balances: [
          balance('USD', 300, 1),
          balance('ETH', 0.1, null),
          balance('ETH', 0.05, null, { wallet: 'earn', krakenAsset: 'ETH.F' }),
          balance('BABY', 5, null),
          balance('ZERO', 0, null),
        ],
      },
      wallets: [],
      prices: { USD: 1, ETH: 2500 },
    })!;
    expect(snap.source).toBe('kraken');
    expect(snap.estimatedFromBot).toBeNull();
    expect(snap.asOf).toBe(1234);
    expect(snap.totalUsd).toBeCloseTo(300 + 0.15 * 2500, 9);
    expect(snap.usdCash).toBe(300);
    expect(snap.usdAvailable).toBe(300);
    expect(snap.unpricedAssets).toEqual(['BABY']);
    expect(snap.holdings.find((h) => h.krakenAsset === 'ETH.F')?.valueUsd).toBeCloseTo(125, 9);
  });

  it('falls back to the balance entry price when the ticker has none, and prefers the ticker otherwise', () => {
    const snap = buildAccountSnapshot({
      kraken: { balancesAt: 1, balances: [balance('ETH', 1, 2000), balance('BTC', 1, 50_000)] },
      wallets: [],
      prices: { BTC: 60_000, ETH: 0 },
    })!;
    expect(snap.holdings.find((h) => h.asset === 'ETH')?.priceUsd).toBe(2000);
    expect(snap.holdings.find((h) => h.asset === 'BTC')?.priceUsd).toBe(60_000);
    expect(snap.unpricedAssets).toEqual([]);
  });

  it('leaves usdAvailable null without a spot USD entry', () => {
    const snap = buildAccountSnapshot({
      kraken: { balancesAt: 1, balances: [balance('USD', 5, 1, { wallet: 'earn' })] },
      wallets: [],
      prices: {},
    })!;
    expect(snap.usdAvailable).toBeNull();
    expect(snap.usdCash).toBe(5);
  });
});

describe('buildAccountSnapshot (freqtrade-only estimate)', () => {
  it('uses the wallet with the latest log-tail sync, valued at the public prices', () => {
    const snap = buildAccountSnapshot({
      kraken: null,
      wallets: [wallet('votemax', 9000, 1000, 0), wallet('dca', 5000, 4000, 0.1)],
      prices: { ETH: 2600 },
    })!;
    expect(snap.source).toBe('bot-wallet');
    expect(snap.estimatedFromBot).toBe('dca');
    expect(snap.asOf).toBe(4000);
    expect(snap.totalUsd).toBeCloseTo(100 + 260, 9);
    expect(snap.unpricedAssets).toEqual(['WEIRD']);
  });

  it('takes the latest fetch when no wallet has a sync time, and asOf is then the fetch time', () => {
    const snap = buildAccountSnapshot({
      kraken: null,
      wallets: [wallet('a', 100, null, 1), wallet('b', 200, null, 2)],
      prices: {},
    })!;
    expect(snap.estimatedFromBot).toBe('b');
    expect(snap.asOf).toBe(200);
    // no ticker: the wallet's own estimate (est_stake / balance) prices ETH
    expect(snap.holdings.find((h) => h.asset === 'ETH')?.priceUsd).toBe(2500);
  });

  it('treats an empty Kraken balance list as no Kraken data and returns null without any wallet', () => {
    expect(buildAccountSnapshot({ kraken: { balances: [], balancesAt: 0 }, wallets: [], prices: {} })).toBeNull();
    const snap = buildAccountSnapshot({
      kraken: { balances: [], balancesAt: 0 },
      wallets: [wallet('a', 1, 1, 1)],
      prices: {},
    });
    expect(snap?.source).toBe('bot-wallet');
  });

  it('freshestWallet picks by sync time, then fetch time, and is null for none', () => {
    expect(freshestWallet([])).toBeNull();
    const a = wallet('a', 10, 5, 0);
    const b = wallet('b', 99, null, 0);
    expect(freshestWallet([a, b])?.botId).toBe('a');
  });
});

describe('holdingsByAsset', () => {
  it('sums wallets per asset and nulls the value when any part is unpriced', () => {
    const m = holdingsByAsset({
      holdings: [
        balance('ETH', 1, 2000),
        balance('ETH', 2, 2000, { wallet: 'earn' }),
        balance('X', 1, null),
        balance('X', 1, 5),
      ],
    });
    expect(m.get('ETH')).toMatchObject({ total: 3, valueUsd: 6000, priceUsd: 2000 });
    expect(m.get('X')?.valueUsd).toBeNull();
    expect(m.get('X')?.priceUsd).toBe(5);
  });
});
