import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, fromB64u, generateVapidKeys, vapidAuthorization, vapidKeysMatch } from './crypto';

// RFC 8291 appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The browser's side of RFC 8291, to check a round trip with random keys. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const record = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('reproduces the RFC 8291 appendix A example byte for byte', () => {
    const out = encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      salt: fromB64u(RFC.salt),
      asPrivateKey: fromB64u(RFC.asPrivate),
    });
    expect(out.toString('base64url')).toBe(RFC.body);
  });

  it('round-trips with fresh keys and a random salt', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 5);
    const body = encryptPayload(
      Buffer.from('{"title":"héllo"}'),
      ua.getPublicKey().toString('base64url'),
      auth.toString('base64url'),
    );
    expect(decrypt(body, ua.getPrivateKey(), auth)).toBe('{"title":"héllo"}');
    expect(decrypt(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.auth))).toBe(RFC.plaintext);
  });

  it('rejects malformed subscription keys', () => {
    expect(() => encryptPayload(Buffer.from('x'), 'AAAA', RFC.auth)).toThrow(/p256dh/);
    expect(() => encryptPayload(Buffer.from('x'), RFC.uaPublic, 'AAAA')).toThrow(/auth/);
  });
});

describe('VAPID', () => {
  it('generates matching key pairs', () => {
    const keys = generateVapidKeys();
    expect(fromB64u(keys.publicKey)).toHaveLength(65);
    expect(fromB64u(keys.privateKey)).toHaveLength(32);
    expect(vapidKeysMatch(keys)).toBe(true);
    expect(vapidKeysMatch({ ...keys, publicKey: generateVapidKeys().publicKey })).toBe(false);
    expect(vapidKeysMatch({ publicKey: 'x', privateKey: 'y' })).toBe(false);
  });

  it('signs an ES256 JWT for the push service origin that verifies with the public key', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@example.com', 1234);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as unknown as string[];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromB64u(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(fromB64u(c!).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1234,
      sub: 'mailto:a@example.com',
    });
    const pub = fromB64u(keys.publicKey);
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = createVerify('SHA256').update(`${h}.${c}`).verify({ key, dsaEncoding: 'ieee-p1363' }, fromB64u(sig!));
    expect(ok).toBe(true);
  });
});
