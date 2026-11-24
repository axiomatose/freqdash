'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useAssistantPane } from '@/components/assistant/AssistantProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useIsDesktop } from '@/lib/client/useMediaQuery';
import type { SummaryResponse } from '@/shared/types/api';
import { Logo } from './Logo';
import { ModeBadge } from './ModeBadge';
import { MonitorIndicator } from './MonitorIndicator';
import { pageTitle } from './nav';
import { UserMenu } from './UserMenu';

export interface TopBarProps {
  mode: SummaryResponse['mode'] | null;
  bots: SummaryResponse['bots'];
}

/**
 * Phone: app bar with the page title, monitor status and a refresh button.
 * Desktop: page title on the left; monitor indicator, mode badge, refresh and the user menu on the right.
 */
export function TopBar({ mode, bots }: TopBarProps) {
  const pathname = usePathname();
  const qc = useQueryClient();
  const fetching = useIsFetching() > 0;
  const desktop = useIsDesktop();
  const assistant = useAssistantPane();
  const title = pageTitle(pathname, (id) => bots.find((b) => b.botId === id)?.name);

  return (
    <header
      data-slot="top-bar"
      className="pt-safe sticky top-0 z-40 flex h-[var(--shell-top)] items-center gap-3 border-b bg-bg/90 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-bg/80 lg:px-6"
    >
      <Link
        href="/"
        aria-label="freqdash home"
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
      >
        <Logo className="size-7" />
      </Link>
      <p
        data-slot="page-title"
        className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-text lg:text-base"
      >
        {title}
      </p>

      <div className="flex shrink-0 items-center gap-1 lg:gap-3">
        {/* Mode badge: always on desktop; on phones only when it is the warning (the banner carries the detail). */}
        {mode ? <ModeBadge mode={mode} className={cn(mode === 'kraken' && 'hidden lg:inline-flex')} /> : null}
        <MonitorIndicator compact={!desktop} />
        <Button
          variant="ghost"
          size="icon"
          onClick={assistant.toggle}
          aria-label="Assistant"
          aria-expanded={assistant.open}
          aria-controls="assistant-pane"
          title={assistant.open ? 'Collapse assistant' : 'Open assistant'}
          className={cn('text-muted hover:text-text', assistant.open && 'text-accent')}
        >
          <Sparkles aria-hidden className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void qc.invalidateQueries()}
          aria-label="Refresh data"
          title="Refresh data"
          className="-mr-2 text-muted hover:text-text lg:mr-0"
        >
          <RefreshCw aria-hidden className={cn('size-4', fetching && 'motion-safe:animate-spin')} />
        </Button>
        <div className="hidden lg:block">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
