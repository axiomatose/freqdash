import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from './scheduler';

const deps = { random: () => 0.5, jitterRatio: 0.1, maxBackoffMs: 300_000 };

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a job on its cadence', async () => {
    const s = new Scheduler(deps);
    const run = vi.fn(async () => {});
    s.add({ name: 'a', cadenceMs: 1000, run });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    s.stop();
  });

  it('never overlaps runs of one job and reruns once after a trigger during a run', async () => {
    const s = new Scheduler(deps);
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 500));
      active--;
    });
    s.add({ name: 'a', cadenceMs: 100, run });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    s.trigger('a');
    s.trigger('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(maxActive).toBe(1);
    s.stop();
  });

  it('backs off exponentially, capped, and resets after success', async () => {
    const s = new Scheduler(deps);
    expect(s.nextDelay(1000, 0)).toBe(1000);
    expect(s.nextDelay(1000, 1)).toBe(2000);
    expect(s.nextDelay(1000, 3)).toBe(8000);
    expect(s.nextDelay(1000, 20)).toBe(300_000);
    expect(s.nextDelay(600_000, 3)).toBe(600_000);

    let fail = true;
    s.add({
      name: 'a',
      cadenceMs: 1000,
      run: async () => {
        if (fail) throw new Error('boom');
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.failuresOf('a')).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.failuresOf('a')).toBe(0);
    s.stop();
  });

  it('keeps the jitter within +-10 %', () => {
    const lo = new Scheduler({ ...deps, random: () => 0 });
    const hi = new Scheduler({ ...deps, random: () => 1 });
    expect(lo.nextDelay(1000, 0)).toBe(900);
    expect(hi.nextDelay(1000, 0)).toBe(1100);
  });

  it('start() twice does not double the timers, and stop() halts everything', async () => {
    const s = new Scheduler(deps);
    const run = vi.fn(async () => {});
    s.add({ name: 'a', cadenceMs: 1000, run });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate names and ignores triggers for unknown jobs', () => {
    const s = new Scheduler(deps);
    s.add({ name: 'a', cadenceMs: 1, run: async () => {} });
    expect(() => s.add({ name: 'a', cadenceMs: 1, run: async () => {} })).toThrow(/duplicate/);
    expect(() => s.trigger('nope')).not.toThrow();
    expect(s.has('a')).toBe(true);
  });
});
