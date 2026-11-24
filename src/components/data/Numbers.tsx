import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import { DASH, formatPct, formatPrice, formatQty, formatUsd, isNum, signTone, type Tone } from '@/lib/client/format';

// Numbers are plain spans (no client state): they render in server and client components alike. Signs are always
// printed as "+"/"-" characters, so colour reinforces the sign and never carries it alone.

const TONE: Record<Tone, string> = { positive: 'text-positive', negative: 'text-negative', neutral: 'text-muted' };

function Empty({ className }: { className?: string }) {
  return <span className={cn('text-muted', className)}>{DASH}</span>;
}

interface NumberProps {
  value: number | null | undefined;
  /** Print "+" on positives and colour by sign. */
  signed?: boolean;
  /** Colour by sign without forcing a "+" (default: same as `signed`). */
  colored?: boolean;
  className?: string;
}

function toneClass(value: number, dp: number, colored: boolean): string | undefined {
  return colored ? TONE[signTone(value, dp)] : undefined;
}

/** USD with 2 dp: $1,234.56, -$12.30, +$3.42 (signed). */
export function Money({
  value,
  signed = false,
  colored = signed,
  dp = 2,
  compact = false,
  className,
}: NumberProps & { dp?: number; compact?: boolean }) {
  if (!isNum(value)) return <Empty className={className} />;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', toneClass(value, dp, colored), className)}>
      {formatUsd(value, { signed, dp, compact })}
    </span>
  );
}

/** Quote price with adaptive decimals ($83,900.00, $0.00001). */
export function Price({ value, className }: { value: number | null | undefined; className?: string }) {
  if (!isNum(value)) return <Empty className={className} />;
  return <span className={cn('whitespace-nowrap tabular-nums', className)}>{formatPrice(value)}</span>;
}

/** Crypto quantity, up to 8 dp with trailing zeros trimmed, optionally followed by the asset symbol. */
export function Qty({
  value,
  asset,
  signed = false,
  colored = signed,
  maxDp = 8,
  className,
}: NumberProps & { asset?: string; maxDp?: number }) {
  if (!isNum(value)) return <Empty className={className} />;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', toneClass(value, maxDp, colored), className)}>
      {formatQty(value, { signed, maxDp })}
      {asset ? <span className="ml-1 text-muted">{asset}</span> : null}
    </span>
  );
}

/** Percent from a ratio: `<Pct value={0.0123} />` prints 1.23%. `points` takes a value already in percent points. */
export function Pct({
  value,
  points,
  signed = false,
  colored = signed,
  dp = 2,
  className,
}: NumberProps & { dp?: number; points?: number | null }) {
  const ratio = points !== undefined ? (points === null ? null : points / 100) : value;
  if (!isNum(ratio)) return <Empty className={className} />;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', toneClass(ratio * 100, dp, colored), className)}>
      {formatPct(ratio, { signed, dp })}
    </span>
  );
}

/** Profit/loss pair: "+$3.42 · +0.55%", coloured by the dollar sign (percent sign when there is no dollar figure). */
export function Pnl({
  usd,
  pct,
  className,
  separator = ' · ',
}: {
  usd?: number | null;
  pct?: number | null;
  className?: string;
  separator?: ReactNode;
}) {
  const lead = isNum(usd) ? usd : isNum(pct) ? pct : null;
  if (lead === null) return <Empty className={className} />;
  const tone = TONE[signTone(lead, isNum(usd) ? 2 : 4)];
  return (
    <span className={cn('whitespace-nowrap tabular-nums', tone, className)}>
      {isNum(usd) ? formatUsd(usd, { signed: true }) : null}
      {isNum(usd) && isNum(pct) ? separator : null}
      {isNum(pct) ? formatPct(pct, { signed: true }) : null}
    </span>
  );
}
