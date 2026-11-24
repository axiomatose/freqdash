'use client';

import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from './utils';

// Mobile bottom sheet (vaul): drag down to dismiss, safe-area padding at the bottom.
function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}
function DrawerTrigger(props: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}
function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerContent({
  className,
  children,
  /** `full` fills the screen below the status bar (finding detail); `auto` sizes to content up to 88 dvh. */
  size = 'auto',
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & { size?: 'auto' | 'full' }) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Overlay data-slot="drawer-overlay" className="fixed inset-0 z-50 bg-black/65" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border border-b-0 bg-surface text-text shadow-pop outline-none',
          size === 'full' ? 'h-[calc(100dvh-1.5rem-env(safe-area-inset-top))]' : 'max-h-[88dvh]',
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto mt-2.5 mb-1 h-1.5 w-11 shrink-0 rounded-full bg-border" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-1 px-5 pt-2 pb-3', className)} {...props} />;
}
function DrawerBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-body" className={cn('min-h-0 flex-1 overflow-y-auto px-5', className)} {...props} />;
}
function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        'mt-auto flex flex-col gap-2 border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}
function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-base leading-tight font-semibold', className)}
      {...props}
    />
  );
}
function DrawerDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
};
