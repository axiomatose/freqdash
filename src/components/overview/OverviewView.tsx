'use client';

import { FreshnessProvider, SkeletonCard } from '@/components/data';
import { BotCard } from '@/components/bots/BotCard';
import { EquityCard } from '@/components/equity/EquityCard';
import { useOverview, useSummary } from '@/lib/client/queries';
import type { OverviewResponse } from '@/shared/types/api';
import { AccountCard, accountSources } from './AccountCard';
import { AllocationCard } from './AllocationCard';
import { FindingsSummaryCard } from './FindingsSummaryCard';
import { Holdings } from './Holdings';
import { ManualPositions } from './ManualPositions';
import { OpenPositions } from './OpenPositions';
import { QueryBoundary } from './QueryBoundary';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 max-lg:order-5 lg:col-span-12">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Content({
  overview,
  rules,
  lastEvalAt,
}: {
  overview: OverviewResponse;
  rules: number | null;
  lastEvalAt: number | null;
}) {
  const bots = overview.bots.map((b) => ({ botId: b.botId, name: b.name, color: b.color }));
  const sources = accountSources(overview);
  const hasFindings =
    overview.findings.counts.critical + overview.findings.counts.warning + overview.findings.counts.info > 0;
  return (
    <FreshnessProvider sources={overview.sources}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5" data-testid="overview">
        <AccountCard overview={overview} className="max-lg:order-1 lg:col-span-4" />
        <FindingsSummaryCard
          overview={overview}
          rules={rules}
          lastEvalAt={lastEvalAt}
          className={`lg:order-none lg:col-span-4 lg:col-start-9 lg:row-start-2 ${hasFindings ? 'max-lg:order-2' : 'max-lg:order-6'}`}
        />
        <AllocationCard
          allocation={overview.allocation}
          bots={bots}
          sources={sources}
          className="max-lg:order-3 lg:col-span-8"
        />
        <EquityCard className="max-lg:order-7 lg:col-span-8 lg:row-start-2" />
        <div className="grid gap-4 max-lg:order-4 lg:col-span-12 lg:grid-cols-2 lg:gap-5">
          {overview.bots.map((b) => (
            <BotCard key={b.botId} bot={b} />
          ))}
        </div>
        <Section title="Open positions">
          <OpenPositions trades={overview.openPositions} bots={bots} />
        </Section>
        <Section title="Manual positions">
          <ManualPositions />
        </Section>
        <Section title="Holdings">
          <Holdings holdings={overview.allocation?.holdings ?? []} sources={sources} />
        </Section>
      </div>
    </FreshnessProvider>
  );
}

export function OverviewView() {
  const query = useOverview();
  const summary = useSummary();
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      <QueryBoundary query={query} skeleton={<SkeletonCard rows={8} />}>
        {(overview) => (
          <Content overview={overview} rules={null} lastEvalAt={summary.data?.monitor.lastEvalAt ?? null} />
        )}
      </QueryBoundary>
    </>
  );
}
