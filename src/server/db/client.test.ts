import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../config';
import { clearRegisteredSecrets } from '../log';
import { LATEST_SCHEMA_VERSION } from './migrations';
import {
  applyPragmas,
  chunk,
  clipText,
  closeDb,
  DB_FILENAME,
  dbFilePath,
  getDb,
  getDbStats,
  openDb,
  parseJson,
  placeholders,
  resetDbForTests,
  setDbForTests,
} from './client';
import { readSchemaVersion } from './migrations';
import { createTempDb, installTempDb, type TempDb } from './testing';

const DB_KEY = Symbol.for('freqdash.db');

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe('openDb', () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = createTempDb();
  });
  afterEach(() => temp.cleanup());

  it('opens a migrated database in WAL mode with the configured pragmas', () => {
    const { db } = temp;
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(fs.existsSync(temp.file)).toBe(true);
  });

  it('creates missing parent directories', () => {
    const nested = path.join(temp.dir, 'a', 'b', 'c.db');
    const db = openDb(nested);
    expect(fs.existsSync(nested)).toBe(true);
    db.close();
  });

  it('reopening an existing file keeps its data and does not re-migrate', () => {
    temp.db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
    temp.db.close();
    const again = openDb(temp.file);
    expect(again.prepare("SELECT value FROM meta WHERE key = 'k'").get()).toEqual({ value: 'v' });
    expect(readSchemaVersion(again)).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });

  it('applyPragmas can be repeated', () => {
    expect(() => applyPragmas(temp.db)).not.toThrow();
  });

  it('closes the handle when the migration fails', () => {
    const file = path.join(temp.dir, 'newer.db');
    const db = openDb(file);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openDb(file)).toThrow(/newer than this build/);
    // The file must not stay locked: removing it would fail on Windows otherwise.
    expect(() => fs.rmSync(file, { force: true })).not.toThrow();
  });
});

describe('getDb singleton', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freqdash-client-'));
    // Minimal valid environment; the values are throwaway test strings.
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-000000000000000000');
    vi.stubEnv('FT_BOT_1_ID', 'votemax');
    vi.stubEnv('FT_BOT_1_URL', 'http://localhost:8040');
    vi.stubEnv('FT_BOT_1_USERNAME', 'user');
    vi.stubEnv('FT_BOT_1_PASSWORD', 'test-bot-password-000');
    vi.stubEnv('LOG_LEVEL', 'error');
    vi.stubEnv('DATA_DIR', path.join(dataDir, 'nested', 'data'));
    resetConfigForTests();
  });

  afterEach(() => {
    resetDbForTests();
    resetConfigForTests();
    clearRegisteredSecrets();
    vi.unstubAllEnvs();
    removeDir(dataDir);
  });

  it('opens <DATA_DIR>/freqdash.db once, creating the directory, and shares it through globalThis', () => {
    const expected = path.resolve(dataDir, 'nested', 'data', DB_FILENAME);
    expect(dbFilePath()).toBe(expected);

    const first = getDb();
    const second = getDb();

    expect(second).toBe(first);
    expect((globalThis as Record<symbol, unknown>)[DB_KEY]).toBe(first);
    expect(fs.existsSync(expected)).toBe(true);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(readSchemaVersion(first)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('a second module instance (another bundle) sees the same connection', async () => {
    const first = getDb();
    vi.resetModules();
    const copy = await import('./client');
    expect(copy.getDb()).toBe(first);
  });

  it('closeDb closes the connection and getDb reopens the same file with the data intact', () => {
    const first = getDb();
    first.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();

    closeDb();
    expect(first.open).toBe(false);
    expect((globalThis as Record<symbol, unknown>)[DB_KEY]).toBeUndefined();

    const reopened = getDb();
    expect(reopened).not.toBe(first);
    expect(reopened.prepare("SELECT value FROM meta WHERE key = 'k'").get()).toEqual({ value: 'v' });
  });

  it('getDb replaces a connection that was closed behind its back', () => {
    const first = getDb();
    first.close();
    const second = getDb();
    expect(second.open).toBe(true);
    expect(second).not.toBe(first);
  });

  it('setDbForTests swaps the process-wide connection and closes the previous one', () => {
    const first = getDb();
    const temp = createTempDb();
    setDbForTests(temp.db);
    expect(first.open).toBe(false);
    expect(getDb()).toBe(temp.db);
    resetDbForTests();
    temp.cleanup();
  });
});

describe('getDbStats', () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = installTempDb();
  });
  afterEach(() => temp.cleanup());

  it('reports table counts and a positive size', () => {
    temp.db
      .prepare(
        `INSERT INTO equity_snapshots (at, source, total_usd, usd_cash, holdings_json) VALUES (1, 'kraken', 1, 1, '[]')`,
      )
      .run();
    const stats = getDbStats();
    expect(stats).toMatchObject({ findings: 0, krakenOrders: 0, equityPoints: 1 });
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('parseJson falls back on corrupt or missing text', () => {
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('{oops', ['fallback'])).toEqual(['fallback']);
    expect(parseJson(null, 5)).toBe(5);
    expect(parseJson(undefined, 6)).toBe(6);
  });

  it('clipText passes null through and clips long text', () => {
    expect(clipText(null)).toBeNull();
    expect(clipText(undefined)).toBeNull();
    expect(clipText('abc', 10)).toBe('abc');
    expect(clipText('abcdef', 3)).toBe('abc');
  });

  it('placeholders and chunk', () => {
    expect(placeholders(3)).toBe('?,?,?');
    expect(placeholders(0)).toBe('');
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
