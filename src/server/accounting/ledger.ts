// What the Kraken ledger says about one asset that the order history does not (the "Positions" cost basis).
//
// Orders already cover every ledger entry of type `trade`, so those are skipped. What is left:
//  * `spend` / `receive` pairs (Kraken's Buy Crypto and Convert): both legs share a `refid`. A USD leg against the asset
//    leg is an exact buy or sell. A crypto-to-crypto convert has no USD figure, so it is an unpriced inflow.
//  * Quantity that arrived with no price: deposits, transfers in (airdrops), staking and earn rewards, credits.
// Entry types and subtypes follow Kraken's ledger documentation; anything unrecognised is an unpriced `other` inflow,
// never a buy, so a wrong guess can only hide cost, not invent it.
import type { Asset, KrakenOrder, LedgerEntry, Ms, Side } from '@/shared/types/domain';
import { USD } from './account';

export type InflowKind = 'deposit' | 'transfer' | 'reward' | 'convert' | 'other';

/** A priced buy or sell read from a spend/receive pair. `costUsd` excludes `feeUsd`, like a Kraken order. */
export interface LedgerTrade {
  refid: string;
  at: Ms;
  side: Side;
  qty: number;
  costUsd: number;
  feeUsd: number;
}
export interface LedgerInflow {
  ledgerId: string;
  at: Ms;
  kind: InflowKind;
  qty: number;
}
export interface LedgerReading {
  trades: LedgerTrade[];
  inflows: LedgerInflow[];
}

/** Moves between a user's own wallets (spot, staking, earn, futures) change no ownership. */
const INTERNAL = ['staking', 'futures', 'allocation', 'migration', 'earn'];
const isInternal = (subtype: string | null): boolean => {
  const s = (subtype ?? '').toLowerCase();
  return INTERNAL.some((k) => s.includes(k));
};

/** A ledger buy or sell that an order already records (same side and size, within two minutes) is not counted twice. */
const DUPLICATE_WINDOW_MS = 120_000;
function matchesOrder(t: LedgerTrade, asset: Asset, orders: readonly KrakenOrder[]): boolean {
  return orders.some(
    (o) =>
      o.pair === `${asset}/${USD}` &&
      o.side === t.side &&
      Math.abs(o.volExec - t.qty) <= 1e-6 * Math.max(t.qty, 1e-12) &&
      Math.abs((o.closedAt ?? o.openedAt) - t.at) <= DUPLICATE_WINDOW_MS,
  );
}

function inflowKind(e: LedgerEntry): InflowKind | null {
  if (e.amount <= 0) return null;
  switch (e.type) {
    case 'trade':
    case 'withdrawal':
    case 'margin':
    case 'rollover':
    case 'spend':
    case 'receive':
      return null;
    case 'deposit':
      return 'deposit';
    case 'staking':
    case 'dividend':
      return 'reward';
    case 'earn':
      return (e.subtype ?? '').toLowerCase().includes('reward') ? 'reward' : null;
    case 'transfer':
      return isInternal(e.subtype) ? null : 'transfer';
    default:
      return 'other';
  }
}

export function readLedger(
  asset: Asset,
  entries: readonly LedgerEntry[],
  orders: readonly KrakenOrder[],
): LedgerReading {
  const out: LedgerReading = { trades: [], inflows: [] };
  if (asset === USD) return out;

  const pairs = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.type === 'spend' || e.type === 'receive') {
      if (e.refid === null) continue;
      pairs.set(e.refid, [...(pairs.get(e.refid) ?? []), e]);
      continue;
    }
    if (e.asset !== asset) continue;
    const kind = inflowKind(e);
    if (kind !== null) out.inflows.push({ ledgerId: e.ledgerId, at: e.at, kind, qty: e.amount - e.fee });
  }

  for (const [refid, legs] of pairs) {
    const mine = legs.filter((l) => l.asset === asset);
    if (mine.length !== 1) continue;
    const leg = mine[0] as LedgerEntry;
    const usd = legs.filter((l) => l.asset === USD);
    const others = legs.filter((l) => l.asset !== USD && l.asset !== asset);
    if (usd.length === 1 && others.length === 0) {
      const u = usd[0] as LedgerEntry;
      // The balance moves by `amount - fee` on each leg, so a received asset is net of its fee and a sold one is gross.
      const trade: LedgerTrade =
        leg.amount > 0
          ? { refid, at: leg.at, side: 'buy', qty: leg.amount - leg.fee, costUsd: Math.abs(u.amount), feeUsd: u.fee }
          : { refid, at: leg.at, side: 'sell', qty: Math.abs(leg.amount) + leg.fee, costUsd: u.amount, feeUsd: u.fee };
      if (trade.qty > 0 && !matchesOrder(trade, asset, orders)) out.trades.push(trade);
    } else if (leg.amount > 0) {
      out.inflows.push({ ledgerId: leg.ledgerId, at: leg.at, kind: 'convert', qty: leg.amount - leg.fee });
    }
  }
  out.trades.sort((a, b) => a.at - b.at || a.refid.localeCompare(b.refid));
  out.inflows.sort((a, b) => a.at - b.at || a.ledgerId.localeCompare(b.ledgerId));
  return out;
}
