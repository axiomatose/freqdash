// 24 h equity change (docs/PLAN.md section 7, "24h change").
import type { Asset, KrakenFlow, Ms } from '@/shared/types/domain';
import { USD } from './account';

export interface EquityPoint {
  t: Ms;
  totalUsd: number;
}

export interface EquityChange {
  usd: number;
  pct: number;
  netFlowsUsd: number | null;
}

export interface EquityChangeInput {
  now: Ms;
  currentUsd: number;
  /** Stored equity snapshots (any order). */
  history: readonly EquityPoint[];
  /** Deposits and withdrawals from the Kraken ledger, or null when the key cannot read it. */
  flows: readonly KrakenFlow[] | null;
  prices: Record<Asset, number>;
  /** Look-back, default 24 h. */
  windowMs?: Ms;
  /** How far from `now - windowMs` the baseline snapshot may be, default 10 min. */
  toleranceMs?: Ms;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const BASELINE_TOLERANCE_MS = 10 * 60 * 1000;

/** The stored point closest to `target` within `toleranceMs`, else null. */
export function nearestPoint(points: readonly EquityPoint[], target: Ms, toleranceMs: Ms): EquityPoint | null {
  let best: EquityPoint | null = null;
  for (const p of points) {
    const d = Math.abs(p.t - target);
    if (d > toleranceMs) continue;
    if (best === null || d < Math.abs(best.t - target)) best = p;
  }
  return best;
}

/**
 * Effect of one ledger row on the account balance in USD, or null when it cannot be valued.
 * Deposits add, withdrawals subtract, both regardless of the sign the ledger used; the fee always costs.
 */
export function flowUsd(flow: KrakenFlow, prices: Record<Asset, number>): number | null {
  const price = flow.asset === USD ? 1 : prices[flow.asset];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const gross =
    flow.type === 'deposit' ? Math.abs(flow.amount) : flow.type === 'withdrawal' ? -Math.abs(flow.amount) : flow.amount;
  return (gross - Math.abs(flow.fee)) * price;
}

/**
 * Change of the account total over the look-back window, adjusted for deposits and withdrawals when they are known
 * (`usd` and `pct` are then trading/holding performance, not cash movements). `pct` is in percent (1.5 = 1.5 %).
 * Returns null when no snapshot exists close enough to `now - windowMs`.
 */
export function equityChange(input: EquityChangeInput): EquityChange | null {
  const windowMs = input.windowMs ?? DAY_MS;
  const base = nearestPoint(input.history, input.now - windowMs, input.toleranceMs ?? BASELINE_TOLERANCE_MS);
  if (base === null) return null;

  let netFlowsUsd: number | null = null;
  if (input.flows !== null) {
    netFlowsUsd = 0;
    for (const f of input.flows) {
      if (f.at <= base.t || f.at > input.now) continue;
      const v = flowUsd(f, input.prices);
      if (v === null) {
        netFlowsUsd = null;
        break;
      }
      netFlowsUsd += v;
    }
  }

  const usd = input.currentUsd - base.totalUsd - (netFlowsUsd ?? 0);
  return { usd, pct: base.totalUsd > 0 ? (usd / base.totalUsd) * 100 : 0, netFlowsUsd };
}
