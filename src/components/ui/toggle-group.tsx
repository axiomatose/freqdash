'use client';

import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { cn } from './utils';

// Segmented control (range chips 24h/7d/30d, timeframe picker). Single-select groups should keep a value:
// Radix lets a user deselect the active item, so callers pass `onValueChange={(v) => v && setValue(v)}`.
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('inline-flex w-fit items-center gap-0.5 rounded-lg border bg-surface p-0.5', className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap text-muted outline-none transition-colors lg:min-h-7 lg:min-w-8 lg:px-2.5',
        'hover:text-text focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50',
        'data-[state=on]:bg-surface-2 data-[state=on]:text-text data-[state=on]:shadow-[inset_0_0_0_1px_var(--color-border)]',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
