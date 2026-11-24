import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getConfig } from '../config';
import { log } from '../log';
import { migrate, readSchemaVersion } from './migrations';

export type Db = Database.Database;

export const DB_FILENAME = 'freqdash.db';

// Process-wide connection. Next.js bundles instrumentation.ts (the poller) and every route handler separately, so a
// module-level variable would exist once per bundle and each copy would open its own connection and re-run the
// migration check. The connection therefore lives on globalThis under a registered symbol, like the state store.
const DB_KEY = Symbol.for('freqdash.db');
type GlobalWithDb = typeof globalThis & { [DB_KEY]?: Db };

/** Applied to every connection (docs/PLAN.md section 5.1). WAL is a property of the file, the rest is per connection. */
export function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/**
 * Opens (creating the directory and file if needed) a database, applies the pragmas and migrates it to the latest
 * schema. Returns an independent connection that is not registered as the process-wide one: tests use it directly
 * or hand it to setDbForTests().
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  try {
    applyPragmas(db);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Absolute path of the database file inside DATA_DIR (default ./data; /data in the container). */
export function dbFilePath(): string {
  return path.resolve(getConfig().runtime.dataDir, DB_FILENAME);
}

/** The process-wide connection: opened, pragma'd and migrated on first use, then shared through globalThis. */
export function getDb(): Db {
  const g = globalThis as GlobalWithDb;
  const existing = g[DB_KEY];
  if (existing?.open) return existing;

  const file = dbFilePath();
  const db = openDb(file);
  g[DB_KEY] = db;
  log.info('database opened', { file, schemaVersion: readSchemaVersion(db) });
  return db;
}

/** Closes and forgets the process-wide connection (SIGTERM handler, tests). A later getDb() reopens it. */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  const db = g[DB_KEY];
  delete g[DB_KEY];
  if (db?.open) db.close();
}

/** Test helper: make `db` the process-wide connection (closing any previous one) so repos operate on it. */
export function setDbForTests(db: Db): void {
  closeDb();
  (globalThis as GlobalWithDb)[DB_KEY] = db;
}

/** Test helper: close and forget the process-wide connection. */
export const resetDbForTests = closeDb;

export interface DbStats {
  sizeBytes: number;
  findings: number;
  krakenOrders: number;
  equityPoints: number;
}

/** Figures for `/api/v1/status` (`db` block). */
export function getDbStats(): DbStats {
  const db = getDb();
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const pages = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return {
    sizeBytes: pages * pageSize,
    findings: count('findings'),
    krakenOrders: count('kraken_orders'),
    equityPoints: count('equity_snapshots'),
  };
}

// --- small helpers shared by the repos ------------------------------------------------------------------------

/** Longest error/message text stored in a single column. Callers still redact secrets first (see the repos). */
export const MAX_TEXT_LENGTH = 4000;

export function clipText(text: string | null | undefined, max: number = MAX_TEXT_LENGTH): string | null {
  if (text === null || text === undefined) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** JSON.parse that never throws: a corrupt cell degrades to `fallback` instead of failing a whole API response. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** `?,?,?` for an IN (...) list. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** Bound-variable budget per statement (SQLite's default limit is far higher; this keeps statements small). */
export const IN_LIST_CHUNK = 500;

export function chunk<T>(items: readonly T[], size: number = IN_LIST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
