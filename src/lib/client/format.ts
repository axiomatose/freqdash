// Pure display formatters shared by every page. Fixed en-US number formatting on purpose: output must not depend on
// the server or phone locale (hydration, tests and screenshots stay identical). Timestamps are epoch ms (Ms).
import type { Ms } from '@/shared/types/domain';

export const DASH = '—';

export type Tone = 'positive' | 'negative' | 'neutral';

const nf = new Map<string, Intl.NumberFormat>();
function numberFormat(minDp: number, maxDp: number): Intl.NumberFormat {
  const key = `${minDp}:${maxDp}`;
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: minDp, maximumFractionDigits: maxDp });
    nf.set(key, f);
  }
  return f;
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True when `v` prints as zero at `dp` decimals (so "-0.00" never appears). */
function roundsToZero(v: number, dp: number): boolean {
  return Math.abs(v) < 0.5 * 10 ** -dp;
}

/** Colour tone of a signed number, judged after rounding to `dp` so a tiny loss does not paint a red "$0.00". */
export function signTone(v: number | null | undefined, dp = 2): Tone {
  if (!isNum(v) || roundsToZero(v, dp)) return 'neutral';
  return v > 0 ? 'positive' : 'negative';
}

function withSign(text: string, v: number, dp: number, signed: boolean): string {
  if (roundsToZero(v, dp)) return text;
  if (v < 0) return `-${text}`;
  return signed ? `+${text}` : text;
}

export interface UsdOptions {
  /** Prefix "+" on positives (negatives always carry "-"). */
  signed?: boolean;
  dp?: number;
  /** 1.2k / 3.4M form for axis labels and tight legends. */
  compact?: boolean;
}

export function formatUsd(v: number | null | undefined, opts: UsdOptions = {}): string {
  if (!isNum(v)) return DASH;
  const dp = opts.dp ?? 2;
  const abs = Math.abs(v);
  let body: string;
  if (opts.compact && abs >= 1_000) {
    const [div, suffix] = abs >= 1_000_000 ? [1_000_000, 'M'] : [1_000, 'k'];
    body = `$${numberFormat(0, 1).format(abs / div)}${suffix}`;
  } else {
    body = `$${numberFormat(dp, dp).format(abs)}`;
  }
  return withSign(body, v, opts.compact && abs >= 1_000 ? 0 : dp, opts.signed ?? false);
}

export interface QtyOptions {
  /** Crypto quantities print up to 8 decimals with trailing zeros trimmed. */
  maxDp?: number;
  signed?: boolean;
}

export function formatQty(v: number | null | undefined, opts: QtyOptions = {}): string {
  if (!isNum(v)) return DASH;
  const maxDp = opts.maxDp ?? 8;
  if (v === 0) return '0';
  if (roundsToZero(v, maxDp))
    return `${v < 0 ? '-' : opts.signed ? '+' : ''}<${numberFormat(0, maxDp).format(10 ** -maxDp)}`;
  return withSign(numberFormat(0, maxDp).format(Math.abs(v)), v, maxDp, opts.signed ?? false);
}

/** Quote prices: 2 dp from 1000 up, 2 to 4 dp above 1, then enough decimals to show 4 significant digits (SHIB). */
export function formatPrice(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs === 0) return '$0.00';
  let text: string;
  if (abs >= 1_000) text = numberFormat(2, 2).format(abs);
  else if (abs >= 1) text = numberFormat(2, 4).format(abs);
  else {
    const dp = Math.min(8, Math.max(4, -Math.floor(Math.log10(abs)) + 3));
    text = numberFormat(4, dp).format(abs);
  }
  return `${v < 0 ? '-' : ''}$${text}`;
}

export interface PctOptions {
  signed?: boolean;
  dp?: number;
}

/** `ratio` is a fraction: 0.0123 prints "1.23%". */
export function formatPct(ratio: number | null | undefined, opts: PctOptions = {}): string {
  if (!isNum(ratio)) return DASH;
  const dp = opts.dp ?? 2;
  const points = ratio * 100;
  return withSign(`${numberFormat(dp, dp).format(Math.abs(points))}%`, points, dp, opts.signed ?? false);
}

export function formatCount(v: number | null | undefined): string {
  return isNum(v) ? numberFormat(0, 0).format(v) : DASH;
}

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Two most significant units: "45 s", "3 min", "2 h 5 min", "4 d 3 h". */
export function formatDuration(ms: number): string {
  if (!isNum(ms)) return DASH;
  const t = Math.max(0, ms);
  if (t < MIN) return `${Math.floor(t / SEC)} s`;
  if (t < HOUR) return `${Math.floor(t / MIN)} min`;
  if (t < DAY) {
    const h = Math.floor(t / HOUR);
    const m = Math.floor((t % HOUR) / MIN);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Single-unit relative time: "just now", "12 s ago", "3 min ago", "5 h ago", "2 d ago". */
export function formatAgo(at: Ms | null | undefined, now: Ms): string {
  if (!isNum(at)) return 'never';
  const age = now - at;
  if (age < 5 * SEC) return 'just now';
  if (age < MIN) return `${Math.floor(age / SEC)} s ago`;
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < 48 * HOUR) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function parts(at: Ms, utc: boolean): Parts {
  const dt = new Date(at);
  return utc
    ? {
        y: dt.getUTCFullYear(),
        mo: dt.getUTCMonth(),
        d: dt.getUTCDate(),
        h: dt.getUTCHours(),
        mi: dt.getUTCMinutes(),
        s: dt.getUTCSeconds(),
      }
    : {
        y: dt.getFullYear(),
        mo: dt.getMonth(),
        d: dt.getDate(),
        h: dt.getHours(),
        mi: dt.getMinutes(),
        s: dt.getSeconds(),
      };
}

/** "14:32" (24 h). */
export function formatClock(at: Ms | null | undefined, utc = false): string {
  if (!isNum(at)) return DASH;
  const p = parts(at, utc);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "Sep 28". */
export function formatDate(at: Ms | null | undefined, utc = false): string {
  if (!isNum(at)) return DASH;
  const p = parts(at, utc);
  return `${MONTHS[p.mo] ?? ''} ${p.d}`;
}

/** "Sep 28, 14:32" (UTC adds a suffix so it is never ambiguous). */
export function formatDateTime(at: Ms | null | undefined, utc = false): string {
  if (!isNum(at)) return DASH;
  return `${formatDate(at, utc)}, ${formatClock(at, utc)}${utc ? ' UTC' : ''}`;
}

/** "2026-09-28 14:32:05" for hover titles and evidence tables. */
export function formatFull(at: Ms | null | undefined, utc = false): string {
  if (!isNum(at)) return DASH;
  const p = parts(at, utc);
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${utc ? ' UTC' : ''}`;
}

/** "O6ROFS-APVH7-255LCC" -> "O6ROFS…5LCC" so txids fit a phone row. */
export function shortId(id: string, head = 6, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Browser tab title: `(N) freqdash` where N counts critical + warning findings. */
export function tabTitle(alerts: number): string {
  if (alerts <= 0) return 'freqdash';
  return `(${alerts > 99 ? '99+' : alerts}) freqdash`;
}
