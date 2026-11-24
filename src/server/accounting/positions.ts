// Cost basis for holdings labelled `manual` (the "Positions" view). Derived, never entered: the average cost of the
// Kraken orders no bot owns. Method is average cost, buy fees included in the basis, sell fees deducted from proceeds.
import type {
  Acknowledgement,
  Allocation,
  Asset,
  KrakenOrder,
  LedgerEntry,
  ManualPosition,
} from '@/shared/types/domain';
import { USD } from './account';
import { readLedger, type InflowKind } from './ledger';

export interface PositionsInput {
  allocation: Allocation;
  /** Active asset acknowledgements; only `manual` ones become positions. */
  acks: readonly Acknowledgement[];
  /** Kraken orders, any order and status; the function selects what it needs. */
  orders: readonly KrakenOrder[];
  /** Orders to leave out: those a bot owns, and those acknowledged as ignored. */
  excludeTxids: ReadonlySet<string>;
  /** The Kraken ledger (any type); optional, without it only orders price a position. */
  ledger?: readonly LedgerEntry[];
}

interface Replay {
  qty: number;
  /** Cost at fill prices; `cost` adds the buy fees. */
  gross: number;
  cost: number;
  realizedUsd: number;
  feesUsd: number;
  orders: number;
  ledgerTrades: number;
  firstBuyAt: number | null;
  lastBuyAt: number | null;
  /** Unpriced quantity that arrived through the ledger, by source. */
  inflows: ManualPosition['inflows'];
}

/** One executed buy or sell, from an order or from the ledger. */
interface Fill {
  at: number;
  side: 'buy' | 'sell';
  qty: number;
  costUsd: number;
  feeUsd: number;
  fromLedger: boolean;
  /** Order txid or ledger refid: a stable tiebreak for fills at the same time. */
  key: string;
}

const EPS = 1e-12;
const INFLOW_ORDER: readonly InflowKind[] = ['deposit', 'transfer', 'reward', 'convert', 'other'];

/**
 * Replays the non-bot spot activity of one asset against USD, oldest first: Kraken orders, plus (when given) the
 * ledger's Buy Crypto/Convert trades that have no order. Ledger inflows without a price are only totalled by source.
 */
export function replayAsset(
  asset: Asset,
  orders: readonly KrakenOrder[],
  excludeTxids: ReadonlySet<string>,
  ledger: readonly LedgerEntry[] = [],
): Replay {
  const r: Replay = {
    qty: 0,
    gross: 0,
    cost: 0,
    realizedUsd: 0,
    feesUsd: 0,
    orders: 0,
    ledgerTrades: 0,
    firstBuyAt: null,
    lastBuyAt: null,
    inflows: [],
  };
  const fills: Fill[] = orders
    .filter((o) => {
      if (o.volExec <= 0 || excludeTxids.has(o.txid) || o.pair === null) return false;
      const [base, quote] = o.pair.split('/');
      return base === asset && quote === USD;
    })
    .map((o) => ({
      at: o.closedAt ?? o.openedAt,
      side: o.side,
      qty: o.volExec,
      costUsd: o.costUsd,
      feeUsd: o.feeUsd,
      fromLedger: false,
      key: o.txid,
    }));
  const reading = readLedger(asset, ledger, orders);
  for (const t of reading.trades) {
    fills.push({
      at: t.at,
      side: t.side,
      qty: t.qty,
      costUsd: t.costUsd,
      feeUsd: t.feeUsd,
      fromLedger: true,
      key: t.refid,
    });
  }
  fills.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));

  for (const f of fills) {
    r.orders += 1;
    if (f.fromLedger) r.ledgerTrades += 1;
    r.feesUsd += f.feeUsd;
    if (f.side === 'buy') {
      r.qty += f.qty;
      r.gross += f.costUsd;
      r.cost += f.costUsd + f.feeUsd;
      r.firstBuyAt ??= f.at;
      r.lastBuyAt = f.at;
      continue;
    }
    // A sell of more than the replay holds sold units bought before the history starts: only the known part has a basis.
    const sold = Math.min(f.qty, r.qty);
    const avg = r.qty > EPS ? r.cost / r.qty : 0;
    const avgGross = r.qty > EPS ? r.gross / r.qty : 0;
    const share = f.qty > 0 ? sold / f.qty : 0;
    r.realizedUsd += (f.costUsd - f.feeUsd) * share - avg * sold;
    r.qty -= sold;
    r.cost -= avg * sold;
    r.gross -= avgGross * sold;
    if (r.qty < EPS) {
      r.qty = 0;
      r.cost = 0;
      r.gross = 0;
    }
  }

  const bySource = new Map<InflowKind, number>();
  for (const i of reading.inflows) bySource.set(i.kind, (bySource.get(i.kind) ?? 0) + i.qty);
  r.inflows = INFLOW_ORDER.filter((kind) => (bySource.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    qty: bySource.get(kind) ?? 0,
  }));
  return r;
}

export function buildManualPositions(input: PositionsInput): ManualPosition[] {
  const manual = new Map(input.acks.filter((a) => a.kind === 'asset' && a.label === 'manual').map((a) => [a.id, a]));
  const out: ManualPosition[] = [];
  for (const h of input.allocation.holdings) {
    const ack = h.ackId === null ? undefined : manual.get(h.ackId);
    const qty = h.acknowledgedQty ?? 0;
    if (ack === undefined || qty <= 0 || h.asset === USD) continue;

    const price = h.valueUsd !== null && h.total > 0 ? h.valueUsd / h.total : null;
    const replay = replayAsset(h.asset, input.orders, input.excludeTxids, input.ledger);
    const basisQty = Math.min(qty, replay.qty);
    const avg = replay.qty > EPS ? replay.cost / replay.qty : null;
    const avgFill = replay.qty > EPS ? replay.gross / replay.qty : null;
    const costBasis = avg === null ? null : avg * basisQty;
    const basisValue = price === null ? null : price * basisQty;
    const unrealized = basisValue === null || costBasis === null ? null : basisValue - costBasis;
    out.push({
      asset: h.asset,
      ackId: ack.id,
      note: ack.note,
      qty,
      priceUsd: price,
      valueUsd: price === null ? null : price * qty,
      basisQty,
      unknownQty: qty - basisQty,
      avgEntryUsd: avgFill,
      breakEvenUsd: avg,
      costBasisUsd: costBasis,
      unrealizedUsd: unrealized,
      unrealizedPct: unrealized === null || costBasis === null || costBasis <= 0 ? null : unrealized / costBasis,
      realizedUsd: replay.realizedUsd,
      feesUsd: replay.feesUsd,
      orders: replay.orders,
      firstBuyAt: replay.firstBuyAt,
      lastBuyAt: replay.lastBuyAt,
      ledgerTrades: replay.ledgerTrades,
      inflows: replay.inflows,
    });
  }
  return out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}
