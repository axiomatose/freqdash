import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashing for user accounts: scrypt (memory-hard, built into Node), stored as
//   scrypt$<log2 N>$<r>$<p>$<salt base64url>$<hash base64url>
// The parameters travel with the hash, so they can be raised later without invalidating stored passwords.
// Hashing runs on the libuv thread pool (async), so a login never blocks the poller's event loop.

const LOG2_N = 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** 128 * N * r = 32 MiB for the defaults; leave headroom for a hash made with one step more. */
const MAX_MEM = 160 * 1024 * 1024;

export const MIN_USER_PASSWORD_LENGTH = 12;
export const MAX_USER_PASSWORD_LENGTH = 256;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { N: 2 ** LOG2_N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', LOG2_N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface Parsed {
  log2n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [log2n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![log2n, r, p].every(Number.isInteger) || log2n < 10 || log2n > 20 || r < 1 || r > 32 || p < 1 || p > 4)
    return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const key = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || key.length < 16) return null;
  return { log2n, r, p, salt, key };
}

/** A well-formed hash of a random value: verifying against it costs the same as a real check (no user-enumeration timing). */
export const DUMMY_HASH = 'scrypt$15$8$1$3-wcBVgWM68yzwYbsadJnQ$eK_Fw44IZ5OQRthzPyw14YhcKD0COSjyNLjT4xeDlm4';

/** Constant-time check of `password` against a stored hash. False for a malformed hash; never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;
  try {
    const key = await scrypt(password, parsed.salt, parsed.key.length, {
      N: 2 ** parsed.log2n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/**
 * Why a new password is refused, or null when it is acceptable. Length only (12 to 256 characters) plus the obvious
 * reuse cases; long passphrases beat composition rules.
 */
export function passwordProblem(password: string, context: { username: string; current: string }): string | null {
  const length = [...password].length;
  if (length < MIN_USER_PASSWORD_LENGTH) return `Use at least ${MIN_USER_PASSWORD_LENGTH} characters.`;
  if (length > MAX_USER_PASSWORD_LENGTH) return `Use at most ${MAX_USER_PASSWORD_LENGTH} characters.`;
  if (password === context.current) return 'The new password must be different from the current one.';
  if (password.toLowerCase().includes(context.username.toLowerCase())) return 'Do not include your username.';
  return null;
}
