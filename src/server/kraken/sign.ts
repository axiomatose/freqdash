import 'server-only';
import { createHash, createHmac } from 'node:crypto';

/**
 * Kraken `API-Sign` (docs/PLAN.md section 6.3):
 *
 *   base64( HMAC_SHA512( key = base64decode(secret), msg = utf8(path) + SHA256(utf8(nonce + body)) ) )
 *
 * `body` is the complete `application/x-www-form-urlencoded` POST body, which itself starts with `nonce=<nonce>`.
 * It must be byte-identical to the string that is sent. `path` is the URI path as Kraken sees it
 * (`/0/private/Balance`), never including a dev-proxy prefix.
 */
export function signRequest(path: string, body: string, nonce: string | number, secretB64: string): string {
  const digest = createHash('sha256').update(`${nonce}${body}`, 'utf8').digest();
  const message = Buffer.concat([Buffer.from(path, 'utf8'), digest]);
  return createHmac('sha512', Buffer.from(secretB64, 'base64')).update(message).digest('base64');
}

export const sign = signRequest;
