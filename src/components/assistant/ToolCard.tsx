'use client';

import { useState } from 'react';
import { ChevronRight, CircleX, Hand, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { ChatItem } from './model';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const NAME: Record<string, string> = {
  get_summary: 'Summary',
  get_overview: 'Overview',
  get_bot: 'Bot',
  list_trades: 'Trades',
  list_kraken_orders: 'Kraken orders',
  list_findings: 'Findings',
  get_finding: 'Finding',
  get_equity: 'Equity history',
  get_status: 'Data sources',
  get_killswitch: 'Killswitch',
  list_acks: 'Acknowledgements',
  get_strategies: 'Strategies',
  get_chart: 'Chart',
  list_events: 'Bot events',
  recall_memories: 'Memories',
  save_memory: 'Save memory',
  delete_memory: 'Delete memory',
  silence_finding: 'Silence finding',
  unsilence_finding: 'Unsilence finding',
  create_acks: 'Acknowledge',
  revoke_ack: 'Revoke acknowledgement',
  send_test_notification: 'Test notification',
  reset_killswitch: 'Reset killswitch',
};
export const toolTitle = (name: string): string => NAME[name] ?? name;

function prettyArgs(raw: string): string {
  try {
    const o = JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.keys(o).length === 0 ? '' : JSON.stringify(o, null, 2);
  } catch {
    return raw;
  }
}

/** The one-line caption of a finished call: short results and errors as they are, big JSON replaced by "Done". */
export function brief(item: ToolItem): string {
  const s = item.summary ?? '';
  if (item.status === 'ok') return s.startsWith('{') || s.startsWith('[') ? 'Done' : s.length > 70 ? 'Done' : s;
  return s;
}

function StatusMark({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Loader2 aria-label="Running" className="size-4 animate-spin text-accent" />;
  if (status === 'awaiting') return <Hand aria-label="Waiting for your approval" className="size-4 text-warning" />;
  if (status === 'ok') {
    return (
      <svg
        aria-label="Done"
        role="img"
        viewBox="0 0 16 16"
        className="fd-check size-4 text-positive"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 8.5 6.5 12 13 4.5" />
      </svg>
    );
  }
  return (
    <CircleX
      aria-label={status === 'declined' ? 'Declined' : 'Failed'}
      className={cn('size-4', status === 'declined' ? 'text-muted' : 'text-critical-fg')}
    />
  );
}

/** One tool call: a compact row while it runs, expandable to its arguments and result; approvals get buttons. */
export function ToolCard({
  item,
  decision,
  onDecide,
}: {
  item: ToolItem;
  decision?: 'approve' | 'deny' | undefined;
  onDecide?: ((callId: string, d: 'approve' | 'deny') => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const args = prettyArgs(item.args);
  const ap = item.approval;
  return (
    <div
      data-testid="tool-card"
      data-status={item.status}
      className={cn(
        'fd-rise rounded-xl border bg-surface text-sm',
        item.status === 'awaiting' && (ap?.risk === 'danger' ? 'border-critical/60' : 'border-warning/50'),
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <StatusMark status={item.status} />
        <span className="font-medium">{toolTitle(item.name)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {item.status === 'running' ? 'working…' : brief(item)}
        </span>
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t px-3 py-2 text-xs">
          {args ? (
            <pre className="overflow-x-auto rounded-md bg-bg p-2 font-mono leading-relaxed">{args}</pre>
          ) : (
            <span className="text-muted">No arguments.</span>
          )}
          {item.summary ? <p className="break-words text-muted">{item.summary}</p> : null}
        </div>
      ) : null}
      {item.status === 'awaiting' && ap && onDecide ? (
        <div className="flex flex-col gap-2 border-t px-3 py-2.5">
          <p className="text-sm">
            {ap.risk === 'danger' ? (
              <strong className="text-critical-fg">Needs your approval: </strong>
            ) : (
              <strong>Wants to: </strong>
            )}
            {ap.summary}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={decision === 'approve' ? 'default' : 'outline'}
              aria-pressed={decision === 'approve'}
              onClick={() => onDecide(item.id, 'approve')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant={decision === 'deny' ? 'default' : 'ghost'}
              aria-pressed={decision === 'deny'}
              onClick={() => onDecide(item.id, 'deny')}
            >
              Decline
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
