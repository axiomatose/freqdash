import { evaluateKillswitch } from '../../killswitch/service';
import { log } from '../../log';
import type { PollerContext } from '../context';

export const KILLSWITCH_CADENCE_MS = 5_000;

/** The killswitch runs on its own short cadence (detection latency is bounded by the Kraken poll, not by this). */
export function registerKillswitchJob(ctx: PollerContext): () => void {
  if (ctx.cfg.killswitch.mode === 'off') return () => {};
  ctx.scheduler.add({
    name: 'killswitch.evaluate',
    cadenceMs: KILLSWITCH_CADENCE_MS,
    startDelayMs: 5_000,
    run: () => evaluateKillswitch(ctx),
  });
  log.warn('killswitch enabled', { mode: ctx.cfg.killswitch.mode });
  // New Kraken data arrived: look at it now instead of waiting for the next tick.
  return ctx.store.onRecheck(() => ctx.trigger('killswitch.evaluate'));
}
