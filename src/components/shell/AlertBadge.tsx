import { cn } from '@/components/ui/utils';

/** Count bubble for critical + warning findings. Hidden at zero. Red while any critical finding is open. */
export function AlertBadge({ count, critical, className }: { count: number; critical: boolean; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      role="img"
      aria-label={`${count} ${critical ? 'critical or warning' : 'warning'} finding${count === 1 ? '' : 's'}`}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border px-1 text-[11px] leading-none font-semibold',
        critical ? 'border-critical/50 bg-[#c4343a] text-white' : 'border-warning/50 bg-warning text-[#1a1204]',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
