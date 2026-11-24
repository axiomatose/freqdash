'use client';

import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { SeverityBadge, SeverityIcon, TimeAgo } from '@/components/data';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { OverviewResponse } from '@/shared/types/api';

export function FindingsSummaryCard({
  overview,
  rules,
  lastEvalAt,
  className,
}: {
  overview: OverviewResponse;
  rules: number | null;
  lastEvalAt: number | null;
  className?: string;
}) {
  const { counts, top } = overview.findings;
  const total = counts.critical + counts.warning + counts.info;
  return (
    <Card className={className} data-testid="findings-card">
      <CardHeader>
        <CardTitle>Findings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {total === 0 ? (
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck aria-hidden className="size-4 text-positive" />
            <span>
              All clear
              {rules ? ` · ${rules} rules` : ''}
              {lastEvalAt ? (
                <>
                  {' · checked '}
                  <TimeAgo at={lastEvalAt} />
                </>
              ) : null}
            </span>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              {counts.critical > 0 ? <SeverityBadge severity="critical" label={`${counts.critical} critical`} /> : null}
              {counts.warning > 0 ? <SeverityBadge severity="warning" label={`${counts.warning} warning`} /> : null}
              {counts.info > 0 ? <SeverityBadge severity="info" label={`${counts.info} info`} /> : null}
            </div>
            <ul className="flex flex-col gap-1.5 text-sm">
              {top.map((f) => (
                <li key={f.id} className="flex items-baseline gap-2">
                  <SeverityIcon severity={f.severity} />
                  <Link href={`/findings?id=${f.id}`} className="min-w-0 truncate hover:underline">
                    {f.title}
                  </Link>
                </li>
              ))}
            </ul>
            <Link href="/findings" className="text-sm text-accent hover:underline">
              View all findings
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
