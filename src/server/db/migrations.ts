import 'server-only';
import type BetterSqlite3 from 'better-sqlite3';

// Versioned schema migrations (docs/PLAN.md section 5.1). The SQL is embedded as TS strings, not .sql files, so it
// ships inside the Next.js standalone output without any file tracing.
//
// Rules:
//  * The schema version lives in `meta.schema_version` (text). Version 0 means "no meta table yet".
//  * Every statement is `IF NOT EXISTS`, and the version bump and the DDL commit in one IMMEDIATE transaction, so a
//    migration that fails part-way leaves nothing behind and running one twice is harmless.
//  * Migrations are append-only: never edit a released migration, add the next version instead.
//  * Pragmas (WAL, synchronous, ...) are not part of a migration: journal_mode cannot change inside a transaction.
//    They are applied by client.ts on every connection.

type Db = BetterSqlite3.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_INITIAL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS source_state (source TEXT PRIMARY KEY, last_ok_at INTEGER, last_attempt_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS bot_orders_seen (bot_id TEXT NOT NULL, order_id TEXT NOT NULL, trade_id INTEGER NOT NULL,
  pair TEXT NOT NULL, side TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, order_id));
CREATE INDEX IF NOT EXISTS ix_bos_order ON bot_orders_seen(order_id);

CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, at INTEGER NOT NULL,
  type TEXT NOT NULL, source TEXT NOT NULL, order_id TEXT, pair TEXT, price REAL, stake_usd REAL, message TEXT,
  fingerprint TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS ix_be_bot_at ON bot_events(bot_id, at);
CREATE INDEX IF NOT EXISTS ix_be_type_at ON bot_events(type, at);
CREATE INDEX IF NOT EXISTS ix_be_order ON bot_events(order_id);

