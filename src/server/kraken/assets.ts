import type { Asset, KrakenWallet, Pair } from '@/shared/types/domain';
import { isRecord, toNumber, unwrapResult } from './types';

// Asset and pair catalog built from the public `Assets` and `AssetPairs` responses (docs/PLAN.md section 6.3).
// Pure: the caller fetches, this module only maps names.

/** Kraken's legacy X/Z prefixed codes and the XBT/XDG oddities, mapped to the tickers freqtrade uses. */
const STATIC_ALIASES: ReadonlyMap<string, Asset> = new Map([
  ['XXBT', 'BTC'],
  ['XBT', 'BTC'],
  ['XETH', 'ETH'],
  ['ZUSD', 'USD'],
  ['XXDG', 'DOGE'],
  ['XDG', 'DOGE'],
  ['ZEUR', 'EUR'],
]);

/** `.F` = opt-in rewards (earn), `.S/.M/.B` = staked variants, `.T/.HOLD` = balances that are not freely spendable. */
const SUFFIX_WALLET: ReadonlyMap<string, KrakenWallet> = new Map([
  ['F', 'earn'],
  ['S', 'staked'],
  ['M', 'staked'],
  ['B', 'staked'],
  ['T', 'other'],
  ['HOLD', 'other'],
]);
const SUFFIX_RE = /^(.+)\.(F|S|M|B|T|HOLD)$/;

export interface ParsedAsset {
  asset: Asset;
  wallet: KrakenWallet;
  /** The code without its wallet suffix (`XBT` for `XBT.F`), before aliasing. */
  baseKrakenAsset: string;
}

export interface ResolvedAsset extends ParsedAsset {
  /** The code exactly as Kraken sent it (`ETH.F`). */
  krakenAsset: string;
}

export interface ResolvedPair {
  /** Canonical, freqtrade style: `BTC/USD`. */
  pair: Pair;
  /** AssetPairs key: `XXBTZUSD`. */
  key: string;
  /** What order responses and most requests use: `XBTUSD`. */
  altname: string;
  /** Websocket name: `XBT/USD`. */
  wsname: string | null;
  base: Asset;
  quote: Asset;
  krakenBase: string;
  krakenQuote: string;
  status: string | null;
  pairDecimals: number | null;
  lotDecimals: number | null;
  orderMin: number | null;
  costMin: number | null;
}

export interface AssetCatalog {
  /** Strips the wallet suffix, applies aliases and the catalog's altnames. Unknown assets give null, never throw. */
  resolveAsset(krakenAsset: string): ResolvedAsset | null;
  /** Looks a pair up by AssetPairs key, altname, wsname or canonical name. Unknown gives null. */
  resolvePair(name: string): ResolvedPair | null;
  pairs(): ResolvedPair[];
  /** Altnames (`XBTUSD`) of the tradable `<ASSET>/USD` pairs for the given assets, for `Ticker`. */
  tickerPairsFor(assets: Iterable<Asset>): string[];
}

/**
 * Catalog-free parsing: wallet suffix and static aliases only. This is what the balance normalizer falls back to for
 * assets the catalog does not know, so a holding is never dropped just because `Assets` was stale.
 */
export function parseKrakenAsset(code: string): ParsedAsset {
  const raw = code.trim().toUpperCase();
  const match = SUFFIX_RE.exec(raw);
  const baseKrakenAsset = match ? (match[1] ?? raw) : raw;
  const wallet = (match && SUFFIX_WALLET.get(match[2] ?? '')) || 'spot';
  return { asset: STATIC_ALIASES.get(baseKrakenAsset) ?? baseKrakenAsset, wallet, baseKrakenAsset };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const UNTRADABLE_STATUSES = new Set(['cancel_only', 'delisted', 'post_only', 'limit_only', 'reduce_only']);

export function buildAssetCatalog(rawAssets: unknown, rawPairs: unknown): AssetCatalog {
  const assetsResult = unwrapResult(rawAssets);
  const pairsResult = unwrapResult(rawPairs);

  // Assets: key (`XXBT`) -> altname (`XBT`).
  const altnameByKey = new Map<string, string>();
  const altnames = new Set<string>();
  if (isRecord(assetsResult)) {
    for (const [key, value] of Object.entries(assetsResult)) {
      const altname = (isRecord(value) ? str(value.altname) : null) ?? key;
      altnameByKey.set(key.toUpperCase(), altname.toUpperCase());
      altnames.add(altname.toUpperCase());
    }
  }

  const resolveAsset = (code: string): ResolvedAsset | null => {
    if (typeof code !== 'string' || code.trim() === '') return null;
    const parsed = parseKrakenAsset(code);
    const base = parsed.baseKrakenAsset;
    let asset: Asset | undefined = STATIC_ALIASES.get(base);
    if (asset === undefined) {
      const altname = altnameByKey.get(base);
      if (altname !== undefined) asset = STATIC_ALIASES.get(altname) ?? altname;
      else if (altnames.has(base)) asset = base;
    }
    return asset === undefined ? null : { ...parsed, asset, krakenAsset: code };
  };
  const assetOf = (code: string): Asset => resolveAsset(code)?.asset ?? parseKrakenAsset(code).asset;

  const pairList: ResolvedPair[] = [];
  const byName = new Map<string, ResolvedPair>();
  if (isRecord(pairsResult)) {
    // Dark-pool variants (`XXBTZUSD.d`) share names with the main pair: index the main ones first, first one wins.
    const entries = Object.entries(pairsResult).sort(([a], [b]) => Number(a.endsWith('.d')) - Number(b.endsWith('.d')));
    for (const [key, value] of entries) {
      if (!isRecord(value)) continue;
      const krakenBase = str(value.base);
      const krakenQuote = str(value.quote);
      if (krakenBase === null || krakenQuote === null) continue;
      const base = assetOf(krakenBase);
      const quote = assetOf(krakenQuote);
      const resolved: ResolvedPair = {
        pair: `${base}/${quote}`,
        key,
        altname: str(value.altname) ?? key,
        wsname: str(value.wsname),
        base,
        quote,
        krakenBase,
        krakenQuote,
        status: str(value.status),
        pairDecimals: toNumber(value.pair_decimals),
        lotDecimals: toNumber(value.lot_decimals),
        orderMin: toNumber(value.ordermin),
        costMin: toNumber(value.costmin),
      };
      pairList.push(resolved);
      const isDark = key.endsWith('.d');
      const names = [resolved.key, resolved.altname, resolved.wsname, isDark ? null : resolved.pair];
      for (const name of names) {
        if (name !== null && !byName.has(name.toUpperCase())) byName.set(name.toUpperCase(), resolved);
      }
    }
  }

  return {
    resolveAsset,
    resolvePair: (name) => (typeof name === 'string' ? (byName.get(name.trim().toUpperCase()) ?? null) : null),
    pairs: () => [...pairList],
    tickerPairsFor: (assets) => {
      const wanted = new Set(assets);
      const out = new Set<string>();
      for (const pair of pairList) {
        if (pair.quote !== 'USD' || !wanted.has(pair.base)) continue;
        if (pair.key.endsWith('.d') || (pair.status !== null && UNTRADABLE_STATUSES.has(pair.status))) continue;
        out.add(pair.altname);
      }
      return [...out].sort();
    },
  };
}

/** A catalog that knows nothing: normalizers still work (pairs become null, assets fall back to static parsing). */
export function emptyAssetCatalog(): AssetCatalog {
  return buildAssetCatalog(null, null);
}
