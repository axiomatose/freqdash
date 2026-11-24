'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, Metric, Money, Price, Qty, ResponsiveTable, type Column } from '@/components/data';
import { useCreateAcks } from '@/lib/client/queries';
import type { HoldingAttribution } from '@/shared/types/domain';

const STATUS = {
  cash: { label: 'Cash', variant: 'default' },
  bot: { label: 'Bot', variant: 'accent' },
  manual: { label: 'Manual', variant: 'muted' },
  untracked: { label: 'Untracked', variant: 'critical' },
  dust: { label: 'Dust', variant: 'muted' },
} as const;

/** Quantity held outside bot trades: what an acknowledgement should cover. */
export function unattributedQty(h: HoldingAttribution): number {
  return Math.max(0, h.total - h.byBot.reduce((acc, b) => acc + b.qty, 0));
}

export function Holdings({
  holdings,
  sources,
}: {
  holdings: readonly HoldingAttribution[];
  sources: readonly string[];
}) {
  const [labeling, setLabeling] = useState<HoldingAttribution | null>(null);
  const columns: Column<HoldingAttribution>[] = [
    { key: 'asset', header: 'Asset', cell: (h) => <span className="font-medium">{h.asset}</span>, card: 'title' },
    {
      key: 'qty',
      header: 'Qty',
      align: 'right',
      cell: (h) => <Metric value={<Qty value={h.total} />} sources={sources} asOf={false} />,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      cell: (h) => <Price value={h.valueUsd !== null && h.total > 0 ? h.valueUsd / h.total : null} />,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      cell: (h) => <Metric value={<Money value={h.valueUsd} />} sources={sources} asOf={false} />,
    },
    {
      key: 'attr',
      header: 'Attributed to',
      cell: (h) => (h.byBot.length === 0 ? '—' : h.byBot.map((b) => `${b.botId} ${b.qty}`).join(', ')),
      className: 'text-muted',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (h) => (
        <Badge variant={STATUS[h.status].variant} data-status={h.status}>
          {STATUS[h.status].label}
        </Badge>
      ),
      card: 'aside',
    },
    {
      key: 'act',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (h) =>
        h.status === 'cash' || h.status === 'bot' ? null : (
          <Button variant="ghost" size="sm" onClick={() => setLabeling(h)}>
            Label…
          </Button>
        ),
    },
  ];
  return (
    <>
      <ResponsiveTable
        caption="Holdings"
        columns={columns}
        rows={holdings}
        rowKey={(h) => h.asset}
        empty={<EmptyState title="No holdings" />}
      />
      <LabelHolding holding={labeling} onClose={() => setLabeling(null)} />
    </>
  );
}

function LabelHolding({ holding, onClose }: { holding: HoldingAttribution | null; onClose: () => void }) {
  const create = useCreateAcks();
  const [label, setLabel] = useState<'manual' | 'ignored'>('manual');
  const [note, setNote] = useState('');
  const [baseline, setBaseline] = useState<string | null>(null);
  const shown = baseline ?? (holding === null ? '' : String(unattributedQty(holding)));

  const submit = () => {
    if (holding === null) return;
    const qty = shown.trim() === '' ? null : Number(shown);
    if (qty !== null && !Number.isFinite(qty)) return toast.error('Baseline must be a number');
    create.mutate(
      {
        kind: 'asset',
        subjects: [holding.asset],
        label,
        ...(note.trim() ? { note: note.trim() } : {}),
        qtyBaseline: qty,
      },
      {
        onSuccess: () => {
          toast.success(`${holding.asset} labelled ${label}`);
          setBaseline(null);
          setNote('');
          onClose();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <ResponsiveSheet
      open={holding !== null}
      onOpenChange={(o) => !o && onClose()}
      title={holding ? `Label ${holding.asset}` : 'Label holding'}
      description="Tell freqdash this quantity is yours, so it stops flagging it. A larger holding later is flagged again."
      footer={
        <Button onClick={submit} disabled={create.isPending}>
          Save label
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex gap-2">
          <legend className="eyebrow mb-1">Label</legend>
          {(['manual', 'ignored'] as const).map((l) => (
            <Button
              key={l}
              type="button"
              variant={label === l ? 'default' : 'outline'}
              aria-pressed={label === l}
              onClick={() => setLabel(l)}
            >
              {l === 'manual' ? 'Manual holding' : 'Ignore'}
            </Button>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="baseline">Quantity covered</Label>
          <Input id="baseline" inputMode="decimal" value={shown} onChange={(e) => setBaseline(e.target.value)} />
          <p className="text-xs text-muted">Empty covers any amount.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>
      </div>
    </ResponsiveSheet>
  );
}
