import { describe, expect, it, vi } from 'vitest';
import { createNonceSource, NONCE_BUMP_MS } from './nonce';

function makeSource(persisted: number | null, clock: () => number) {
  const saved: number[] = [];
  const load = vi.fn(() => persisted);
  const source = createNonceSource(load, (n) => saved.push(n), clock);
  return { source, saved, load };
}

describe('createNonceSource', () => {
  it('uses the clock when it is ahead', () => {
    const { source, saved } = makeSource(null, () => 1_790_000_000_000);
    expect(source.next()).toBe(1_790_000_000_000);
    expect(saved).toEqual([1_790_000_000_000]);
  });

  it('is strictly increasing when the clock does not advance', () => {
    const { source } = makeSource(null, () => 5_000);
    expect([source.next(), source.next(), source.next()]).toEqual([5_000, 5_001, 5_002]);
  });

  it('never decreases when the clock runs backwards', () => {
    let now = 10_000;
    const { source } = makeSource(null, () => now);
    const seen = [source.next()];
    now = 4_000;
    seen.push(source.next(), source.next());
    now = 12_000;
    seen.push(source.next());
    expect(seen).toEqual([10_000, 10_001, 10_002, 12_000]);
  });

  it('continues above a persisted value that is ahead of the clock', () => {
    const { source } = makeSource(2_000_000, () => 1_000_000);
    expect(source.next()).toBe(2_000_001);
    expect(source.next()).toBe(2_000_002);
  });

  it('ignores a persisted value that is behind the clock', () => {
    const { source } = makeSource(500, () => 1_000_000);
    expect(source.next()).toBe(1_000_000);
  });

  it.each([[null], [undefined], [Number.NaN], [-5], [Number.POSITIVE_INFINITY]])(
    'treats %s as "nothing persisted"',
    (value) => {
      const { source } = makeSource(value as number | null, () => 42);
      expect(source.last()).toBe(0);
      expect(source.next()).toBe(42);
    },
  );

  it('loads once, lazily, and saves every nonce before returning it', () => {
    const order: string[] = [];
    const load = vi.fn(() => {
      order.push('load');
      return 100;
    });
    const source = createNonceSource(
      load,
      (n) => order.push(`save:${n}`),
      () => 1,
    );
    expect(load).not.toHaveBeenCalled();
    source.next();
    source.next();
    expect(load).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['load', 'save:101', 'save:102']);
    expect(source.last()).toBe(102);
  });

  it('does not move when saving fails, so nothing is sent with an unpersisted nonce', () => {
    let fail = true;
    const source = createNonceSource(
      () => 10,
      () => {
        if (fail) throw new Error('disk full');
      },
      () => 1,
    );
    expect(() => source.next()).toThrow('disk full');
    expect(source.last()).toBe(10);
    fail = false;
    expect(source.next()).toBe(11);
  });

  it('bump() jumps ahead of both the last nonce and the clock, and persists it', () => {
    const { source, saved } = makeSource(null, () => 1_000);
    source.next();
    expect(source.bump()).toBe(1_000 + NONCE_BUMP_MS);
    expect(source.next()).toBe(1_000 + NONCE_BUMP_MS + 1);
    expect(saved).toEqual([1_000, 1_000 + NONCE_BUMP_MS, 1_000 + NONCE_BUMP_MS + 1]);
  });

  it('bump() follows a clock that is far ahead', () => {
    const { source } = makeSource(null, () => 50_000);
    expect(source.bump()).toBe(50_000);
  });
});
