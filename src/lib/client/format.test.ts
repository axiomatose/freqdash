import { describe, expect, it } from 'vitest';
import {
  DASH,
  formatAgo,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatFull,
  formatPct,
  formatPrice,
  formatQty,
  formatUsd,
  shortId,
  signTone,
  tabTitle,
} from './format';

describe('formatUsd', () => {
  it('prints 2 dp with grouping', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(293.7)).toBe('$293.70');
  });

  it('signs only when asked, negatives always', () => {
    expect(formatUsd(12.3, { signed: true })).toBe('+$12.30');
    expect(formatUsd(12.3)).toBe('$12.30');
    expect(formatUsd(-12.3)).toBe('-$12.30');
    expect(formatUsd(-12.3, { signed: true })).toBe('-$12.30');
  });

  it('never prints a signed zero', () => {
    expect(formatUsd(-0.004, { signed: true })).toBe('$0.00');
    expect(formatUsd(0.004, { signed: true })).toBe('$0.00');
  });

  it('renders null, undefined and NaN as a dash', () => {
    expect(formatUsd(null)).toBe(DASH);
    expect(formatUsd(undefined)).toBe(DASH);
    expect(formatUsd(Number.NaN)).toBe(DASH);
  });

  it('compacts thousands and millions', () => {
    expect(formatUsd(1_234, { compact: true })).toBe('$1.2k');
    expect(formatUsd(-2_500_000, { compact: true })).toBe('-$2.5M');
    expect(formatUsd(999, { compact: true })).toBe('$999.00');
  });
});

describe('formatQty', () => {
  it('keeps up to 8 dp and trims trailing zeros', () => {
    expect(formatQty(0.00046744)).toBe('0.00046744');
    expect(formatQty(0.1130240889)).toBe('0.11302409');
    expect(formatQty(2)).toBe('2');
    expect(formatQty(1.5)).toBe('1.5');
    expect(formatQty(1_901_628.18)).toBe('1,901,628.18');
  });

  it('shows dust as "<" instead of a misleading zero', () => {
    expect(formatQty(8.9e-9)).toBe('0.00000001');
    expect(formatQty(4e-9)).toBe('<0.00000001');
    expect(formatQty(0)).toBe('0');
  });

  it('signs', () => {
    expect(formatQty(0.5, { signed: true })).toBe('+0.5');
    expect(formatQty(-0.5)).toBe('-0.5');
  });

  it('honours a custom maximum', () => {
    expect(formatQty(1.23456, { maxDp: 2 })).toBe('1.23');
  });
});

describe('formatPrice', () => {
  it('uses adaptive precision', () => {
    expect(formatPrice(83_900)).toBe('$83,900.00');
    expect(formatPrice(3_230.456)).toBe('$3,230.46');
    expect(formatPrice(12.5)).toBe('$12.50');
    expect(formatPrice(1.23456)).toBe('$1.2346');
    expect(formatPrice(0.5432)).toBe('$0.5432');
    expect(formatPrice(0.00001)).toBe('$0.00001');
    expect(formatPrice(null)).toBe(DASH);
  });
});

describe('formatPct', () => {
  it('treats the input as a ratio', () => {
    expect(formatPct(0.0123)).toBe('1.23%');
    expect(formatPct(0.0123, { signed: true })).toBe('+1.23%');
    expect(formatPct(-0.05, { signed: true })).toBe('-5.00%');
    expect(formatPct(0.6, { dp: 0 })).toBe('60%');
    expect(formatPct(-0.00001, { signed: true })).toBe('0.00%');
    expect(formatPct(null)).toBe(DASH);
  });
});

describe('signTone', () => {
  it('judges the rounded value', () => {
    expect(signTone(1.2)).toBe('positive');
    expect(signTone(-1.2)).toBe('negative');
    expect(signTone(0)).toBe('neutral');
    expect(signTone(-0.001)).toBe('neutral');
    expect(signTone(null)).toBe('neutral');
  });
});

describe('formatCount', () => {
  it('groups integers', () => {
    expect(formatCount(26)).toBe('26');
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatCount(undefined)).toBe(DASH);
  });
});

describe('durations', () => {
  it('formats the two most significant units', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3 * 60_000 + 20_000)).toBe('3 min');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
    expect(formatDuration(2 * 3_600_000)).toBe('2 h');
    expect(formatDuration(4 * 86_400_000 + 3 * 3_600_000)).toBe('4 d 3 h');
    expect(formatDuration(-5)).toBe('0 s');
  });

  it('formats relative time with one unit', () => {
    const now = 1_000_000_000_000;
    expect(formatAgo(now - 1_000, now)).toBe('just now');
    expect(formatAgo(now + 5_000, now)).toBe('just now');
    expect(formatAgo(now - 12_000, now)).toBe('12 s ago');
    expect(formatAgo(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(formatAgo(now - 5 * 3_600_000, now)).toBe('5 h ago');
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3 d ago');
    expect(formatAgo(null, now)).toBe('never');
  });
});

describe('clock formatting', () => {
  const at = Date.UTC(2026, 8, 28, 4, 3, 59);

  it('renders UTC deterministically', () => {
    expect(formatClock(at, true)).toBe('04:03');
    expect(formatDate(at, true)).toBe('Sep 28');
    expect(formatDateTime(at, true)).toBe('Sep 28, 04:03 UTC');
    expect(formatFull(at, true)).toBe('2026-09-28 04:03:59 UTC');
  });

  it('renders local time without a suffix', () => {
    const local = new Date(at);
    const hh = String(local.getHours()).padStart(2, '0');
    const mm = String(local.getMinutes()).padStart(2, '0');
    expect(formatClock(at)).toBe(`${hh}:${mm}`);
    expect(formatDateTime(at)).not.toContain('UTC');
  });

  it('dashes missing timestamps', () => {
    expect(formatClock(null)).toBe(DASH);
    expect(formatDateTime(undefined)).toBe(DASH);
  });
});

describe('shortId', () => {
  it('shortens txids and leaves short ids alone', () => {
    expect(shortId('O6ROFS-APVH7-255LCC')).toBe('O6ROFS…5LCC');
    expect(shortId('OSHORT')).toBe('OSHORT');
  });
});

describe('tabTitle', () => {
  it('counts alerts in the title', () => {
    expect(tabTitle(0)).toBe('freqdash');
    expect(tabTitle(2)).toBe('(2) freqdash');
    expect(tabTitle(250)).toBe('(99+) freqdash');
  });
});
