import type { CSSProperties } from 'react';
import { cn } from '@/components/ui/utils';

/** Small filled circle in the bot's configured colour (from env), with a hairline ring so it reads on any surface. */
export function BotDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-full shadow-[0_0_0_2px_var(--color-surface)]', className)}
      style={{ backgroundColor: color } as CSSProperties}
    />
  );
}

/** Bot name chip: colour dot + name. The colour only identifies; the name is always there. */
export function BotBadge({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      data-slot="bot-badge"
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border bg-surface-2 px-1.5 py-0.5 text-[11px] leading-4 font-medium text-text',
        className,
      )}
    >
      <BotDot color={color} className="size-2 shadow-none" />
      <span className="truncate">{name}</span>
    </span>
  );
}
