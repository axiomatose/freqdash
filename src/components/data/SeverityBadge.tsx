import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/utils';
import type { Severity } from '@/shared/types/domain';

export const SEVERITY: Record<
  Severity,
  { label: string; icon: LucideIcon; badge: 'critical' | 'warning' | 'info'; text: string }
> = {
  critical: { label: 'Critical', icon: OctagonAlert, badge: 'critical', text: 'text-critical-fg' },
  warning: { label: 'Warning', icon: TriangleAlert, badge: 'warning', text: 'text-warning' },
  info: { label: 'Info', icon: Info, badge: 'info', text: 'text-info-fg' },
};

/** Severity is always an icon plus a word, never a colour alone. */
export function SeverityBadge({
  severity,
  label,
  className,
}: {
  severity: Severity;
  label?: string;
  className?: string;
}) {
  const cfg = SEVERITY[severity];
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.badge} className={className} data-severity={severity}>
      <Icon aria-hidden />
      {label ?? cfg.label}
    </Badge>
  );
}

/** The bare icon (with an accessible name) for dense rows where the title already says what happened. */
export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const cfg = SEVERITY[severity];
  const Icon = cfg.icon;
  return <Icon role="img" aria-label={cfg.label} className={cn('size-4 shrink-0', cfg.text, className)} />;
}
