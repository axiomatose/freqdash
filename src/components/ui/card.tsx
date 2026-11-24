import * as React from 'react';
import { cn } from './utils';

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('flex flex-col rounded-xl border bg-surface text-text', className)}
      {...props}
    />
  );
}

/** Title row: title on the left, an optional action (button, chips) on the right. */
function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 pt-4 lg:px-5 lg:pt-5 [&:has([data-slot=card-action])]:items-center',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3 data-slot="card-title" className={cn('text-sm leading-tight font-semibold text-text', className)} {...props} />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('col-start-1 text-xs text-muted', className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 -my-2 self-center', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-4 py-4 lg:px-5', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t px-4 py-3 lg:px-5', className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter };
