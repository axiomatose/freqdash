import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from './utils';

// Tinted chips: the text colour is chosen for AA contrast on its own tint, and meaning is always carried by
// the label (and an icon where it is a severity or status), never by colour alone.
const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5',
    'text-[11px] leading-4 font-medium [&>svg]:pointer-events-none [&>svg]:size-3',
  ],
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-2 text-text',
        muted: 'border-border bg-transparent text-muted',
        accent: 'border-accent/30 bg-accent/12 text-accent',
        positive: 'border-positive/30 bg-positive/12 text-positive',
        negative: 'border-negative/30 bg-negative/12 text-negative',
        warning: 'border-warning/35 bg-warning/12 text-warning',
        critical: 'border-critical/40 bg-critical/15 text-critical-fg',
        info: 'border-info/40 bg-info/15 text-info-fg',
        outline: 'border-border bg-transparent text-text',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
