import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Secrets that are edited in the admin panel (an API key) are stored encrypted, so a copy of the database file does not
// hand them out. The key is derived from SESSION_SECRET, which lives in the environment and never in the database.
// Rotating SESSION_SECRET therefore makes stored secrets unreadable: they read as "not set" and must be entered again.

const PREFIX = 'v1';
const INFO = 'freqdash settings encryption v1';

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'freqdash', INFO, 32));
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(
    ':',
  );
}

/** The plaintext, or null when the value is malformed or was encrypted under a different SESSION_SECRET. */
export function decryptSecret(stored: string, secret: string): string | null {
  const [prefix, iv, tag, body] = stored.split(':');
  if (prefix !== PREFIX || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
