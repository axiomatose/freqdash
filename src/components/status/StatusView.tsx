'use client';

import { toast } from 'sonner';
import { EmptyState, ResponsiveTable, SkeletonCard, Time, TimeAgo, type Column } from '@/components/data';
import { QueryBoundary } from '@/components/overview/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { formatDuration } from '@/lib/client/format';
import { updatePrefs, usePrefs } from '@/lib/client/prefs';
import { useAcks, useLogout, useNotifyTest, useResetKillswitch, useRevokeAck, useStatus } from '@/lib/client/queries';
import type { StatusResponse } from '@/shared/types/api';
import type { Acknowledgement, Freshness } from '@/shared/types/domain';

const STATE_VARIANT = {
  fresh: 'positive',
  aging: 'warning',
  stale: 'warning',
  error: 'critical',
  disabled: 'muted',
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card aria-label={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}

function Sources({ sources }: { sources: Freshness[] }) {
  const columns: Column<Freshness>[] = [
    { key: 'label', header: 'Source', card: 'title', cell: (s) => s.label },
    {
      key: 'state',
      header: 'State',
      card: 'aside',
      cell: (s) => <Badge variant={STATE_VARIANT[s.state]}>{s.state}</Badge>,
    },
    { key: 'ok', header: 'Last OK', cell: (s) => <TimeAgo at={s.lastOkAt} />, className: 'text-muted' },
    { key: 'fail', header: 'Failures', align: 'right', cell: (s) => s.consecutiveFailures },
    {
      key: 'err',
      header: 'Last error',
      card: 'full',
      cell: (s) => <span className="break-words text-muted">{s.error ?? '—'}</span>,
    },
  ];
  return (
    <ResponsiveTable
      caption="Data sources"
      columns={columns}
      rows={sources}
      rowKey={(s) => s.source}
      empty={<EmptyState title="No sources yet" />}
    />
  );
}

function KrakenPanel({ d }: { d: StatusResponse }) {
  const k = d.kraken;
  return (
    <Section title="Kraken">
      <p>
        Mode <Badge variant={d.mode === 'kraken' ? 'positive' : 'warning'}>{d.mode}</Badge>
        {d.modeReason ? <span className="ml-2 text-muted">{d.modeReason}</span> : null}
      </p>
      {k.configured ? (
        <ul className="grid gap-1 sm:grid-cols-2">
          <li>
            Status: {k.status}
            {k.reason ? ` (${k.reason})` : ''}
          </li>
          <li>Tier: {k.tier}</li>
          <li>Backfill: {k.backfillComplete ? 'complete' : 'in progress'}</li>
          <li>
            Reconciling from: <Time at={k.reconStartAt} />
          </li>
          <li>Permission denied: {k.permissionDenied.length ? k.permissionDenied.join(', ') : 'none'}</li>
        </ul>
      ) : null}
      <details className="rounded-lg border p-3" open={!k.configured}>
        <summary className="cursor-pointer font-medium">Kraken setup guide</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>
            On Kraken, create a <strong className="text-text">new</strong> API key. Never reuse the bots&apos; key.
          </li>
          <li>
            Permissions: Query funds, Query open orders &amp; trades, Query closed orders &amp; trades, Query ledger
            entries. Nothing else: no trading, no withdrawals.
          </li>
          <li>
            Put the key and secret in freqdash&apos;s environment file on the host (never in chat or screenshots) and
            restart the container.
          </li>
          <li>The first sync backfills orders since the reconciliation start; this page shows when it is complete.</li>
        </ol>
      </details>
    </Section>
  );
}

function Killswitch({ d }: { d: StatusResponse }) {
  const reset = useResetKillswitch();
  const k = d.killswitch;
  const t = k.tripped;
  return (
    <Section title="Killswitch">
      <p>
        Mode{' '}
        <Badge variant={k.mode === 'armed' ? 'positive' : k.mode === 'dry-run' ? 'warning' : 'muted'}>{k.mode}</Badge>
        <span className="ml-2 text-muted">
          {k.mode === 'off'
            ? 'Not watching. Set KILLSWITCH_MODE=dry-run or armed.'
            : "Watches Kraken for runaway buying and stops the bots' containers."}
        </span>
      </p>
      {t === null ? (
        k.mode === 'off' ? null : (
          <p className="text-muted">
            Not tripped
            {k.resetAt ? (
              <>
                {' '}
                · last reset <Time at={k.resetAt} />
              </>
            ) : null}
            .
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-critical/40 p-3" data-testid="killswitch-tripped">
          <p>
            <strong className="text-critical-fg">{t.dryRun ? 'Would have tripped (dry run)' : 'Tripped'}</strong>{' '}
            <Time at={t.at} />: {t.count} buys of {t.pair} within {Math.round(t.windowMs / 1000)} s (limit {t.max}).
          </p>
          <ul className="flex flex-col gap-0.5">
            {t.bots.map((b) => (
              <li key={b.botId}>
                <strong>{b.botId}</strong>: {b.status}
                {b.container ? ` (${b.container})` : ' (no container configured, stop it yourself)'}
                {b.message && b.status === 'failed' ? ` · ${b.message}` : ''}
              </li>
            ))}
          </ul>
          <p className="text-muted">
            Resetting re-arms the killswitch. It does not start any bot: check Kraken and the bots first, then start
            them yourself.
          </p>
          <div>
            <Button
              variant="outline"
              disabled={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => toast.success('Killswitch reset'),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              Reset killswitch
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function Acks() {
  const q = useAcks();
  const revoke = useRevokeAck();
  const columns: Column<Acknowledgement>[] = [
    { key: 'subject', header: 'Subject', card: 'title', cell: (a) => <code className="text-xs">{a.subject}</code> },
    { key: 'kind', header: 'Kind', cell: (a) => (a.kind === 'asset' ? 'holding' : 'order') },
    { key: 'label', header: 'Label', card: 'aside', cell: (a) => <Badge variant="muted">{a.label}</Badge> },
    { key: 'base', header: 'Baseline', align: 'right', cell: (a) => a.qtyBaseline ?? 'any' },
    { key: 'at', header: 'Created', cell: (a) => <Time at={a.createdAt} />, className: 'text-muted' },
    {
      key: 'act',
      header: <span className="sr-only">Revoke</span>,
      align: 'right',
      cell: (a) => (
        <Button
          variant="outline"
          size="sm"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate({ id: a.id }, { onError: (e) => toast.error(e.message) })}
        >
          Revoke
        </Button>
      ),
    },
  ];
  return (
    <Section title="Acknowledgements">
      <QueryBoundary query={q} skeleton={<SkeletonCard rows={3} />}>
        {(d) => (
          <ResponsiveTable
            caption="Acknowledgements"
            columns={columns}
            rows={d.acks}
            rowKey={(a) => String(a.id)}
            empty={<EmptyState title="No acknowledgements" compact />}
          />
        )}
      </QueryBoundary>
    </Section>
  );
}

function Content({ d }: { d: StatusResponse }) {
  const test = useNotifyTest();
  const logout = useLogout();
  const { utc } = usePrefs();
  const n = d.notifier;
  return (
    <div className="flex flex-col gap-4" data-testid="status-page">
      <Section title="Data sources">
        <Sources sources={d.sources} />
      </Section>
      <KrakenPanel d={d} />
      <Section title="Log tails">
        <ul className="flex flex-col gap-1">
          {d.logTails.map((t) => (
            <li key={t.botId} className="flex flex-wrap items-center gap-2">
              <strong>{t.botId}</strong>
              <Badge variant={t.available ? 'positive' : t.configured ? 'critical' : 'warning'}>
                {t.available ? 'tailing file' : t.configured ? 'file unavailable' : 'API fallback'}
              </Badge>
              <span className="text-muted">
                last line <TimeAgo at={t.lastLineAt} />
              </span>
              {t.error ? <span className="break-words text-muted">{t.error}</span> : null}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Notifier">
        <p>
          Discord {n.discord ? 'configured' : 'off'} · last sent <TimeAgo at={n.lastSentAt} />
          {n.consecutiveFailures > 0 ? ` · ${n.consecutiveFailures} failures` : ''}
        </p>
        {n.lastError ? <p className="break-words text-warning">{n.lastError}</p> : null}
        <div>
          <Button
            variant="outline"
            disabled={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (r) =>
                  r.ok ? toast.success('Test notification sent') : toast.error(r.error ?? 'Test failed'),
                onError: (e) => toast.error(e.message),
              })
            }
          >
            Send test notification
          </Button>
        </div>
      </Section>
      <Killswitch d={d} />
      <Acks />
      <Section title="App">
        <ul className="grid gap-1 sm:grid-cols-2">
          <li>Version {d.version}</li>
          <li>Up {formatDuration(Math.max(0, d.generatedAt - d.startedAt))}</li>
          <li>
            Database {(d.db.sizeBytes / 1024 / 1024).toFixed(1)} MB · {d.db.findings} findings · {d.db.krakenOrders}{' '}
            Kraken orders · {d.db.equityPoints} equity points
          </li>
          <li>Clock skew vs Kraken: {d.clockSkewMs === null ? 'unknown' : `${d.clockSkewMs} ms`}</li>
        </ul>
        <label className="flex items-center gap-3">
          <Switch checked={utc} onCheckedChange={(v) => updatePrefs({ utc: v })} aria-label="Show times in UTC" />
          Show times in UTC
        </label>
        <div>
          <Button variant="outline" onClick={() => logout.mutate()}>
            Log out
          </Button>
        </div>
      </Section>
    </div>
  );
}

export function StatusView() {
  const q = useStatus();
  return (
    <>
      <h1 className="sr-only">Status</h1>
      <QueryBoundary query={q} skeleton={<SkeletonCard rows={8} />}>
        {(d) => <Content d={d} />}
      </QueryBoundary>
    </>
  );
}
