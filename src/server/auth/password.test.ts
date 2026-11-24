import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from './password';
import { SEED_PASSWORD } from './test-support';

describe('hashPassword / verifyPassword', () => {
  it('round-trips and rejects anything else', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterx', hash)).toBe(false);
    expect(await verifyPassword('Correct horse battery', hash)).toBe(false);
    expect(await verifyPassword('correct horse battery ', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('treats Unicode equivalents alike (NFC) and survives very long input', async () => {
    const hash = await hashPassword('pässwörd-\u{1F511}-1234');
    expect(await verifyPassword('pässwörd-\u{1F511}-1234', hash)).toBe(true);
    expect(await verifyPassword('x'.repeat(100_000), hash)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['other scheme', 'bcrypt$2b$10$abc'],
    ['wrong field count', 'scrypt$15$8$1$abc'],
    ['absurd cost', 'scrypt$30$8$1$3-wcBVgWM68yzwYbsadJnQ$eK_Fw44IZ5OQRthzPyw14YhcKD0COSjyNLjT4xeDlm4'],
    ['short salt', 'scrypt$15$8$1$AAAA$eK_Fw44IZ5OQRthzPyw14YhcKD0COSjyNLjT4xeDlm4'],
  ])('returns false for a malformed hash (%s)', async (_label, stored) => {
    expect(await verifyPassword('anything at all', stored)).toBe(false);
  });

  it('the dummy hash is well formed (so an unknown user costs a full scrypt) and matches nothing guessable', async () => {
    expect(DUMMY_HASH.split('$')).toHaveLength(6);
    expect(await verifyPassword(SEED_PASSWORD, DUMMY_HASH)).toBe(false);
  });
});

describe('passwordProblem', () => {
  const ctx = { username: 'partner', current: SEED_PASSWORD };

  it('accepts a long passphrase', () => {
    expect(passwordProblem('orange river lantern', ctx)).toBeNull();
  });

  it.each([
    ['too short', 'short-pass1', /at least 12/],
    ['too long', 'x'.repeat(257), /at most 256/],
    ['the current one', SEED_PASSWORD, /different/],
    ['contains the username', 'my-PARTNER-password-2026', /username/],
  ])('refuses %s', (_label, value, message) => {
    expect(passwordProblem(value, ctx)).toMatch(message);
  });
});
