import * as React from 'react';
import { cn } from './utils';

// 16 px text below lg keeps iOS Safari from zooming the page when a field is focused.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-lg border bg-surface px-3 text-base text-text outline-none transition-colors lg:h-9 lg:text-sm',
        'placeholder:text-muted/70 hover:bg-surface-2/60 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical aria-invalid:ring-critical/30',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
