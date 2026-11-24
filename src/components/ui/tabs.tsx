'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { cn } from './utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />;
}

// `pill` is a segmented control; `line` is an underlined tab strip for page sections.
const tabsListVariants = cva('inline-flex items-center', {
  variants: {
    variant: {
      pill: 'w-fit gap-0.5 rounded-lg border bg-surface p-0.5',
      line: 'w-full gap-1 overflow-x-auto border-b scrollbar-none',
    },
  },
  defaultVariants: { variant: 'pill' },
});

function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant ?? 'pill'}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3.5 text-sm font-medium text-muted outline-none transition-colors lg:min-h-8',
        'hover:text-text focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        // pill
        'in-data-[variant=pill]:rounded-md in-data-[variant=pill]:data-[state=active]:bg-surface-2 in-data-[variant=pill]:data-[state=active]:text-text in-data-[variant=pill]:data-[state=active]:shadow-[inset_0_0_0_1px_var(--color-border)]',
        // line
        'in-data-[variant=line]:-mb-px in-data-[variant=line]:flex-none in-data-[variant=line]:border-b-2 in-data-[variant=line]:border-transparent in-data-[variant=line]:data-[state=active]:border-accent in-data-[variant=line]:data-[state=active]:text-text',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
