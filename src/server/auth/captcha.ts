import 'server-only';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { CaptchaChallenge } from '@/shared/types/api';
import type { Ms } from '@/shared/types/domain';

// Login captcha: after two wrong passwords (per client address or per username, within 15 minutes) the next sign-in
// must also solve a challenge. Self-hosted on purpose: no third-party script, no CSP change, works on the LAN.
//
// The challenge is a PNG raster (not SVG: glyph shapes in markup are trivial to read back) of five characters drawn
// with a stroke font, each randomly scaled, rotated and sheared, then wave-warped with crossing lines and speckle.
// Challenges are single-use, expire after 5 minutes and live in memory (one process).

export const CAPTCHA_AFTER_FAILURES = 2;
const FAILURE_WINDOW_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 2_000;
const MAX_TRACKED_KEYS = 10_000;
const LENGTH = 5;

// No look-alikes (0/O, 1/I, 2/Z, 5/S, 6/G, 8/B).
const ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';

// ---- stroke font (x 0..0.6, y 0..1, y down) ---------------------------------------------------------------------

type Stroke = [number, number][];
const P_BOWL: Stroke = [
  [0, 1],
  [0, 0],
  [0.45, 0],
  [0.6, 0.15],
  [0.6, 0.35],
  [0.45, 0.5],
  [0, 0.5],
];
const GLYPHS: Record<string, Stroke[]> = {
  A: [
    [
      [0, 1],
      [0.3, 0],
      [0.6, 1],
    ],
    [
      [0.12, 0.62],
      [0.48, 0.62],
    ],
  ],
  C: [
    [
      [0.6, 0.15],
      [0.45, 0],
      [0.15, 0],
      [0, 0.2],
      [0, 0.8],
      [0.15, 1],
      [0.45, 1],
      [0.6, 0.85],
    ],
  ],
  D: [
    [
      [0, 0],
      [0, 1],
      [0.35, 1],
      [0.6, 0.75],
      [0.6, 0.25],
      [0.35, 0],
      [0, 0],
    ],
  ],
  E: [
    [
      [0.6, 0],
      [0, 0],
      [0, 1],
      [0.6, 1],
    ],
    [
      [0, 0.5],
      [0.45, 0.5],
    ],
  ],
  F: [
    [
      [0.6, 0],
      [0, 0],
      [0, 1],
    ],
    [
      [0, 0.5],
      [0.45, 0.5],
    ],
  ],
  H: [
    [
      [0, 0],
      [0, 1],
    ],
    [
      [0.6, 0],
      [0.6, 1],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
  J: [
    [
      [0.6, 0],
      [0.6, 0.8],
      [0.45, 1],
      [0.15, 1],
      [0, 0.8],
    ],
  ],
  K: [
    [
      [0, 0],
      [0, 1],
    ],
    [
      [0.6, 0],
      [0, 0.6],
    ],
    [
      [0.2, 0.42],
      [0.6, 1],
    ],
  ],
  M: [
    [
      [0, 1],
      [0, 0],
      [0.3, 0.55],
      [0.6, 0],
      [0.6, 1],
    ],
  ],
  N: [
    [
      [0, 1],
      [0, 0],
      [0.6, 1],
      [0.6, 0],
    ],
  ],
  P: [P_BOWL],
  R: [
    P_BOWL,
    [
      [0.28, 0.5],
      [0.6, 1],
    ],
  ],
  T: [
    [
      [0, 0],
      [0.6, 0],
    ],
    [
      [0.3, 0],
      [0.3, 1],
    ],
  ],
  U: [
    [
      [0, 0],
      [0, 0.8],
      [0.15, 1],
      [0.45, 1],
      [0.6, 0.8],
      [0.6, 0],
    ],
  ],
  V: [
    [
      [0, 0],
      [0.3, 1],
      [0.6, 0],
    ],
  ],
  W: [
    [
      [0, 0],
      [0.15, 1],
      [0.3, 0.4],
      [0.45, 1],
      [0.6, 0],
    ],
  ],
  X: [
    [
      [0, 0],
      [0.6, 1],
    ],
    [
      [0.6, 0],
      [0, 1],
    ],
  ],
  Y: [
    [
      [0, 0],
      [0.3, 0.5],
      [0.6, 0],
    ],
    [
      [0.3, 0.5],
      [0.3, 1],
    ],
  ],
  '3': [
    [
      [0, 0.1],
      [0.15, 0],
      [0.45, 0],
      [0.6, 0.15],
      [0.6, 0.35],
      [0.45, 0.5],
      [0.2, 0.5],
    ],
    [
      [0.45, 0.5],
      [0.6, 0.65],
      [0.6, 0.85],
      [0.45, 1],
      [0.15, 1],
      [0, 0.9],
    ],
  ],
  '4': [
    [
      [0.45, 1],
      [0.45, 0],
      [0, 0.7],
      [0.6, 0.7],
    ],
  ],
  '7': [
    [
      [0, 0],
      [0.6, 0],
      [0.2, 1],
    ],
  ],
  '9': [
    [
      [0.6, 0.5],
      [0.15, 0.5],
      [0, 0.35],
      [0, 0.15],
      [0.15, 0],
      [0.45, 0],
      [0.6, 0.15],
      [0.6, 0.8],
      [0.45, 1],
      [0.1, 1],
    ],
  ],
};

// ---- raster ------------------------------------------------------------------------------------------------------

const W = 220;
const H = 80;

class Canvas {
  readonly px = new Uint8Array(W * H * 3);

  fill(r: number, g: number, b: number): void {
    for (let i = 0; i < W * H; i += 1) this.px.set([r, g, b], i * 3);
  }

  dot(x: number, y: number, radius: number, rgb: [number, number, number]): void {
    const r2 = radius * radius;
    for (let yy = Math.floor(y - radius); yy <= Math.ceil(y + radius); yy += 1) {
      if (yy < 0 || yy >= H) continue;
      for (let xx = Math.floor(x - radius); xx <= Math.ceil(x + radius); xx += 1) {
        if (xx < 0 || xx >= W) continue;
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r2) this.px.set(rgb, (yy * W + xx) * 3);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, radius: number, rgb: [number, number, number]): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, rgb);
    }
  }

  /** Sine displacement in both directions (inverse mapping, nearest neighbour). */
  warp(ampX: number, ampY: number, periodX: number, periodY: number, phase: number): void {
    const src = this.px.slice();
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const sx = Math.round(x + ampX * Math.sin((2 * Math.PI * y) / periodY + phase));
        const sy = Math.round(y + ampY * Math.sin((2 * Math.PI * x) / periodX + phase * 1.7));
        const to = (y * W + x) * 3;
        const from = sx >= 0 && sx < W && sy >= 0 && sy < H ? (sy * W + sx) * 3 : to;
        this.px.set(src.subarray(from, from + 3), to);
      }
    }
  }
}

