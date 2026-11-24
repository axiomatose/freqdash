import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  KeyRound,
  PauseCircle,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/utils';
import type { BotStatusPill } from '@/shared/types/api';

type Variant = 'positive' | 'warning' | 'critical' | 'muted';

export const BOT_STATUS: Record<
  BotStatusPill,
  { label: string; icon: LucideIcon; variant: Variant; dot: string; spin?: boolean }
> = {
  running: { label: 'Running', icon: CircleCheck, variant: 'positive', dot: 'bg-positive' },
  restarting: { label: 'Restarting', icon: RefreshCw, variant: 'warning', dot: 'bg-warning', spin: true },
  stale: { label: 'Stale', icon: Clock, variant: 'warning', dot: 'bg-warning' },
  down: { label: 'Down', icon: CircleX, variant: 'critical', dot: 'bg-critical' },
  auth_error: { label: 'Auth error', icon: KeyRound, variant: 'critical', dot: 'bg-critical' },
  stopped: { label: 'Stopped', icon: PauseCircle, variant: 'muted', dot: 'bg-muted' },
  unknown: { label: 'Unknown', icon: CircleHelp, variant: 'muted', dot: 'bg-muted' },
};

/** Bot health as icon + word. */
export function StatusPill({ status, className }: { status: BotStatusPill; className?: string }) {
  const cfg = BOT_STATUS[status];
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className={className} data-status={status}>
      <Icon aria-hidden className={cn(cfg.spin && 'motion-safe:animate-spin')} />
      {cfg.label}
    </Badge>
  );
}

/** Compact status marker for the sidebar: a dot, plus the word whenever the bot is not simply running. */
export function StatusDot({
  status,
  className,
  showLabel,
}: {
  status: BotStatusPill;
  className?: string;
  showLabel?: boolean;
}) {
  const cfg = BOT_STATUS[status];
  const label = showLabel ?? status !== 'running';
  return (
    <span data-status={status} className={cn('inline-flex items-center gap-1.5 text-[11px] text-muted', className)}>
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', cfg.dot)} />
      {label ? <span>{cfg.label}</span> : <span className="sr-only">{cfg.label}</span>}
    </span>
  );
}
