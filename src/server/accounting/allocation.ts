// Where the account's money sits (docs/PLAN.md section 7, "Allocation").
// Invariant (tested): usdCash + sum(botPositions) + acknowledgedUsd + untrackedUsd + dustUsd = totalUsd, +-$0.01.
import type {
  Acknowledgement,
  AccountSnapshot,
  Allocation,
  Asset,
  BotId,
  BotTrade,
  HoldingAttribution,
  Ms,
} from '@/shared/types/domain';
import { USD, holdingsByAsset } from './account';
import { openQtyOf } from './pnl';

/** Untracked value below this is dust, not a finding. */
export const DUST_USD = 1;

export interface AllocationInput {
  snapshot: AccountSnapshot;
  bots: { botId: BotId; openTrades: BotTrade[] }[];
  /** Active acknowledgements; expired or revoked ones are ignored. */
  acks: Acknowledgement[];
  now: Ms;
}

/** Quantity of `asset` that the open trades of one bot hold. */
export function botClaimedQty(openTrades: readonly BotTrade[], asset: Asset): number {
  return openTrades.reduce((acc, t) => (t.base === asset ? acc + openQtyOf(t) : acc), 0);
}

export function isAckActive(ack: Acknowledgement, now: Ms): boolean {
  return ack.revokedAt === null && (ack.expiresAt === null || ack.expiresAt > now);
}

/** The active `asset` acknowledgement for `asset`, if any. */
export function findAssetAck(acks: readonly Acknowledgement[], asset: Asset, now: Ms): Acknowledgement | null {
  return acks.find((a) => a.kind === 'asset' && a.subject === asset && isAckActive(a, now)) ?? null;
}

/** How much of `remaining` (holding minus bot claims) an acknowledgement covers; a null baseline covers everything. */
export function ackCoverage(ack: Acknowledgement | null, remaining: number): number {
  if (ack === null || remaining <= 0) return 0;
  return ack.qtyBaseline === null ? remaining : Math.min(ack.qtyBaseline, remaining);
}

export function buildAllocation(input: AllocationInput): Allocation {
  const { snapshot, bots, acks, now } = input;
  const botValue = new Map<BotId, number>(bots.map((b) => [b.botId, 0]));
  const holdings: HoldingAttribution[] = [];
  let usdCash = 0;
  let acknowledgedUsd = 0;
  let untrackedUsd = 0;
  let dustUsd = 0;

  for (const h of holdingsByAsset(snapshot).values()) {
    if (h.total <= 0) continue;
    if (h.asset === USD) {
      usdCash += h.valueUsd ?? h.total;
      holdings.push({
        asset: h.asset,
        total: h.total,
        valueUsd: h.valueUsd ?? h.total,
        byBot: [],
        acknowledgedQty: null,
        ackId: null,
        untrackedQty: 0,
        untrackedUsd: 0,
        status: 'cash',
      });
      continue;
    }

    const claims = bots.map((b) => ({ botId: b.botId, qty: botClaimedQty(b.openTrades, h.asset) }));
    const claimed = claims.reduce((acc, c) => acc + c.qty, 0);
    // A bot cannot own more than the account holds; scale the claims so the split still adds up.
    const scale = claimed > h.total ? h.total / claimed : 1;
    const botQty = claimed * scale;
    const ack = findAssetAck(acks, h.asset, now);
    const ackQty = ackCoverage(ack, h.total - botQty);
    const restQty = Math.max(0, h.total - botQty - ackQty);

    const price = h.priceUsd;
    const priced = h.valueUsd !== null && price !== null;
    const restValue = priced ? restQty * price : null;
    const isDust = restValue !== null && restValue < DUST_USD;

    if (priced) {
      for (const c of claims) botValue.set(c.botId, (botValue.get(c.botId) ?? 0) + c.qty * scale * price);
      acknowledgedUsd += ackQty * price;
      if (isDust) dustUsd += restValue;
      else untrackedUsd += restValue ?? 0;
    }

    const hasUntracked = priced ? !isDust && restQty > 0 : restQty > 0;
    let status: HoldingAttribution['status'] = 'bot';
    if (hasUntracked) status = 'untracked';
    else if (isDust && botQty === 0 && ackQty === 0) status = 'dust';
    else if (ackQty > 0) status = 'manual';

    holdings.push({
      asset: h.asset,
      total: h.total,
      valueUsd: h.valueUsd,
      byBot: claims.filter((c) => c.qty > 0).map((c) => ({ botId: c.botId, qty: c.qty * scale })),
      acknowledgedQty: ack === null ? null : ackQty,
      ackId: ack?.id ?? null,
      untrackedQty: restQty,
      untrackedUsd: restValue,
      status,
    });
  }

  return {
    totalUsd: snapshot.totalUsd,
    usdCash,
    botPositions: bots.map((b) => ({ botId: b.botId, valueUsd: botValue.get(b.botId) ?? 0 })),
    acknowledgedUsd,
    untrackedUsd,
    dustUsd,
    holdings,
  };
}
