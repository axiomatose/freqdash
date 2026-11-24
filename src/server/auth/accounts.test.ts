import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMeta, getUserById, getUserByUsername, listUserSessions, listUsers, setUserPassword } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { clearRegisteredSecrets } from '../log';
import { verifyPassword } from './password';
import { applyConfiguredPasswordReset, ensureFirstAccount } from './reset';
import { SEED_PASSWORD, testConfig, tokenFor } from './test-support';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  temp.cleanup();
  vi.restoreAllMocks();
  clearRegisteredSecrets();
});

describe('first start', () => {
  it('migrations seed no account', () => {
    temp.cleanup();
    temp = installTempDb({ users: false });
    expect(listUsers()).toEqual([]);
  });

  it('creates admin with a random temporary password on an empty database, once', async () => {
    temp.cleanup();
    temp = installTempDb({ users: false });
    const password = await ensureFirstAccount(10);
    expect(password).toMatch(/^[A-Za-z0-9_-]{20}$/);
    const users = listUsers();
    expect(users.map((u) => [u.username, u.mustChangePassword])).toEqual([['admin', true]]);
    expect(await verifyPassword(password!, users[0]!.passwordHash)).toBe(true);
    expect(await ensureFirstAccount(20)).toBeNull();
    expect(listUsers()).toHaveLength(1);
  });

  it('leaves an existing database alone', async () => {
    expect(await ensureFirstAccount(10)).toBeNull();
    expect(listUsers().map((u) => u.username)).toEqual(['admin', 'partner']);
  });

  it('does not create admin when AUTH_RESET_USER already created the first account', async () => {
    temp.cleanup();
    temp = installTempDb({ users: false });
    const cfg = testConfig({ AUTH_RESET_USER: 'owner', AUTH_RESET_PASSWORD: 'first-owner-password' });
    expect(await applyConfiguredPasswordReset(cfg, 10)).toBe(true);
    expect(await ensureFirstAccount(10)).toBeNull();
    expect(listUsers().map((u) => u.username)).toEqual(['owner']);
  });
});

describe('fixture accounts', () => {
  it('have the temporary test password, one salt each', async () => {
    const users = listUsers();
    expect(users.map((u) => [u.id, u.username, u.mustChangePassword])).toEqual([
      [1, 'admin', true],
      [2, 'partner', true],
    ]);
    expect(users[0]?.passwordHash).not.toBe(users[1]?.passwordHash);
    for (const u of users) expect(await verifyPassword(SEED_PASSWORD, u.passwordHash)).toBe(true);
  });

  it('looks usernames up case-insensitively', () => {
    expect(getUserByUsername('PARTNER')?.id).toBe(2);
    expect(getUserByUsername('nobody')).toBeNull();
  });

  it('a password change clears the temporary flag', () => {
    const updated = setUserPassword(2, 'scrypt$x', false, 5);
    expect(updated).toMatchObject({ mustChangePassword: false, passwordChangedAt: 5 });
    expect(setUserPassword(99, 'scrypt$x', false, 5)).toBeNull();
  });
});

describe('AUTH_RESET_USER / AUTH_RESET_PASSWORD', () => {
  const cfg = (user: string, password: string) => testConfig({ AUTH_RESET_USER: user, AUTH_RESET_PASSWORD: password });

  it("resets once to a temporary password and ends the user's sessions", async () => {
    setUserPassword(1, 'scrypt$forgotten', false, 1);
    tokenFor({ uid: 1, createdAt: 5 });
    tokenFor({ uid: 2, createdAt: 5 });
    expect(await applyConfiguredPasswordReset(cfg('ADMIN', 'recovery-password-1'), 10)).toBe(true);
    const admin = getUserById(1)!;
    expect(admin.mustChangePassword).toBe(true);
    expect(listUserSessions(1, 10)).toEqual([]);
    expect(listUserSessions(2, 10)).toHaveLength(1);
    expect(await verifyPassword('recovery-password-1', admin.passwordHash)).toBe(true);
    expect(getMeta('auth_reset_applied')).not.toContain('recovery-password-1');

    // A restart with the variables still set leaves the password the user picked afterwards alone.
    setUserPassword(1, 'scrypt$picked', false, 20);
    expect(await applyConfiguredPasswordReset(cfg('admin', 'recovery-password-1'), 30)).toBe(false);
    expect(getUserById(1)?.passwordHash).toBe('scrypt$picked');
    // A different pair applies again.
    expect(await applyConfiguredPasswordReset(cfg('admin', 'recovery-password-2'), 40)).toBe(true);
  });

  it('does nothing without the variables', async () => {
    expect(await applyConfiguredPasswordReset(testConfig(), 1)).toBe(false);
  });

  it('creates an account that does not exist yet, with a temporary password, once', async () => {
    expect(await applyConfiguredPasswordReset(cfg('Sam', 'partner-start-password'), 10)).toBe(true);
    const sam = getUserByUsername('sam')!;
    expect(sam).toMatchObject({ username: 'Sam', mustChangePassword: true, createdAt: 10 });
    expect(await verifyPassword('partner-start-password', sam.passwordHash)).toBe(true);
    expect(await applyConfiguredPasswordReset(cfg('Sam', 'partner-start-password'), 20)).toBe(false);
    expect(listUsers()).toHaveLength(3);
  });
});
