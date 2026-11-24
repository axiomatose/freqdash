import { SCHEDULER } from '@/shared/constants';
import type { Ms } from '@/shared/types/domain';
import { describeError, log } from '../log';

// Job scheduler (docs/PLAN.md section 6.4): every job is single-flight, runs on a setTimeout chain with +-10 % jitter
// and backs off as cadence * 2^failures (capped) while it keeps failing. A job "fails" when its function throws.

export interface JobDef {
  name: string;
  cadenceMs: Ms;
  run: () => Promise<void>;
  /** Delay before the first run; defaults to 0. Used to stagger the start-up burst. */
  startDelayMs?: Ms;
}

export interface SchedulerDeps {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random: () => number;
  maxBackoffMs: Ms;
  jitterRatio: number;
}

export const realDeps: SchedulerDeps = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never keep the process alive just for a poll.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  random: Math.random,
  maxBackoffMs: SCHEDULER.maxBackoffMs,
  jitterRatio: SCHEDULER.jitterRatio,
};

interface JobRuntime {
  def: JobDef;
  failures: number;
  running: boolean;
  /** A trigger() arrived while the job was running: run once more right after. */
  rerun: boolean;
  handle: unknown;
}

export class Scheduler {
  readonly #jobs = new Map<string, JobRuntime>();
  readonly #deps: SchedulerDeps;
  #started = false;

  constructor(deps: Partial<SchedulerDeps> = {}) {
    this.#deps = { ...realDeps, ...deps };
  }

  add(def: JobDef): void {
    if (this.#jobs.has(def.name)) throw new Error(`duplicate job: ${def.name}`);
    const job: JobRuntime = { def, failures: 0, running: false, rerun: false, handle: null };
    this.#jobs.set(def.name, job);
    if (this.#started) this.#schedule(job, def.startDelayMs ?? 0, false);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.#jobs.values()) this.#schedule(job, job.def.startDelayMs ?? 0, false);
  }

  stop(): void {
    this.#started = false;
    for (const job of this.#jobs.values()) {
      if (job.handle !== null) this.#deps.clearTimeout(job.handle);
      job.handle = null;
    }
  }

  has(name: string): boolean {
    return this.#jobs.has(name);
  }

  failuresOf(name: string): number {
    return this.#jobs.get(name)?.failures ?? 0;
  }

  /** Runs a job as soon as possible (now, or right after the run in flight). Unknown names are ignored. */
  trigger(name: string): void {
    const job = this.#jobs.get(name);
    if (job === undefined || !this.#started) return;
    if (job.running) {
      job.rerun = true;
      return;
    }
    this.#schedule(job, 0, false);
  }

  /** Delay before the next run: cadence, or cadence * 2^failures (capped) while failing; then jittered. */
  nextDelay(cadenceMs: Ms, failures: number): Ms {
    const backoff =
      failures > 0 ? Math.min(cadenceMs * 2 ** failures, Math.max(cadenceMs, this.#deps.maxBackoffMs)) : cadenceMs;
    const jitter = 1 + (this.#deps.random() * 2 - 1) * this.#deps.jitterRatio;
    return Math.max(0, Math.round(backoff * jitter));
  }

  #schedule(job: JobRuntime, delayMs: Ms, jitter: boolean): void {
    if (job.handle !== null) this.#deps.clearTimeout(job.handle);
    const wait = jitter ? this.nextDelay(delayMs, job.failures) : delayMs;
    job.handle = this.#deps.setTimeout(() => {
      job.handle = null;
      void this.#execute(job);
    }, wait);
  }

  async #execute(job: JobRuntime): Promise<void> {
    if (!this.#started || job.running) return;
    job.running = true;
    try {
      await job.def.run();
      job.failures = 0;
    } catch (err) {
      job.failures += 1;
      log.warn('job failed', { job: job.def.name, failures: job.failures, err: describeError(err) });
    } finally {
      job.running = false;
    }
    if (!this.#started) return;
    if (job.rerun) {
      job.rerun = false;
      this.#schedule(job, 0, false);
    } else {
      this.#schedule(job, job.def.cadenceMs, true);
    }
  }
}
