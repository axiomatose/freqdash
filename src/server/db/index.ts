import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { getDb } from './client';
import { getMetaNumber, setMeta } from './repos/meta';
import { pruneBotEvents } from './repos/botEvents';
import { pruneResolvedFindings } from './repos/findings';
import { pruneNotifications } from './repos/notifications';
import { prunePushTradeEvents } from './repos/push';
import { pruneSessions } from './repos/sessions';

// Public surface of the persistence layer. Import from '@/server/db'.

export {
  applyPragmas,
  closeDb,
  dbFilePath,
  DB_FILENAME,
  getDb,
  getDbStats,
  openDb,
  resetDbForTests,
  setDbForTests,
} from './client';
export type { Db, DbStats } from './client';
export { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate, readSchemaVersion } from './migrations';
export type { Migration, MigrationResult } from './migrations';

export * from './repos/meta';
export * from './repos/sourceState';
export * from './repos/botOrders';
export * from './repos/botEvents';
export * from './repos/logCursors';
export * from './repos/krakenOrders';
export * from './repos/krakenFlows';
export * from './repos/krakenLedger';
export * from './repos/equity';
export * from './repos/signals';
export * from './repos/findings';
export * from './repos/acks';
export * from './repos/notifications';
export * from './repos/settings';
export * from './repos/agent';
export * from './repos/users';
export * from './repos/push';
export * from './repos/sessions';

export interface PruneResult {
  botEvents: number;
  findings: number;
  notifications: number;
  pushTradeEvents: number;
  sessions: number;
}

/**
 * Retention (docs/PLAN.md section 5.1), one transaction:
 *  * bot_events: order_created/order_canceled 365 days, every other type 90 days;
 *  * findings: resolved ones 90 days after they resolved (pending/active rows are never pruned);
 *  * notifications_log: 30 days;
 *  * push_trade_events (announced entries/exits): 30 days;
 *  * sessions: as soon as they expire.
 * Equity snapshots, Kraken orders/flows, seen bot orders, signal history and cursors are kept forever.
 */
export function prune(now: Ms): PruneResult {
  return getDb()
    .transaction((): PruneResult => ({
      botEvents: pruneBotEvents(now),
      findings: pruneResolvedFindings(now),
      notifications: pruneNotifications(now),
      pushTradeEvents: prunePushTradeEvents(now),
      sessions: pruneSessions(now),
    }))
    .immediate();
}

export const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_VACUUM_KEY = 'last_vacuum_at';

/** Runs VACUUM when the last one is at least a week old (or there was none). Returns whether it ran. */
export function vacuumIfDue(now: Ms, intervalMs: number = VACUUM_INTERVAL_MS): boolean {
  const last = getMetaNumber(LAST_VACUUM_KEY);
  if (last !== null && now - last < intervalMs) return false;
  getDb().exec('VACUUM'); // cannot run inside a transaction
  setMeta(LAST_VACUUM_KEY, now);
  return true;
}
