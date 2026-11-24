'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import type { SummaryResponse } from '@/shared/types/api';
import { AlertBadge } from './AlertBadge';
import { MoreSheet } from './MoreSheet';
import { TAB_ITEMS, isActive, isMoreActive } from './nav';

const TAB =
  'relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';

export interface BottomTabsProps {
  alerts: number;
  hasCritical: boolean;
  bots: SummaryResponse['bots'];
}

/**
 * Phone navigation: Overview, Chart, Trades, Alerts (badge) and More (sheet). 56 px tall plus the home-indicator
 * safe area; every tab is a full-height, one-fifth-width tap target.
 */
export function BottomTabs({ alerts, hasCritical, bots }: BottomTabsProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = isMoreActive(pathname);

  return (
    <>
      <nav
        aria-label="Primary"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-surface/95 backdrop-blur-md supports-[backdrop-filter]:bg-surface/85 lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {TAB_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href} className="min-w-0">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(TAB, active ? 'text-text' : 'text-muted')}
                >
                  <TabIndicator active={active} />
                  <span className="relative">
                    <Icon
                      aria-hidden
                      className={cn('size-[22px]', active && 'text-accent')}
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    {item.alerts ? (
                      <AlertBadge count={alerts} critical={hasCritical} className="absolute -top-1.5 left-3" />
                    ) : null}
                  </span>
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="min-w-0">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(TAB, 'w-full', moreActive ? 'text-text' : 'text-muted')}
            >
              <TabIndicator active={moreActive} />
              <Ellipsis
                aria-hidden
                className={cn('size-[22px]', moreActive && 'text-accent')}
                strokeWidth={moreActive ? 2.25 : 1.75}
              />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} bots={bots} />
    </>
  );
}

function TabIndicator({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute top-0 h-0.5 w-8 rounded-full bg-accent transition-opacity',
        active ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}
