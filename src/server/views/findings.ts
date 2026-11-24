import type { FindingsResponse, FindingsStatusFilter } from '@/shared/types/api';
import type { Severity } from '@/shared/types/domain';
import type { Finding } from '@/shared/types/findings';
import { listFindings } from '../db';
import { countBySeverity, modeOf, shownFindings, type ViewContext } from './common';

export interface FindingsQuery {
  status?: FindingsStatusFilter | undefined;
  severity?: Severity | undefined;
  limit?: number | undefined;
}

export function buildFindings(ctx: ViewContext, q: FindingsQuery): FindingsResponse {
  const status = q.status ?? 'active';
  const limit = q.limit ?? 200;
  const active = listFindings({ status: 'active' });
  const { open, silenced } = shownFindings(active);
  const resolved24h = listFindings({ resolvedSince: ctx.now - 24 * 3_600_000 });

  let rows: Finding[];
  if (status === 'active') rows = open;
  else if (status === 'silenced') rows = silenced;
  else if (status === 'resolved') rows = listFindings({ status: 'resolved', limit: 500 });
  else rows = [...open, ...silenced, ...listFindings({ status: 'resolved', limit: 500 })];
  if (q.severity !== undefined) rows = rows.filter((f) => f.severity === q.severity);

  return {
    generatedAt: ctx.now,
    findings: rows.slice(0, limit),
    counts: { ...countBySeverity(open), silenced: silenced.length, resolved24h: resolved24h.length },
    engine: {
      lastEvalAt: ctx.state.monitor.lastEvalAt,
      rules: ctx.state.monitor.rulesEvaluated,
      mode: modeOf(ctx).mode,
    },
  };
}
