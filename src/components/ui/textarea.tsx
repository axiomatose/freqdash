import * as React from 'react';
import { cn } from './utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-20 w-full rounded-lg border bg-surface px-3 py-2 text-base text-text outline-none transition-colors lg:text-sm',
        'placeholder:text-muted/70 hover:bg-surface-2/60 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical aria-invalid:ring-critical/30',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
