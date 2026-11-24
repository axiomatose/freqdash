import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_AFTER_FAILURES,
  captchaKeys,
  CaptchaService,
  encodePng,
  normalizeAnswer,
  randomCaptchaText,
  renderCaptcha,
} from './captcha';

function pngInfo(png: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatLen = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLen));
  expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  return { width, height, pixels };
}

describe('captcha image', () => {
  it('encodes a valid RGB PNG', () => {
    const rgb = new Uint8Array(2 * 3 * 3).fill(200);
    const { width, height, pixels } = pngInfo(encodePng(rgb, 2, 3));
    expect([width, height]).toEqual([2, 3]);
    expect(pixels.length).toBe(3 * (2 * 3 + 1));
  });

  it('renders 220x80 with ink on a light background, different every time', () => {
    const a = renderCaptcha('ACD34');
    const { width, height, pixels } = pngInfo(a);
    expect([width, height]).toEqual([220, 80]);
    const dark = [...pixels].filter((v) => v < 100).length;
    expect(dark).toBeGreaterThan(500);
    expect(renderCaptcha('ACD34').equals(a)).toBe(false);
  });

  it('draws every character of the alphabet (no blank glyphs)', () => {
    for (let i = 0; i < 40; i += 1) {
      const text = randomCaptchaText();
      expect(text).toMatch(/^[ACDEFHJKMNPRTUVWXY3479]{5}$/);
    }
    for (const ch of 'ACDEFHJKMNPRTUVWXY3479') expect(renderCaptcha(ch.repeat(5)).length).toBeGreaterThan(1000);
  });

  it('normalizes answers', () => {
    expect(normalizeAnswer(' ac d3 4 ')).toBe('ACD34');
  });
});

describe('CaptchaService', () => {
  const make = () => {
    const clock = { now: 1_000_000 };
    return { clock, svc: new CaptchaService({ now: () => clock.now, text: () => 'HKM79' }) };
  };

  it('verifies once, case-insensitively, and burns the challenge on a wrong answer', () => {
    const { svc } = make();
    const a = svc.issue();
    expect(a.image).toMatch(/^data:image\/png;base64,/);
    expect(svc.verify(a.id, 'hkm79')).toBe(true);
    expect(svc.verify(a.id, 'hkm79')).toBe(false);
    const b = svc.issue();
    expect(svc.verify(b.id, 'WRONG')).toBe(false);
    expect(svc.verify(b.id, 'HKM79')).toBe(false);
    expect(svc.verify('unknown', 'HKM79')).toBe(false);
    expect(svc.verify(undefined, undefined)).toBe(false);
  });

  it('expires challenges after 5 minutes', () => {
    const { svc, clock } = make();
    const a = svc.issue();
    expect(a.expiresAt).toBe(clock.now + 5 * 60_000);
    clock.now += 5 * 60_000;
    expect(svc.verify(a.id, 'HKM79')).toBe(false);
  });

  it(`is required after ${CAPTCHA_AFTER_FAILURES} failures on any key, for 15 minutes, until a success`, () => {
    const { svc, clock } = make();
    const keys = captchaKeys('198.51.100.1', 'Partner');
    expect(keys).toEqual(['ip:198.51.100.1', 'user:partner']);
    svc.recordFailure(keys);
    expect(svc.required(keys)).toBe(false);
    svc.recordFailure(keys);
    expect(svc.required(keys)).toBe(true);
    expect(svc.required(captchaKeys('203.0.113.1', 'partner'))).toBe(true);
    expect(svc.required(captchaKeys('198.51.100.1', 'admin'))).toBe(true);
    expect(svc.required(captchaKeys('203.0.113.1', 'admin'))).toBe(false);
    clock.now += 15 * 60_000;
    expect(svc.required(keys)).toBe(false);
    svc.recordFailure(keys);
    svc.recordFailure(keys);
    svc.recordSuccess(keys);
    expect(svc.required(keys)).toBe(false);
  });
});
