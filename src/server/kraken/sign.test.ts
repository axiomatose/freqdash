import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sign, signRequest } from './sign';

// The example secret and payload below are published in Kraken's REST authentication guide
// (https://docs.kraken.com/api/docs/guides/spot-rest-auth/). They are documentation values, not credentials.
const DOCS_SECRET = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
const DOCS_NONCE = '1616492376594';
const DOCS_BODY = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
const DOCS_SIGNATURE = '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==';

describe('signRequest', () => {
  it("reproduces Kraken's published test vector exactly", () => {
    expect(signRequest('/0/private/AddOrder', DOCS_BODY, DOCS_NONCE, DOCS_SECRET)).toBe(DOCS_SIGNATURE);
  });

  it('accepts the nonce as a number and exports the same function as sign()', () => {
    expect(signRequest('/0/private/AddOrder', DOCS_BODY, Number(DOCS_NONCE), DOCS_SECRET)).toBe(DOCS_SIGNATURE);
    expect(sign).toBe(signRequest);
  });

  it('matches an independent implementation of the documented algorithm', () => {
    const path = '/0/private/Balance';
    const body = 'nonce=1790000000001';
    const digest = createHash('sha256')
      .update('1790000000001' + body)
      .digest();
    const expected = createHmac('sha512', Buffer.from(DOCS_SECRET, 'base64'))
      .update(Buffer.concat([Buffer.from(path), digest]))
      .digest('base64');
    expect(signRequest(path, body, 1790000000001, DOCS_SECRET)).toBe(expected);
  });

  it('changes when the path, the body, the nonce or the secret changes', () => {
    const base = signRequest('/0/private/Balance', 'nonce=1', 1, DOCS_SECRET);
    expect(signRequest('/0/private/BalanceEx', 'nonce=1', 1, DOCS_SECRET)).not.toBe(base);
    expect(signRequest('/0/private/Balance', 'nonce=1&x=1', 1, DOCS_SECRET)).not.toBe(base);
    expect(signRequest('/0/private/Balance', 'nonce=1', 2, DOCS_SECRET)).not.toBe(base);
    expect(signRequest('/0/private/Balance', 'nonce=1', 1, Buffer.from('another secret').toString('base64'))).not.toBe(
      base,
    );
  });

  it('signs non-ASCII bodies as UTF-8', () => {
    const a = signRequest('/0/private/Balance', 'nonce=1&note=%C3%A9', 1, DOCS_SECRET);
    expect(a).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });
});
