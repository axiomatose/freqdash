'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { cn } from './utils';

// 20 px box with a padded hit area (44 px on touch layouts) for the bulk-select rows in Findings and Trades.
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative size-5 shrink-0 rounded-[5px] border border-muted/60 bg-surface outline-none transition-colors before:absolute before:-inset-3 before:content-[''] lg:before:-inset-1.5",
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'data-[state=checked]:border-accent-strong data-[state=checked]:bg-accent-strong data-[state=indeterminate]:border-accent-strong data-[state=indeterminate]:bg-accent-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-white">
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