CREATE TABLE IF NOT EXISTS log_cursors (bot_id TEXT PRIMARY KEY, file TEXT NOT NULL, head_hash TEXT NOT NULL,
  offset INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS kraken_orders (txid TEXT PRIMARY KEY, pair TEXT, kraken_pair TEXT NOT NULL,
  side TEXT NOT NULL, order_type TEXT NOT NULL, status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
  vol REAL NOT NULL, vol_exec REAL NOT NULL, cost_usd REAL NOT NULL, fee_usd REAL NOT NULL,
  avg_price REAL, limit_price REAL, userref INTEGER, cl_ord_id TEXT, reason TEXT,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ko_opened ON kraken_orders(opened_at);
CREATE INDEX IF NOT EXISTS ix_ko_pair ON kraken_orders(pair, opened_at);

CREATE TABLE IF NOT EXISTS kraken_flows (ledger_id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL,
  asset TEXT NOT NULL, amount REAL NOT NULL, fee REAL NOT NULL, refid TEXT, raw_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS equity_snapshots (at INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('kraken','bot-wallet')),
  total_usd REAL NOT NULL, usd_cash REAL NOT NULL, bot_positions_usd REAL, untracked_usd REAL,
  holdings_json TEXT NOT NULL, unpriced_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS signal_history (bot_id TEXT NOT NULL, pair TEXT NOT NULL, timeframe TEXT NOT NULL,
  candle_at INTEGER NOT NULL, enter INTEGER NOT NULL, exit INTEGER NOT NULL, enter_tag TEXT, exit_tag TEXT,
  first_seen_at INTEGER NOT NULL, PRIMARY KEY (bot_id, pair, timeframe, candle_at));

CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, rule TEXT NOT NULL,
  severity TEXT NOT NULL, max_severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','resolved')),
  title TEXT NOT NULL, detail TEXT NOT NULL, subject_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  evidence_keys_json TEXT NOT NULL DEFAULT '[]',
  min_duration_ms INTEGER NOT NULL DEFAULT 0, clear_after_ms INTEGER NOT NULL DEFAULT 30000,
  escalate_after_ms INTEGER, escalate_to TEXT,
  first_seen_at INTEGER NOT NULL, episode_start_at INTEGER NOT NULL, active_since INTEGER,
  last_seen_at INTEGER NOT NULL, cleared_at INTEGER, resolved_at INTEGER,
  occurrences INTEGER NOT NULL DEFAULT 1, flap_count INTEGER NOT NULL DEFAULT 0,
  silenced_at INTEGER, silenced_by TEXT, silenced_note TEXT, silenced_severity TEXT, silenced_evidence_count INTEGER,
  notified_at INTEGER, notified_severity TEXT, notified_evidence_count INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS ux_findings_open ON findings(fingerprint) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS ix_findings_status ON findings(status, severity);

CREATE TABLE IF NOT EXISTS acknowledgements (id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('asset','kraken_order')),
  subject TEXT NOT NULL, label TEXT NOT NULL CHECK (label IN ('manual','ignored')), note TEXT, qty_baseline REAL,
  created_at INTEGER NOT NULL, created_by TEXT, expires_at INTEGER, revoked_at INTEGER, revoked_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_acks_active ON acknowledgements(kind, subject) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, channel TEXT NOT NULL,
  fingerprint TEXT, kind TEXT NOT NULL, severity TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
`;

// App settings (edited in the admin panel; secrets are stored encrypted) and the built-in assistant's data.
const V2_SETTINGS_AND_AGENT = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, updated_by TEXT);

CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ac_updated ON agent_conversations(updated_at);

CREATE TABLE IF NOT EXISTS agent_messages (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL
  REFERENCES agent_conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')), content TEXT, tool_calls_json TEXT,
  tool_call_id TEXT, name TEXT, created_at INTEGER NOT NULL, UNIQUE (conversation_id, seq));

CREATE TABLE IF NOT EXISTS agent_memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL, tags TEXT,
  conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

// User accounts and Web Push. No account is seeded here: on an empty table boot creates `admin` with a random temporary
// password (server/auth/reset.ts). Databases created before that change keep the accounts an earlier version seeded.
// (`session_version` was bumped on every password change to sign out every other session of that user; since v4
// sessions live in their own table.) `push_trade_events` remembers which entries and exits were already announced.
const V3_USERS_AND_PUSH = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, password_changed_at INTEGER, last_login_at INTEGER);

CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT, prefs_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_ok_at INTEGER, last_error TEXT, last_error_at INTEGER, failures INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_push_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS push_trade_events (key TEXT PRIMARY KEY, bot_id TEXT NOT NULL, at INTEGER NOT NULL,
  created_at INTEGER NOT NULL);
`;

// Server-side sessions: the cookie holds a random token, the row holds its SHA-256 hash. A session ends when it is idle
// past `expires_at` (slides forward on use), at `absolute_expires_at`, or when its row is deleted (sign-out, password
// change, sign-out of other devices). Supersedes users.session_version, which is no longer read.
const V4_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
  label TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);
`;

// The whole Kraken ledger (`kraken_flows` keeps only deposits and withdrawals for the equity chart): quantities that
// arrived without an order (Buy Crypto, convert, staking rewards, transfers in) and the exact USD of the ones that
// were bought. Entries are immutable, so upserts are idempotent.
const V5_KRAKEN_LEDGER = `
CREATE TABLE IF NOT EXISTS kraken_ledger (ledger_id TEXT PRIMARY KEY, refid TEXT, at INTEGER NOT NULL,
  type TEXT NOT NULL, subtype TEXT, asset TEXT NOT NULL, amount REAL NOT NULL, fee REAL NOT NULL, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_kl_asset ON kraken_ledger(asset, at);
CREATE INDEX IF NOT EXISTS ix_kl_refid ON kraken_ledger(refid);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: V1_INITIAL },
  { version: 2, name: 'settings and assistant', sql: V2_SETTINGS_AND_AGENT },
  { version: 3, name: 'users and web push', sql: V3_USERS_AND_PUSH },
  { version: 4, name: 'server-side sessions', sql: V4_SESSIONS },
  { version: 5, name: 'kraken ledger', sql: V5_KRAKEN_LEDGER },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export interface MigrationResult {
  from: number;
  to: number;
  /** Versions applied by this call, in order; empty when the database was already current. */
  applied: number[];
}

/** Current schema version: 0 when the meta table or the key does not exist yet. */
export function readSchemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const version = row === undefined ? 0 : Number(row.value);
  // An unreadable value is treated as "unknown, re-check": the IF NOT EXISTS DDL makes that safe.
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `migration versions must run 1..n without gaps (found ${migration.version} at position ${index + 1})`,
      );
    }
  });
}

/**
 * Brings the schema up to date. Safe to call on every start and from several connections at once: pending
 * migrations run inside one IMMEDIATE transaction that re-reads the version under the write lock.
 * `migrations` is injectable for tests; production code uses the default list.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  assertContiguous(migrations);
  const target = migrations.length;
  const current = readSchemaVersion(db);
  if (current > target) {
    throw new Error(`database schema version ${current} is newer than this build supports (${target})`);
  }
  if (current === target) return { from: current, to: current, applied: [] };

  const apply = db.transaction((): MigrationResult => {
    const from = readSchemaVersion(db);
    const applied: number[] = [];
    for (const migration of migrations) {
      if (migration.version <= from) continue;
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version));
      applied.push(migration.version);
    }
    return { from, to: applied.at(-1) ?? from, applied };
  });
  return apply.immediate();
}
