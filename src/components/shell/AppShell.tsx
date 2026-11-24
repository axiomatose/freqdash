'use client';

import type { ReactNode } from 'react';
import { FreshnessProvider } from '@/components/data/FreshnessProvider';
import { AssistantPane } from '@/components/assistant/AssistantPane';
import { AssistantProvider, useAssistantPane } from '@/components/assistant/AssistantProvider';
import { SettingsProvider } from '@/components/settings/SettingsProvider';
import { useSummary } from '@/lib/client/queries';
import { BottomTabs } from './BottomTabs';
import { ConnectionBanner } from './ConnectionBanner';
import { FindingsBanner } from './FindingsBanner';
import { KillswitchBanner } from './KillswitchBanner';
import { ModeBanner } from './ModeBanner';
import { alertCount } from './nav';
import { Sidebar } from './Sidebar';
import { TabTitle } from './TabTitle';
import { TopBar } from './TopBar';

/**
 * The frame around every (app) page: sidebar (lg+), top bar, sticky banners, content, bottom tabs (below lg).
 * One summary query feeds the badges, the banners and the tab title; pages fetch their own data.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <AssistantProvider>
        <Frame>{children}</Frame>
        <AssistantPane />
      </AssistantProvider>
    </SettingsProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { open } = useAssistantPane();
  const summary = useSummary();
  const data = summary.data;
  const alerts = alertCount(data?.findings);
  const bots = data?.bots ?? [];
  const offline = summary.isError ? { since: summary.dataUpdatedAt || null } : null;

  return (
    <FreshnessProvider sources={data?.accountFreshness ? [data.accountFreshness] : []} offline={offline}>
      <>
        <TabTitle alerts={alerts} />
        <Sidebar bots={bots} alerts={alerts} hasCritical={(data?.findings.critical ?? 0) > 0} />
        <div
          data-assistant={open ? 'open' : 'closed'}
          className="min-h-dvh lg:pl-[var(--sidebar-w)] xl:data-[assistant=open]:pr-[var(--assistant-w)]"
        >
          <TopBar mode={data?.mode ?? null} bots={bots} />
          <div data-slot="banners" className="sticky top-[var(--shell-top)] z-30 empty:hidden">
            <ConnectionBanner />
            <KillswitchBanner />
            <FindingsBanner />
          </div>
          <main
            id="content"
            className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-4 pb-[calc(var(--shell-bottom)+1rem)] lg:gap-5 lg:px-6 lg:pt-6 lg:pb-8"
          >
            <ModeBanner />
            {children}
          </main>
        </div>
        <BottomTabs alerts={alerts} hasCritical={(data?.findings.critical ?? 0) > 0} bots={bots} />
      </>
    </FreshnessProvider>
  );
}
