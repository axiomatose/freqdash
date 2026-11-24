import * as React from 'react';
import { cn } from './utils';

// Dense data table. The wrapper scrolls horizontally on its own so a wide table never widens the page.
// Below md, prefer ResponsiveTable (components/data), which swaps tables for card lists.
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'table'> & { containerClassName?: string }) {
  return (
    <div data-slot="table-container" className={cn('relative w-full overflow-x-auto', containerClassName)}>
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-[13px]', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot data-slot="table-footer" className={cn('border-t bg-surface-2/50 font-medium', className)} {...props} />
  );
}
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b transition-colors hover:bg-surface-2/60 data-[state=selected]:bg-surface-2', className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-9 px-3 text-left align-middle text-[11px] font-medium tracking-wider whitespace-nowrap text-muted uppercase first:pl-4 last:pr-4 data-[align=right]:text-right data-[align=center]:text-center',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'h-10 px-3 align-middle whitespace-nowrap first:pl-4 last:pr-4 data-[align=right]:text-right data-[align=center]:text-center',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 text-xs text-muted', className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
