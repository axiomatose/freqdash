import { CADENCE_MS } from '@/shared/constants';
import type { Ms } from '@/shared/types/domain';
import type { AppState } from '@/shared/types/state';

// Mode = `kraken` iff the Kraken balances are fresh (age <= 3x their cadence), otherwise `freqtrade-only`
// (docs/PLAN.md section 10, WP8). Pure, so the poller, the checks and the views agree.

export const KRAKEN_FRESH_MULTIPLIER = 3;

export type Mode = 'kraken' | 'freqtrade-only';

export function krakenMode(state: Pick<AppState, 'kraken'>, now: Ms): { mode: Mode; reason: string | null } {
  const k = state.kraken;
  if (k.status === 'disabled') return { mode: 'freqtrade-only', reason: 'No Kraken API key is configured' };
  if (k.balances === null || k.balancesAt === null) {
    return { mode: 'freqtrade-only', reason: k.statusReason ?? 'Kraken balances have not been read yet' };
  }
  if (now - k.balancesAt > KRAKEN_FRESH_MULTIPLIER * CADENCE_MS['kraken.balance']) {
    return { mode: 'freqtrade-only', reason: k.statusReason ?? 'Kraken balances are stale' };
  }
  return { mode: 'kraken', reason: null };
}
