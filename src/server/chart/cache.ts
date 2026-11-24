import type { Ms } from '@/shared/types/domain';

// Single-flight cache for the chart's upstream reads (docs/PLAN.md section 9, "Server-side chart builder"): one
// request per key at a time, never more than one refetch per MIN_REFETCH_MS, and a stale entry is served when the
// refetch fails.

export const MIN_REFETCH_MS = 60_000;
export const TTL_MS = 5 * 60_000;

export interface CacheEntry<T> {
  value: T;
  fetchedAt: Ms;
}

export interface SingleFlightOptions<T> {
  now?: () => Ms;
  /** True when the value should be refreshed before the TTL (e.g. a new candle has closed). Still rate limited. */
  isOutdated?: (value: T, now: Ms) => boolean;
  ttlMs?: Ms;
  minRefetchMs?: Ms;
}

export class SingleFlightCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #inflight = new Map<string, Promise<CacheEntry<T>>>();
  readonly #o: Required<Pick<SingleFlightOptions<T>, 'ttlMs' | 'minRefetchMs'>> & SingleFlightOptions<T>;
  readonly #now: () => Ms;

  constructor(options: SingleFlightOptions<T> = {}) {
    this.#o = { ttlMs: TTL_MS, minRefetchMs: MIN_REFETCH_MS, ...options };
    this.#now = options.now ?? Date.now;
  }

  async get(key: string, load: () => Promise<T>): Promise<CacheEntry<T>> {
    const now = this.#now();
    const hit = this.#entries.get(key);
    if (hit !== undefined) {
      const age = now - hit.fetchedAt;
      const due = age >= this.#o.ttlMs || (this.#o.isOutdated?.(hit.value, now) ?? false);
      if (!due || age < this.#o.minRefetchMs) return hit;
    }
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;

    const promise = (async (): Promise<CacheEntry<T>> => {
      try {
        const entry = { value: await load(), fetchedAt: this.#now() };
        this.#entries.set(key, entry);
        return entry;
      } catch (err) {
        // Keep serving the old value, but do not hammer the upstream: pretend it was attempted now.
        if (hit !== undefined) {
          const kept = { value: hit.value, fetchedAt: this.#now() - this.#o.ttlMs + this.#o.minRefetchMs };
          this.#entries.set(key, kept);
          return hit;
        }
        throw err;
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.#entries.clear();
  }
}
