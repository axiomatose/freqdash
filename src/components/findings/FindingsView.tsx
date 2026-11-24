'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck } from 'lucide-react';
import {
  EmptyState,
  ResponsiveTable,
  SeverityBadge,
  SkeletonCard,
  TimeAgo,
  useNow,
  type Column,
} from '@/components/data';
import { QueryBoundary } from '@/components/overview/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDuration } from '@/lib/client/format';
import { useFindings } from '@/lib/client/queries';
import type { FindingsStatusFilter } from '@/shared/types/api';
import type { Finding } from '@/shared/types/findings';
import { FindingDetail } from './FindingDetail';

const TABS: { value: Exclude<FindingsStatusFilter, 'all'>; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'silenced', label: 'Silenced' },
  { value: 'resolved', label: 'Resolved' },
];

function subjectChips(f: Finding): string[] {
  const s = f.subject;
  return [s.botId, s.pair, s.asset, s.orderId].filter((x): x is string => Boolean(x));
}

export function FindingsView() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'active') as (typeof TABS)[number]['value'];
  const selectedId = Number(params.get('id')) || null;
  const now = useNow();
  const q = useFindings({ status: tab });

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(`/findings${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const columns: Column<Finding>[] = [
    { key: 'sev', header: 'Severity', cell: (f) => <SeverityBadge severity={f.severity} />, card: 'aside' },
    { key: 'title', header: 'Finding', cell: (f) => <span className="font-medium">{f.title}</span>, card: 'title' },
    {
      key: 'subj',
      header: 'Subject',
      cell: (f) => (
        <span className="flex flex-wrap gap-1">
          {subjectChips(f).map((c) => (
            <Badge key={c} variant="muted">
              {c}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: 'first', header: 'First seen', cell: (f) => <TimeAgo at={f.firstSeenAt} />, className: 'text-muted' },
    {
      key: 'dur',
      header: 'Duration',
      cell: (f) => (now === null ? '—' : formatDuration(Math.max(0, (f.resolvedAt ?? now) - f.episodeStartAt))),
      className: 'text-muted',
    },
    {
      key: 'occ',
      header: 'Seen',
      align: 'right',
      cell: (f) => `${f.occurrences}×${f.flapCount ? ` · ${f.flapCount} flaps` : ''}`,
      className: 'text-muted',
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="findings-page">
      <h1 className="sr-only">Findings</h1>
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === 'active' ? null : v, id: null })}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <QueryBoundary query={q} skeleton={<SkeletonCard rows={6} />}>
        {(d) => (
          <>
            <ResponsiveTable
              caption={`${tab} findings`}
              columns={columns}
              rows={d.findings}
              rowKey={(f) => String(f.id)}
              onRowClick={(f) => set({ id: String(f.id) })}
              empty={
                <EmptyState
                  icon={CircleCheck}
                  title={tab === 'active' ? 'No findings' : `No ${tab} findings`}
                  description={
                    tab === 'active'
                      ? `All ${d.engine.rules || ''} checks passing${d.engine.lastEvalAt ? '' : ' (waiting for the first run)'}.`
                      : undefined
                  }
                />
              }
            />
            <p className="text-xs text-muted">
              Engine: {d.engine.rules} rules · last run <TimeAgo at={d.engine.lastEvalAt} /> · mode {d.engine.mode}
            </p>
            <FindingDetail
              finding={d.findings.find((f) => f.id === selectedId) ?? null}
              onClose={() => set({ id: null })}
            />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
