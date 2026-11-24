import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** A button or link, for example "Kraken setup". */
  action?: ReactNode;
  /** Tighter padding for use inside a card or table body. */
  compact?: boolean;
  bordered?: boolean;
  className?: string;
}

/** Calm "nothing here" panel: "No open positions", "No findings: all 22 checks passing, last run 5 s ago". */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact,
  bordered,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
        bordered && 'rounded-xl border border-dashed',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full border bg-surface-2 text-muted',
          compact ? 'size-9' : 'size-11',
        )}
      >
        <Icon aria-hidden className={compact ? 'size-4' : 'size-5'} />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-text">{title}</p>
        {description ? <p className="text-[13px] text-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
