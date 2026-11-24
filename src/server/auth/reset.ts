import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { createUser, getMeta, getUserByUsername, listUsers, setMeta, setUserPassword } from '../db';
import { describeError, log } from '../log';
import { hashPassword } from './password';
import { endUserSessions } from './sessions';

// Accounts are managed without a shell in the (read-only) container.
//
// * First start: when the database has no account at all, `admin` is created with a random temporary password that
//   is printed once in the container log. It must be changed at the first sign-in.
// * AUTH_RESET_USER / AUTH_RESET_PASSWORD: restart with both set and that account gets this temporary password. If no
//   account has that name yet, it is created (this is how a second person gets an account). Sign in, choose a new
//   password, then remove both variables. Each distinct pair is applied once, so a restart with the variables still set
//   does not undo the password chosen afterwards.

const APPLIED_KEY = 'auth_reset_applied';
export const FIRST_ACCOUNT = 'admin';

export async function applyConfiguredPasswordReset(cfg: AppConfig, now: number = Date.now()): Promise<boolean> {
  const reset = cfg.auth.reset;
  if (reset === null) return false;
  const marker = createHmac('sha256', cfg.auth.sessionSecret)
    .update(`${reset.username.toLowerCase()}\n${reset.password}`)
    .digest('base64url');
  try {
    if (getMeta(APPLIED_KEY) === marker) return false;
    const hash = await hashPassword(reset.password);
    const user = getUserByUsername(reset.username);
    if (user === null) {
      const created = createUser(reset.username, hash, true, now);
      setMeta(APPLIED_KEY, marker);
      log.warn('account created from AUTH_RESET_USER; its password must be changed at sign-in', {
        user: created.username,
      });
      return true;
    }
    setUserPassword(user.id, hash, true, now);
    endUserSessions(user.id);
    setMeta(APPLIED_KEY, marker);
    log.warn('password reset from AUTH_RESET_USER; it must be changed at sign-in', { user: user.username });
    return true;
  } catch (err) {
    log.error('password reset from AUTH_RESET_USER failed', { err: describeError(err) });
    return false;
  }
}

/** 20 URL-safe characters (120 bits). */
export function generateTemporaryPassword(): string {
  return randomBytes(15).toString('base64url');
}

/**
 * On a database without accounts, creates `admin` with a random temporary password and logs it once. Returns the
 * password (for tests), or null when an account already exists. Runs after applyConfiguredPasswordReset, so setting
 * AUTH_RESET_USER before the first start chooses the first account and its password instead.
 */
export async function ensureFirstAccount(now: number = Date.now()): Promise<string | null> {
  try {
    if (listUsers().length > 0) return null;
    const password = generateTemporaryPassword();
    createUser(FIRST_ACCOUNT, await hashPassword(password), true, now);
    log.warn('first start: created the admin account. Sign in with this temporary password and choose a new one', {
      user: FIRST_ACCOUNT,
      temporaryPassword: password,
    });
    return password;
  } catch (err) {
    log.error('could not create the first account', { err: describeError(err) });
    return null;
  }
}
