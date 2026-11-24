import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from './utils';

// Sizes are 44 px tall below lg (touch) and compact from lg up (pointer).
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium',
    'transition-colors outline-none select-none',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-accent-strong text-white hover:bg-[#2f5cc4] active:bg-[#2a53b3]',
        secondary: 'border bg-surface-2 text-text hover:bg-hover',
        outline: 'border bg-transparent text-text hover:bg-surface-2',
        ghost: 'text-muted hover:bg-surface-2 hover:text-text',
        destructive: 'border border-critical/40 bg-critical/15 text-critical-fg hover:bg-critical/25',
        link: 'h-auto min-h-0 px-0 text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-4 lg:h-9 lg:px-3.5',
        sm: 'h-10 px-3 text-[13px] lg:h-8 lg:px-3',
        lg: 'h-12 px-5 text-[15px] lg:h-10',
        icon: 'size-11 lg:size-9',
        'icon-sm': 'size-10 lg:size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
