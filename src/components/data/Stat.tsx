import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

const VALUE_SIZE = {
  sm: 'text-sm font-medium',
  md: 'text-lg font-semibold tracking-tight',
  lg: 'text-2xl font-semibold tracking-tight',
  hero: 'text-[2rem] leading-none font-semibold tracking-tight lg:text-[2.5rem]',
} as const;

export interface StatProps {
  label: ReactNode;
  /** Usually a <Metric/>, <Money/> or <Pct/>. */
  value: ReactNode;
  /** Secondary line under the value (a 24h change, a caption). */
  sub?: ReactNode;
  size?: keyof typeof VALUE_SIZE;
  align?: 'start' | 'end';
  className?: string;
}

/** Overline label + number + optional caption: the building block for hero totals and bot stat grids. */
export function Stat({ label, value, sub, size = 'md', align = 'start', className }: StatProps) {
  return (
    <div
      data-slot="stat"
      className={cn('flex min-w-0 flex-col gap-1', align === 'end' && 'items-end text-right', className)}
    >
      <div className="eyebrow">{label}</div>
      <div className={cn('min-w-0 text-text', VALUE_SIZE[size])}>{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}
