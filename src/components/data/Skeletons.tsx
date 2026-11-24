import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/components/ui/utils';

// First-load placeholders. After the first response, pages keep the previous data (keepPreviousData) instead.

export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} role="status" aria-label="Loading">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-6 w-28" />
    </div>
  );
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function SkeletonCard({ className, rows = 3 }: { className?: string; rows?: number }) {
  return (
    <div
      className={cn('flex flex-col gap-4 rounded-xl border bg-surface p-4 lg:p-5', className)}
      role="status"
      aria-label="Loading"
    >
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-9 w-44" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: `${88 - i * 14}%` }} />
        ))}
      </div>
    </div>
  );
}
