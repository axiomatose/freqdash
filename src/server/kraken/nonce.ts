import 'server-only';
import type { Clock } from './types';

export interface NonceSource {
  /** The next nonce: `max(now, last + 1)`, saved before it is returned so a crash can never reuse it. */
  next(): number;
  /** Recovery after `EAPI:Invalid nonce`: jumps ahead of `last` (and of the clock) and saves the result. */
  bump(): number;
  /** The last nonce handed out (or loaded), 0 when none. */
  last(): number;
}

/** How far `bump()` jumps ahead when Kraken says our nonces are stale (another client used the same key). */
export const NONCE_BUMP_MS = 5_000;

function sanitize(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Strictly increasing millisecond nonces. `load`/`save` are synchronous so that the persisted value (WP8 backs them
 * with SQLite `meta.kraken_nonce`) is always at least as high as anything Kraken has seen. A clock that runs
 * backwards, or a persisted value ahead of the clock, only makes nonces climb by 1 until the clock catches up.
 */
export function createNonceSource(
  load: () => number | null | undefined,
  save: (nonce: number) => void,
  clock: Clock = Date.now,
): NonceSource {
  let last: number | null = null;

  const current = (): number => {
    last ??= sanitize(load());
    return last;
  };
  const advance = (candidate: number): number => {
    const value = Math.max(candidate, current() + 1);
    // Persist first: if saving fails nothing is sent and the in-memory counter does not move.
    save(value);
    last = value;
    return value;
  };

  return {
    next: () => advance(clock()),
    bump: () => advance(Math.max(clock(), current() + NONCE_BUMP_MS)),
    last: () => current(),
  };
}
