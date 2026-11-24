import 'server-only';
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

// Web Push cryptography with node:crypto only:
//  * RFC 8291 message encryption with the RFC 8188 `aes128gcm` content coding (one record);
//  * RFC 8292 VAPID: an ES256 JWT that identifies this server to the browser's push service.
// The test suite checks the encryption against the worked example in RFC 8291 appendix A.

const b64u = (buf: Buffer): string => buf.toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (65 bytes): the browser's `applicationServerKey`. */
  publicKey: string;
  /** Private scalar, base64url (32 bytes). */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function signingKey(keys: VapidKeys): KeyObject {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** True when the pair is a valid P-256 key pair (the public key belongs to the private one). */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(keys.privateKey));
    return ecdh.getPublicKey().equals(fromB64u(keys.publicKey));
  } catch {
    return false;
  }
}

/** `Authorization` header value for a push request to `endpoint`. `expSec` must be at most 24 h ahead. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, expSec: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: expSec, sub: subject })));
  const input = `${header}.${claims}`;
  const signature = createSign('SHA256')
    .update(input)
    .sign({ key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

export interface EncryptOptions {
  /** Test seams (RFC 8291 appendix A); random in production. */
  salt?: Buffer;
  asPrivateKey?: Buffer;
}

/**
 * Encrypts `plaintext` for one subscription (`p256dh` = the browser's public key, `auth` = its auth secret, both
 * base64url). Returns the request body: the aes128gcm header (salt, record size, sender key) and one record.
 */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, options: EncryptOptions = {}): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('invalid p256dh key');
  if (authSecret.length !== 16) throw new Error('invalid auth secret');

  const ecdh = createECDH('prime256v1');
  if (options.asPrivateKey) ecdh.setPrivateKey(options.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = options.salt ?? randomBytes(16);

  // RFC 8291 section 3.4: IKM from the ECDH secret and the auth secret, then the RFC 8188 key and nonce.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  // One record: plaintext followed by the 0x02 "last record" delimiter, no extra padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
  const tagged = Buffer.concat([record, cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, tagged]);
}
