import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, openDb, setDbForTests, type Db } from './client';

// Test-only helpers (never imported by production code): a real temp-file database in WAL mode, migrated, and
// removed again afterwards. Tests of other packages can use installTempDb() to run against a private database.

export interface TempDb {
  db: Db;
  dir: string;
  file: string;
  /** Closes the connection (a Windows file lock would block deletion) and removes the directory. Idempotent. */
  cleanup(): void;
}

/** Temporary password of the fixture accounts (made-up test value). */
export const TEST_USER_PASSWORD = 'test-temporary-password';

/**
 * Fixture accounts: `admin` (id 1) and `partner` (id 2), both with TEST_USER_PASSWORD marked temporary. Production
 * seeds no account (boot creates the first one), but most auth tests need two existing users.
 */
export function seedTestUsers(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 0)`,
  );
  insert.run(1, 'admin', 'scrypt$15$8$1$c-Qr9BAmEbOFQzIg1R-VSw$z1gYceKda6NYMvFwjXq_k65jhjW7has4Y6b5Mc-3FWI');
  insert.run(2, 'partner', 'scrypt$15$8$1$2ZO57IRtORZXy6Kb2sD0jQ$Mz87hV1V_RzqQBUNlifrex-8GPaCBZOVieLH5kcnhUo');
}

/**
 * Opens a fresh migrated database in a unique temp directory. It is NOT registered as the process-wide one.
 * `users: false` leaves the users table empty (as on a real first start); by default the fixture accounts are added.
 */
export function createTempDb(options: { users?: boolean } = {}): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freqdash-db-'));
  const file = path.join(dir, 'test.db');
  const db = openDb(file);
  if (options.users !== false) seedTestUsers(db);
  return {
    db,
    dir,
    file,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** createTempDb() and make it the process-wide connection, so repo functions operate on it. */
export function installTempDb(options: { users?: boolean } = {}): TempDb {
  const temp = createTempDb(options);
  setDbForTests(temp.db);
  const cleanup = temp.cleanup;
  temp.cleanup = () => {
    closeDb();
    cleanup();
  };
  return temp;
}
