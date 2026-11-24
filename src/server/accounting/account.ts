// Account totals (docs/PLAN.md section 7, "Account figures"): from the Kraken balances when there are any, else
// estimated from the freshest bot wallet cache.
import type { AccountSnapshot, Asset, FtWalletView, KrakenBalanceEntry, KrakenWallet, Ms } from '@/shared/types/domain';

export const USD: Asset = 'USD';

export interface AccountInput {
  /** Balances as of `balancesAt`; null (or empty) when there is no usable Kraken data. */
  kraken: { balances: KrakenBalanceEntry[]; balancesAt: Ms } | null;
  /** Freqtrade wallet views of all bots, used only when there are no Kraken balances. */
  wallets: FtWalletView[];
  /** Fresh public prices in USD. */
  prices: Record<Asset, number>;
}

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function priceOf(asset: Asset, prices: Record<Asset, number>, fallback: number | null): number | null {
  if (asset === USD) return 1;
  const p = prices[asset];
  if (positive(p)) return p;
  return positive(fallback) ? fallback : null;
}

function valueEntry(e: KrakenBalanceEntry, prices: Record<Asset, number>): KrakenBalanceEntry {
  const price = priceOf(e.asset, prices, e.priceUsd);
  return { ...e, priceUsd: price, valueUsd: price === null ? null : e.total * price };
}

function fromKraken(kraken: NonNullable<AccountInput['kraken']>, prices: Record<Asset, number>): AccountSnapshot {
  return snapshot(
    'kraken',
    null,
    kraken.balancesAt,
    kraken.balances.map((e) => valueEntry(e, prices)),
  );
}

function fromWallet(w: FtWalletView, prices: Record<Asset, number>): AccountSnapshot {
  const holdings = w.currencies.map((c): KrakenBalanceEntry => {
    const implied = c.balance > 0 && c.estStakeUsd !== null ? c.estStakeUsd / c.balance : null;
    const wallet: KrakenWallet = 'spot';
    const price = priceOf(c.currency, prices, implied);
    return {
      asset: c.currency,
      krakenAsset: c.currency,
      wallet,
      total: c.balance,
      hold: c.used,
      available: c.free,
      priceUsd: price,
      valueUsd: price === null ? null : c.balance * price,
    };
  });
  return snapshot('bot-wallet', w.botId, w.lastWalletSyncAt ?? w.fetchedAt, holdings);
}

function snapshot(
  source: AccountSnapshot['source'],
  estimatedFromBot: string | null,
  asOf: Ms,
  holdings: KrakenBalanceEntry[],
): AccountSnapshot {
  let totalUsd = 0;
  let usdCash = 0;
  let usdAvailable: number | null = null;
  const unpriced = new Set<Asset>();
  for (const h of holdings) {
    if (h.valueUsd === null) {
      if (h.total > 0) unpriced.add(h.asset);
      continue;
    }
    totalUsd += h.valueUsd;
    if (h.asset === USD) {
      usdCash += h.total;
      if (h.wallet === 'spot') usdAvailable = (usdAvailable ?? 0) + h.available;
    }
  }
  return { source, estimatedFromBot, asOf, totalUsd, usdCash, usdAvailable, holdings, unpricedAssets: [...unpriced] };
}

/** The wallet with the latest log-tail sync, else the latest fetch; null when no bot has a wallet. */
export function freshestWallet(wallets: readonly FtWalletView[]): FtWalletView | null {
  let best: FtWalletView | null = null;
  const synced = wallets.filter((w) => w.lastWalletSyncAt !== null);
  const pool = synced.length > 0 ? synced : wallets;
  for (const w of pool) {
    const key = (x: FtWalletView): Ms => (synced.length > 0 ? (x.lastWalletSyncAt ?? 0) : x.fetchedAt);
    if (best === null || key(w) > key(best)) best = w;
  }
  return best;
}

/**
 * Account total. Kraken mode sums every wallet of every held asset at its USD price (USD counts at 1); assets without
 * a price are listed in `unpricedAssets` and left out of the total. Without Kraken balances the quantities of the
 * freshest bot wallet are valued at the public prices instead (`source: 'bot-wallet'`).
 */
export function buildAccountSnapshot(input: AccountInput): AccountSnapshot | null {
  if (input.kraken !== null && input.kraken.balances.length > 0) return fromKraken(input.kraken, input.prices);
  const wallet = freshestWallet(input.wallets);
  return wallet === null ? null : fromWallet(wallet, input.prices);
}

export interface AssetHolding {
  asset: Asset;
  total: number;
  hold: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** One row per asset, all wallets summed. Value is null when any part of the asset is unpriced. */
export function holdingsByAsset(snap: Pick<AccountSnapshot, 'holdings'>): Map<Asset, AssetHolding> {
  const out = new Map<Asset, AssetHolding>();
  for (const h of snap.holdings) {
    const cur = out.get(h.asset) ?? {
      asset: h.asset,
      total: 0,
      hold: 0,
      priceUsd: h.priceUsd,
      valueUsd: 0 as number | null,
    };
    cur.total += h.total;
    cur.hold += h.hold;
    cur.priceUsd = cur.priceUsd ?? h.priceUsd;
    cur.valueUsd = cur.valueUsd === null || h.valueUsd === null ? null : cur.valueUsd + h.valueUsd;
    out.set(h.asset, cur);
  }
  return out;
}
