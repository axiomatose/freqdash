import type { Allocation } from '@/shared/types/domain';

export interface AllocationSegment {
  key: string;
  label: string;
  usd: number;
  /** Share of the total, 0..100. */
  pct: number;
  /** Bot colour or a theme colour; `untracked` uses the striped utility class instead. */
  color: string | null;
  striped: boolean;
}

/** The stacked bar's segments in the order of docs/PLAN.md section 9. Zero-value segments are dropped. */
export function allocationSegments(
  allocation: Allocation,
  bots: readonly { botId: string; name: string; color: string }[],
): AllocationSegment[] {
  const total = allocation.totalUsd > 0 ? allocation.totalUsd : 1;
  const seg = (key: string, label: string, usd: number, color: string | null, striped = false): AllocationSegment => ({
    key,
    label,
    usd,
    pct: Math.max(0, (usd / total) * 100),
    color,
    striped,
  });
  const out: AllocationSegment[] = [seg('cash', 'USD cash', allocation.usdCash, 'var(--color-positive)')];
  for (const p of allocation.botPositions) {
    const bot = bots.find((b) => b.botId === p.botId);
    out.push(seg(`bot:${p.botId}`, bot?.name ?? p.botId, p.valueUsd, bot?.color ?? 'var(--color-accent)'));
  }
  out.push(seg('manual', 'Manual', allocation.acknowledgedUsd, 'var(--color-muted)'));
  out.push(seg('untracked', 'Untracked', allocation.untrackedUsd, null, true));
  out.push(seg('dust', 'Dust', allocation.dustUsd, 'var(--color-border)'));
  return out.filter((s) => s.usd > 0.005);
}
