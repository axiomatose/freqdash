import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate, readSchemaVersion, type Migration } from './migrations';
import { createTempDb, type TempDb } from './testing';

const EXPECTED_TABLES = [
  'acknowledgements',
  'agent_conversations',
  'agent_memories',
  'agent_messages',
  'bot_events',
  'bot_orders_seen',
  'equity_snapshots',
  'findings',
  'kraken_flows',
  'kraken_ledger',
  'kraken_orders',
  'log_cursors',
  'meta',
  'notifications_log',
  'push_subscriptions',
  'push_trade_events',
  'sessions',
  'settings',
  'signal_history',
  'source_state',
  'users',
];

const EXPECTED_INDEXES = [
  'ix_be_bot_at',
  'ix_be_order',
  'ix_be_type_at',
  'ix_bos_order',
  'ix_findings_status',
  'ix_ko_opened',
  'ix_ko_pair',
  'ix_push_user',
  'ix_sessions_expires',
  'ix_sessions_user',
  'ux_acks_active',
  'ux_findings_open',
];

function names(db: Database.Database, type: 'table' | 'index'): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all(type) as { name: string }[];
  return rows.map((r) => r.name);
}

let temp: TempDb | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe('migrate', () => {
  it('creates the full schema on an empty database and records the version', () => {
    const db = new Database(':memory:');
    expect(readSchemaVersion(db)).toBe(0);

    const result = migrate(db);

    expect(result).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION, applied: MIGRATIONS.map((m) => m.version) });
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(names(db, 'table')).toEqual(EXPECTED_TABLES);
    expect(names(db, 'index')).toEqual(expect.arrayContaining(EXPECTED_INDEXES));
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe(
      String(LATEST_SCHEMA_VERSION),
    );
    db.close();
  });

  it('is idempotent: a second run applies nothing and keeps the data', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();

    expect(migrate(db)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION, applied: [] });
    expect(migrate(db).applied).toEqual([]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'kept'").get()).toEqual({ value: 'yes' });
    db.close();
  });

  it('the migration SQL itself can be re-run without error (IF NOT EXISTS everywhere)', () => {
    const db = new Database(':memory:');
    const [first] = MIGRATIONS;
    db.exec(first!.sql);
    expect(() => db.exec(first!.sql)).not.toThrow();
    db.close();
  });

  it('recovers when the version row is lost but the tables exist', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("UPDATE meta SET value = 'garbage' WHERE key = 'schema_version'").run();
    expect(readSchemaVersion(db)).toBe(0);

    expect(migrate(db).applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('applies only the pending migrations when upgrading', () => {
    const db = new Database(':memory:');
    migrate(db);
    const next: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: 'extra',
      sql: 'CREATE TABLE IF NOT EXISTS extra (id INTEGER PRIMARY KEY);',
    };

    expect(migrate(db, [...MIGRATIONS, next])).toEqual({
      from: LATEST_SCHEMA_VERSION,
      to: next.version,
      applied: [next.version],
    });
    expect(readSchemaVersion(db)).toBe(next.version);
    expect(names(db, 'table')).toContain('extra');
    db.close();
  });

  it('rolls back a failing migration completely (no table, no version bump)', () => {
    const db = new Database(':memory:');
    migrate(db);
    const bad: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: 'bad',
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);',
    };

    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow(/no_such_table/);
    expect(names(db, 'table')).not.toContain('half_done');
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('refuses a database written by a newer build', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(/newer than this build/);
    db.close();
  });

  it('rejects a migration list with gaps', () => {
    const db = new Database(':memory:');
    const gap: Migration = { version: LATEST_SCHEMA_VERSION + 2, name: 'gap', sql: 'SELECT 1;' };
    expect(() => migrate(db, [...MIGRATIONS, gap])).toThrow(/without gaps/);
    db.close();
  });

  it('ships versions 1..n', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });
});

describe('schema constraints (real temp-file database)', () => {
  function open(): Database.Database {
    temp = createTempDb();
    return temp.db;
  }

  const finding = (db: Database.Database, fingerprint: string, status: string): void => {
    db.prepare(
      `INSERT INTO findings (fingerprint, rule, severity, max_severity, status, title, detail, subject_json,
         evidence_json, first_seen_at, episode_start_at, last_seen_at)
       VALUES (?, 'ORDER_STORM', 'warning', 'warning', ?, 't', 'd', '{}', '{}', 1, 1, 1)`,
    ).run(fingerprint, status);
  };

  it('allows only one open finding per fingerprint, but any number of resolved ones', () => {
    const db = open();
    finding(db, ':ETH/USD', 'pending');
    expect(() => finding(db, ':ETH/USD', 'active')).toThrow(/UNIQUE/);
    expect(() => finding(db, ':ETH/USD', 'pending')).toThrow(/UNIQUE/);

    finding(db, ':ETH/USD', 'resolved');
    finding(db, ':ETH/USD', 'resolved');
    db.prepare("UPDATE findings SET status = 'resolved' WHERE status = 'pending'").run();
    expect(() => finding(db, ':ETH/USD', 'active')).not.toThrow();
  });

  it('rejects an unknown finding status', () => {
    const db = open();
    expect(() => finding(db, ':x', 'weird')).toThrow(/CHECK/);
  });

  const ack = (db: Database.Database, kind: string, subject: string, revokedAt: number | null = null): void => {
    db.prepare(
      `INSERT INTO acknowledgements (kind, subject, label, created_at, revoked_at) VALUES (?, ?, 'manual', 1, ?)`,
    ).run(kind, subject, revokedAt);
  };

  it('allows only one un-revoked ack per (kind, subject)', () => {
    const db = open();
    ack(db, 'asset', 'ETH');
    expect(() => ack(db, 'asset', 'ETH')).toThrow(/UNIQUE/);
    expect(() => ack(db, 'kraken_order', 'ETH')).not.toThrow();
    expect(() => ack(db, 'asset', 'ETH', 5)).not.toThrow();
    expect(() => ack(db, 'asset', 'BTC')).not.toThrow();
  });

  it('checks ack kind and label', () => {
    const db = open();
    expect(() => ack(db, 'nonsense', 'ETH')).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(`INSERT INTO acknowledgements (kind, subject, label, created_at) VALUES ('asset', 'X', 'bad', 1)`)
        .run(),
    ).toThrow(/CHECK/);
  });

  it('restricts equity snapshot sources', () => {
    const db = open();
    let at = 0;
    const insert = (source: string) =>
      db
        .prepare(
          `INSERT INTO equity_snapshots (at, source, total_usd, usd_cash, holdings_json) VALUES (?, ?, 1, 1, '[]')`,
        )
        .run((at += 1), source);
    expect(() => insert('kraken')).not.toThrow();
    expect(() => insert('bot-wallet')).not.toThrow();
    expect(() => insert('other')).toThrow(/CHECK/);
  });

  it('keeps bot event fingerprints unique', () => {
    const db = open();
    const insert = () =>
      db
        .prepare(
          `INSERT INTO bot_events (bot_id, at, type, source, fingerprint) VALUES ('votemax', 1, 'startup', 'logfile', 'fp')`,
        )
        .run();
    insert();
    expect(() => insert()).toThrow(/UNIQUE/);
  });
});
