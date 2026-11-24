'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BotDot } from '@/components/data/BotBadge';
import { StatusDot } from '@/components/data/StatusPill';
import { cn } from '@/components/ui/utils';
import { APP_VERSION } from '@/shared/constants';
import type { SummaryResponse } from '@/shared/types/api';
import { AlertBadge } from './AlertBadge';
import { Logo } from './Logo';
import { NAV_MAIN, NAV_STATUS, isActive, type NavItem } from './nav';

const LINK =
  'relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted outline-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent aria-[current=page]:bg-surface-2 aria-[current=page]:text-text';
const ACTIVE_BAR =
  "aria-[current=page]:before:absolute aria-[current=page]:before:top-1/2 aria-[current=page]:before:-left-2.5 aria-[current=page]:before:h-4 aria-[current=page]:before:w-[3px] aria-[current=page]:before:-translate-y-1/2 aria-[current=page]:before:rounded-r-full aria-[current=page]:before:bg-accent aria-[current=page]:before:content-['']";

export interface SidebarProps {
  bots: SummaryResponse['bots'];
  alerts: number;
  hasCritical: boolean;
}

/** Desktop navigation (lg and up): a fixed 240 px column. Phones use BottomTabs instead. */
export function Sidebar({ bots, alerts, hasCritical }: SidebarProps) {
  const pathname = usePathname();
  return (
    <aside
      data-slot="sidebar"
      className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-w)] flex-col border-r bg-surface lg:flex"
    >
      <Link
        href="/"
        className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight text-text">freqdash</span>
      </Link>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV_MAIN.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isActive(pathname, item.href)} alerts={alerts} hasCritical={hasCritical} />
            </li>
          ))}
        </ul>

        {bots.length > 0 ? (
          <div>
            <h2 className="eyebrow px-2.5 pb-1.5">Bots</h2>
            <ul className="flex flex-col gap-0.5">
              {bots.map((b) => {
                const href = `/bots/${encodeURIComponent(b.botId)}`;
                const active = isActive(pathname, href);
                return (
                  <li key={b.botId}>
                    <Link href={href} aria-current={active ? 'page' : undefined} className={cn(LINK, ACTIVE_BAR)}>
                      <BotDot color={b.color} />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <StatusDot status={b.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <ul className="mt-auto flex flex-col gap-0.5">
          <li>
            <NavLink item={NAV_STATUS} active={isActive(pathname, NAV_STATUS.href)} alerts={0} hasCritical={false} />
          </li>
        </ul>
      </nav>

      <div className="shrink-0 border-t px-4 py-3 text-[11px] text-muted">
        <p>Read-only monitor</p>
        <p className="tabular-nums">v{APP_VERSION}</p>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  active,
  alerts,
  hasCritical,
}: {
  item: NavItem;
  active: boolean;
  alerts: number;
  hasCritical: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-current={active ? 'page' : undefined} className={cn(LINK, ACTIVE_BAR)}>
      <Icon aria-hidden className={cn('size-4 shrink-0', active && 'text-accent')} />
      <span className="flex-1">{item.label}</span>
      {item.alerts ? <AlertBadge count={alerts} critical={hasCritical} /> : null}
    </Link>
  );
}
