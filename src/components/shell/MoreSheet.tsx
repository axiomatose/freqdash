'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { Activity, Bell, ChevronRight, KeyRound, LogOut, Settings } from 'lucide-react';
import { useSettingsPanel } from '@/components/settings/SettingsProvider';
import { BotDot } from '@/components/data/BotBadge';
import { StatusDot } from '@/components/data/StatusPill';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/components/ui/utils';
import { useLogout, useSession } from '@/lib/client/queries';
import type { SummaryResponse } from '@/shared/types/api';
import { isActive } from './nav';

const ROW =
  'flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium text-text outline-none transition-colors hover:bg-surface-2 active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent';

export interface MoreSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: SummaryResponse['bots'];
}

/** Mobile "More" sheet (vaul): the bots, Status, and Logout. */
export function MoreSheet({ open, onOpenChange, bots }: MoreSheetProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const logout = useLogout();
  const settings = useSettingsPanel();

  // Navigating from inside the sheet must not leave it hanging open over the new page.
  useEffect(() => {
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>More</DrawerTitle>
          <DrawerDescription>
            {session?.name ? `Signed in as ${session.name}` : 'Bots, system status and sign out'}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="pb-2">
          {bots.length > 0 ? (
            <section aria-labelledby="more-bots" className="mb-3">
              <h2 id="more-bots" className="eyebrow px-3 pb-1">
                Bots
              </h2>
              <ul>
                {bots.map((b) => (
                  <li key={b.botId}>
                    <Link
                      href={`/bots/${encodeURIComponent(b.botId)}`}
                      aria-current={isActive(pathname, `/bots/${b.botId}`) ? 'page' : undefined}
                      className={cn(ROW, isActive(pathname, `/bots/${b.botId}`) && 'bg-surface-2')}
                    >
                      <BotDot color={b.color} />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <StatusDot status={b.status} showLabel />
                      <ChevronRight aria-hidden className="size-4 text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="more-system">
            <h2 id="more-system" className="eyebrow px-3 pb-1">
              System
            </h2>
            <ul>
              <li>
                <Link
                  href="/status"
                  aria-current={isActive(pathname, '/status') ? 'page' : undefined}
                  className={cn(ROW, isActive(pathname, '/status') && 'bg-surface-2')}
                >
                  <Activity aria-hidden className="size-4 text-muted" />
                  <span className="flex-1">Status</span>
                  <ChevronRight aria-hidden className="size-4 text-muted" />
                </Link>
              </li>
              <li>
                <button
                  type="button"
                  className={cn(ROW, 'w-full text-left')}
                  onClick={() => {
                    onOpenChange(false);
                    settings.open();
                  }}
                >
                  <Settings aria-hidden className="size-4 text-muted" />
                  <span className="flex-1">Settings</span>
                  <ChevronRight aria-hidden className="size-4 text-muted" />
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={cn(ROW, 'w-full text-left')}
                  onClick={() => {
                    onOpenChange(false);
                    settings.open('notifications');
                  }}
                >
                  <Bell aria-hidden className="size-4 text-muted" />
                  <span className="flex-1">Notifications</span>
                  <ChevronRight aria-hidden className="size-4 text-muted" />
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={cn(ROW, 'w-full text-left')}
                  onClick={() => {
                    onOpenChange(false);
                    settings.open('account');
                  }}
                >
                  <KeyRound aria-hidden className="size-4 text-muted" />
                  <span className="flex-1">Account and sessions</span>
                  <ChevronRight aria-hidden className="size-4 text-muted" />
                </button>
              </li>
            </ul>
          </section>
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="secondary"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="w-full justify-center"
          >
            <LogOut aria-hidden />
            Log out
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
