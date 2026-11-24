'use client';

import * as React from 'react';
import { useIsDesktop } from '@/lib/client/useMediaQuery';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from './drawer';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from './sheet';

export interface ResponsiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Action bar: sticky at the bottom of the sheet (respects the safe area on phones). */
  footer?: React.ReactNode;
  /** Mobile only: `full` fills the screen (long detail views), `auto` sizes to content. */
  mobileSize?: 'auto' | 'full';
  className?: string;
}

/**
 * The plan's "sheets instead of dialogs" rule in one component: a right-hand side panel from lg up and a vaul
 * bottom sheet below it. The breakpoint is read after mount, so the server never renders either.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  mobileSize = 'auto',
  className,
}: ResponsiveSheetProps) {
  const desktop = useIsDesktop();

  if (desktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className={className}>
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            {description ? (
              <SheetDescription>{description}</SheetDescription>
            ) : (
              <SheetDescription className="sr-only">{title}</SheetDescription>
            )}
          </SheetHeader>
          <SheetBody>{children}</SheetBody>
          {footer ? <SheetFooter>{footer}</SheetFooter> : null}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent size={mobileSize} className={className}>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          {description ? (
            <DrawerDescription>{description}</DrawerDescription>
          ) : (
            <DrawerDescription className="sr-only">{title}</DrawerDescription>
          )}
        </DrawerHeader>
        <DrawerBody>{children}</DrawerBody>
        {footer ? <DrawerFooter>{footer}</DrawerFooter> : <div className="pb-safe" />}
      </DrawerContent>
    </Drawer>
  );
}