const rand = (min: number, max: number): number => min + (randomInt(0, 1_000_000) / 1_000_000) * (max - min);

function inkColor(): [number, number, number] {
  return [randomInt(20, 90), randomInt(20, 90), randomInt(40, 120)];
}

function drawText(canvas: Canvas, text: string): void {
  const slot = (W - 24) / text.length;
  [...text].forEach((ch, i) => {
    const strokes = GLYPHS[ch] ?? [];
    const height = rand(34, 46);
    const scaleX = height * rand(0.85, 1.2);
    const angle = rand(-0.45, 0.45);
    const shear = rand(-0.3, 0.3);
    const cx = 12 + slot * (i + 0.5) + rand(-4, 4);
    const cy = H / 2 + rand(-6, 6);
    const ink = inkColor();
    const radius = rand(1.6, 2.4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const map = ([gx, gy]: [number, number]): [number, number] => {
      const x = (gx - 0.3) * scaleX + (gy - 0.5) * height * shear;
      const y = (gy - 0.5) * height;
      return [cx + x * cos - y * sin, cy + x * sin + y * cos];
    };
    for (const stroke of strokes) {
      for (let k = 1; k < stroke.length; k += 1) {
        const [x0, y0] = map(stroke[k - 1] as [number, number]);
        const [x1, y1] = map(stroke[k] as [number, number]);
        canvas.line(x0, y0, x1, y1, radius, ink);
      }
    }
  });
}

function drawNoise(canvas: Canvas): void {
  // Crossing curves in ink colours, so the strokes cannot be separated by colour or by thickness alone.
  for (let n = 0; n < 4; n += 1) {
    const ink = inkColor();
    const y0 = rand(10, H - 10);
    const amp = rand(6, 18);
    const period = rand(60, 200);
    const phase = rand(0, Math.PI * 2);
    const radius = rand(0.8, 1.6);
    let px = 0;
    let py = y0 + amp * Math.sin(phase);
    for (let x = 2; x <= W; x += 2) {
      const y = y0 + amp * Math.sin((2 * Math.PI * x) / period + phase);
      canvas.line(px, py, x, y, radius, ink);
      px = x;
      py = y;
    }
  }
  for (let n = 0; n < 500; n += 1) {
    const shade = randomInt(60, 200);
    canvas.dot(rand(0, W), rand(0, H), rand(0.4, 1.1), [shade, shade, shade + 20 > 255 ? 255 : shade + 20]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGB PNG, filter 0 on every row. */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Renders `text` (characters from the captcha alphabet) as a distorted PNG. */
export function renderCaptcha(text: string): Buffer {
  const canvas = new Canvas();
  canvas.fill(randomInt(215, 235), randomInt(215, 235), randomInt(225, 245));
  drawText(canvas, text);
  drawNoise(canvas);
  canvas.warp(rand(2, 4), rand(3, 6), rand(70, 130), rand(40, 80), rand(0, Math.PI * 2));
  return encodePng(canvas.px, W, H);
}

export function randomCaptchaText(length = LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/** Upper-cased, spaces dropped, so "ac d3f" matches "ACD3F". */
export function normalizeAnswer(answer: string): string {
  return answer.replace(/\s+/g, '').toUpperCase();
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

// ---- challenges and the failure gate ------------------------------------------------------------------------------

interface Challenge {
  answer: Buffer;
  expiresAt: Ms;
}

export interface CaptchaServiceOptions {
  now?: () => Ms;
  /** Test seam: the text drawn for each challenge. */
  text?: () => string;
}

export class CaptchaService {
  readonly #now: () => Ms;
  readonly #text: () => string;
  readonly #challenges = new Map<string, Challenge>();
  readonly #failures = new Map<string, Ms[]>();

  constructor(options: CaptchaServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#text = options.text ?? (() => randomCaptchaText());
  }

  /** A fresh single-use challenge. */
  issue(): CaptchaChallenge {
    const now = this.#now();
    this.#sweep(now);
    const text = this.#text();
    const id = randomBytes(18).toString('base64url');
    this.#challenges.set(id, { answer: digest(normalizeAnswer(text)), expiresAt: now + CHALLENGE_TTL_MS });
    while (this.#challenges.size > MAX_CHALLENGES) {
      const oldest = this.#challenges.keys().next().value as string;
      this.#challenges.delete(oldest);
    }
    return {
      id,
      image: `data:image/png;base64,${renderCaptcha(text).toString('base64')}`,
      expiresAt: now + CHALLENGE_TTL_MS,
    };
  }

  /** Checks and consumes the challenge (a wrong answer burns it too). */
  verify(id: string | null | undefined, answer: string | null | undefined): boolean {
    if (typeof id !== 'string' || typeof answer !== 'string') return false;
    const challenge = this.#challenges.get(id);
    if (challenge === undefined) return false;
    this.#challenges.delete(id);
    if (challenge.expiresAt <= this.#now()) return false;
    return timingSafeEqual(digest(normalizeAnswer(answer)), challenge.answer);
  }

  /** Whether a sign-in with these keys (client address, username) must solve a challenge. */
  required(keys: readonly string[]): boolean {
    const now = this.#now();
    return keys.some((key) => this.#recent(key, now).length >= CAPTCHA_AFTER_FAILURES);
  }

  recordFailure(keys: readonly string[]): void {
    const now = this.#now();
    for (const key of keys) {
      this.#failures.set(key, [...this.#recent(key, now), now]);
      if (this.#failures.size > MAX_TRACKED_KEYS) {
        this.#failures.delete(this.#failures.keys().next().value as string);
      }
    }
  }

  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) this.#failures.delete(key);
  }

  #recent(key: string, now: Ms): Ms[] {
    return (this.#failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  }

  #sweep(now: Ms): void {
    for (const [id, c] of this.#challenges) if (c.expiresAt <= now) this.#challenges.delete(id);
  }
}

/** The keys a sign-in is tracked under. */
export function captchaKeys(ip: string, username: string): string[] {
  return [`ip:${ip}`, `user:${username.toLowerCase()}`];
}

// Kept on globalThis for the same reason as the login limiter: one instance per process across bundles.
const KEY = Symbol.for('freqdash.auth.captcha');
type GlobalWithCaptcha = typeof globalThis & { [KEY]?: CaptchaService };

export function getCaptchaService(): CaptchaService {
  const g = globalThis as GlobalWithCaptcha;
  g[KEY] ??= new CaptchaService();
  return g[KEY];
}

/** Test hook: install a service (or null to reset to a fresh default one). */
export function setCaptchaServiceForTests(service: CaptchaService | null): void {
  const g = globalThis as GlobalWithCaptcha;
  if (service === null) delete g[KEY];
  else g[KEY] = service;
}
