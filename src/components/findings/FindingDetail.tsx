'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { SeverityBadge, Time } from '@/components/data';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { Textarea } from '@/components/ui/textarea';
import { useCreateAcks, useSilence, useUnsilence } from '@/lib/client/queries';
import { RUNBOOK } from '@/shared/runbook';
import type { Finding } from '@/shared/types/findings';
import { FeeEvidence, isFeeOrders } from './FeeEvidence';

const ORDER_RULES = new Set(['UNPERSISTED_ORDER', 'ORPHAN_KRAKEN_ORDER']);

/** Which acknowledgement the finding offers, and what it pre-fills. Pure, so it is unit tested. */
export function ackPlan(
  f: Finding,
):
  { kind: 'kraken_order'; subjects: string[] } | { kind: 'asset'; subjects: string[]; baseline: number | null } | null {
  if (ORDER_RULES.has(f.rule) && (f.evidenceKeys?.length ?? 0) > 0)
    return { kind: 'kraken_order', subjects: f.evidenceKeys ?? [] };
  if (f.rule === 'UNTRACKED_HOLDING' && f.subject.asset) {
    const q = f.evidence.untrackedQty;
    return { kind: 'asset', subjects: [f.subject.asset], baseline: typeof q === 'number' ? q : null };
  }
  return null;
}

function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const orders = Array.isArray(evidence.orders) ? (evidence.orders as Record<string, unknown>[]) : [];
  const scalars = Object.entries(evidence).filter(
    ([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
  );
  return (
    <div className="flex flex-col gap-3">
      {scalars.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {scalars.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-muted">{k}</dt>
              <dd className="min-w-0 break-words tabular-nums">{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {orders.length > 0 && isFeeOrders(orders) ? <FeeEvidence orders={orders} /> : null}
      {orders.length > 0 && !isFeeOrders(orders) ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs" aria-label="Orders">
            <thead>
              <tr className="eyebrow text-left">
                <th className="p-2 font-medium">Order</th>
                <th className="p-2 font-medium">Time</th>
                <th className="p-2 text-right font-medium">Stake</th>
                <th className="p-2 font-medium">Kraken</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={String(o.orderId)} className="border-t">
                  <td className="p-2">
                    <code>{String(o.orderId)}</code>
                  </td>
                  <td className="p-2">{typeof o.at === 'number' ? <Time at={o.at} /> : '—'}</td>
                  <td className="p-2 text-right tabular-nums">
                    {typeof o.stakeUsd === 'number' ? `$${o.stakeUsd.toFixed(2)}` : '—'}
                  </td>
                  <td className="p-2">{o.krakenStatus ? String(o.krakenStatus) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function FindingDetail({ finding, onClose }: { finding: Finding | null; onClose: () => void }) {
  const silence = useSilence();
  const unsilence = useUnsilence();
  const acks = useCreateAcks();
  const [note, setNote] = useState('');
  const f = finding;
  const plan = f ? ackPlan(f) : null;
  const runbook = f ? RUNBOOK[f.rule] : null;

  const ack = (label: 'manual' | 'ignored') => {
    if (!plan) return;
    acks.mutate(
      {
        kind: plan.kind,
        subjects: plan.subjects,
        label,
        ...(plan.kind === 'asset' ? { qtyBaseline: plan.baseline } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`Marked ${plan.subjects.length} ${plan.kind === 'asset' ? 'holding' : 'order(s)'} ${label}`);
          onClose();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <ResponsiveSheet
      open={f !== null}
      onOpenChange={(o) => !o && onClose()}
      title={f?.title ?? 'Finding'}
      description={f?.detail}
      mobileSize="full"
      footer={
        f && f.status !== 'resolved' ? (
          <div className="flex flex-wrap gap-2">
            {plan ? (
              <>
                <Button onClick={() => ack('manual')} disabled={acks.isPending}>
                  {plan.kind === 'asset' ? 'Mark holding manual' : `Mark ${plan.subjects.length} orders manual`}
                </Button>
                {plan.kind === 'kraken_order' ? (
                  <Button variant="outline" onClick={() => ack('ignored')} disabled={acks.isPending}>
                    Ignore orders
                  </Button>
                ) : null}
              </>
            ) : null}
            {f.silenced ? (
              <Button variant="outline" onClick={() => unsilence.mutate({ id: f.id }, { onSuccess: onClose })}>
                Unsilence
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() =>
                  silence.mutate({ id: f.id, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onClose })
                }
              >
                Silence
              </Button>
            )}
          </div>
        ) : null
      }
    >
      {f ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <SeverityBadge severity={f.severity} />
            <span className="text-muted">
              first seen <Time at={f.firstSeenAt} /> · last <Time at={f.lastSeenAt} /> · {f.occurrences}× ·{' '}
              {f.flapCount} flaps
            </span>
          </div>
          {runbook ? (
            <section aria-label="What to do" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">What to do</h3>
              <p className="text-sm text-muted">{runbook.summary}</p>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {runbook.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </section>
          ) : null}
          <section aria-label="Evidence" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Evidence</h3>
            <Evidence evidence={f.evidence} />
          </section>
          {f.status !== 'resolved' && !f.silenced ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="silence-note">Silence note (optional)</Label>
              <Textarea id="silence-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
          ) : null}
          {f.silenced ? (
            <p className="text-sm text-muted">
              Silenced{f.silenced.note ? `: ${f.silenced.note}` : ''}. It comes back if it gets worse.
            </p>
          ) : null}
        </div>
      ) : null}
    </ResponsiveSheet>
  );
}
