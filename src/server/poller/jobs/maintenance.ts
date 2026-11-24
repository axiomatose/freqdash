import { CADENCE_MS } from '@/shared/constants';
import { prune, vacuumIfDue } from '../../db';
import { log } from '../../log';
import type { PollerContext } from '../context';

// maintenance every 6 h: retention pruning, and a weekly VACUUM (docs/PLAN.md section 5.1).
export async function maintenanceJob(ctx: PollerContext): Promise<void> {
  const now = ctx.now();
  const pruned = prune(now);
  const vacuumed = vacuumIfDue(now);
  log.info('maintenance done', { ...pruned, vacuumed });
}

export function registerMaintenanceJob(ctx: PollerContext): void {
  ctx.scheduler.add({
    name: 'maintenance',
    cadenceMs: CADENCE_MS.maintenance,
    startDelayMs: 60_000,
    run: () => maintenanceJob(ctx),
  });
}
