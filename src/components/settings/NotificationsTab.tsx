'use client';

import { useEffect, useState } from 'react';
import { BellRing, CircleCheck, CircleX, Loader2, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, SkeletonRows, TimeAgo } from '@/components/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Severity } from '@/shared/types/domain';
import type { PushDevice, PushPrefs } from '@/shared/types/push';
import {
  askPermission,
  currentSubscription,
  endpointHash,
  pushSupport,
  useEnablePush,
  usePushStatus,
  useRemovePushDevice,
  useTestPush,
  useUpdatePushPrefs,
  type PushSupport,
  type PushTestResult,
} from '@/lib/client/push';

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

const SUPPORT_TEXT: Record<Exclude<PushSupport, 'supported'>, string> = {
  'needs-install':
    'On iPhone and iPad, notifications work only from the Home Screen app: tap Share, then “Add to Home Screen”, open freqdash from there and come back to this tab.',
  insecure: 'Notifications need the dashboard to be opened over https (the Cloudflare address), not plain http.',
  unsupported: 'This browser does not support web push notifications.',
};

function PrefSwitch({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function DeviceCard({
  device,
  thisDevice,
  serverMinSeverity,
}: {
  device: PushDevice;
  thisDevice: boolean;
  serverMinSeverity: Severity;
}) {
  const update = useUpdatePushPrefs();
  const remove = useRemovePushDevice();
  const test = useTestPush();
  const [result, setResult] = useState<PushTestResult | null>(null);
  const p = device.prefs;
  const set = (prefs: Partial<PushPrefs>) =>
    update.mutate({ id: device.id, prefs }, { onError: (e) => toast.error(e.message) });
  const levels = (['critical', 'warning', 'info'] as const).filter((s) => RANK[s] >= RANK[serverMinSeverity]);
  const pid = (k: string) => `push-${device.id}-${k}`;

  return (
    <li className="flex flex-col gap-4 rounded-xl border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{device.label ?? 'Device'}</span>
        {thisDevice ? <Badge variant="positive">This device</Badge> : null}
        <span className="ml-auto text-xs text-muted">
          {device.lastOkAt !== null ? (
            <>
              Last delivered <TimeAgo at={device.lastOkAt} />
            </>
          ) : (
            <>
              Added <TimeAgo at={device.createdAt} />
            </>
          )}
        </span>
      </div>
      {device.lastError ? <p className="text-xs text-critical-fg">Last error: {device.lastError}</p> : null}

      <div className="flex flex-col gap-3">
        <PrefSwitch
          id={pid('entries')}
          label="Buys"
          hint="Filled entry orders, including position adds."
          checked={p.entries}
          disabled={update.isPending}
          onChange={(v) => set({ entries: v })}
        />
        <PrefSwitch
          id={pid('exits')}
          label="Sells"
          hint="Closed trades, with P&L after fees."
          checked={p.exits}
          disabled={update.isPending}
          onChange={(v) => set({ exits: v })}
        />
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor={pid('findings')}>Problems</Label>
            <p className="mt-0.5 text-xs text-muted">Findings such as orphan orders, a bot down or restarting.</p>
          </div>
          <Select
            value={
              p.findings === 'off' || levels.includes(p.findings)
                ? p.findings
                : (levels[levels.length - 1] ?? 'critical')
            }
            onValueChange={(v) => set({ findings: v as PushPrefs['findings'] })}
            disabled={update.isPending}
          >
            <SelectTrigger id={pid('findings')} className="w-36 shrink-0" aria-label="Problems">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levels.includes('info') ? <SelectItem value="info">Everything</SelectItem> : null}
              {levels.includes('warning') ? <SelectItem value="warning">Warning and up</SelectItem> : null}
              <SelectItem value="critical">Critical only</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <PrefSwitch
          id={pid('resolved')}
          label="When problems clear"
          checked={p.resolved}
          disabled={update.isPending || p.findings === 'off'}
          onChange={(v) => set({ resolved: v })}
        />
        <PrefSwitch
          id={pid('system')}
          label="System messages"
          hint="freqdash restarted, tests from the Status page."
          checked={p.system}
          disabled={update.isPending}
          onChange={(v) => set({ system: v })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={test.isPending}
          onClick={() => {
            setResult(null);
            test.mutate(device.id, {
              onSuccess: setResult,
              onError: (e) => setResult({ ok: false, error: e.message }),
            });
          }}
        >
          {test.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />} Send test
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ id: device.id, thisDevice }, { onError: (e) => toast.error(e.message) })}
        >
          <Trash2 aria-hidden /> Remove
        </Button>
        {result ? (
          <span
            role="status"
            className={`flex items-center gap-1.5 text-sm ${result.ok ? 'text-positive' : 'text-critical-fg'}`}
          >
            {result.ok ? <CircleCheck aria-hidden className="size-4" /> : <CircleX aria-hidden className="size-4" />}
            {result.ok ? 'Sent. It should arrive in a few seconds.' : result.error}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function NotificationsTab({ active }: { active: boolean }) {
  const status = usePushStatus(active);
  const enable = useEnablePush();
  // The sheet only renders after the user opened it (client side), so reading the browser here is safe.
  const [support] = useState<PushSupport>(() => pushSupport());
  const [thisHash, setThisHash] = useState<string | null>(null);
  const publicKey = status.data?.publicKey ?? null;
  const deviceCount = status.data?.devices.length ?? 0;

  // Which listed device is this browser (the server never sends endpoints, only their hash).
  useEffect(() => {
    if (support !== 'supported' || publicKey === null) return;
    let cancelled = false;
    void currentSubscription(publicKey)
      .then(async (sub) => (sub === null ? null : endpointHash(sub.endpoint)))
      .then((h) => {
        if (!cancelled) setThisHash(h);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [support, publicKey, deviceCount]);

  const devices = status.data?.devices ?? [];
  const registered = thisHash !== null && devices.some((d) => d.endpointHash === thisHash);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Notifications on your phone or computer for buys, sells and problems, straight from freqdash (no Discord
        needed). Each device has its own choices. Killswitch alerts always go to every device.
      </p>

      {support !== 'supported' ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{SUPPORT_TEXT[support]}</p>
      ) : null}

      {status.isError ? (
        <p className="text-sm text-critical-fg">{status.error.message}</p>
      ) : status.data === undefined ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          {publicKey === null ? (
            <p className="text-sm text-critical-fg">Web push is not available on the server (see the logs).</p>
          ) : support === 'supported' && !registered ? (
            <div>
              <Button
                type="button"
                disabled={enable.isPending}
                onClick={() =>
                  enable.mutate(
                    { publicKey, permission: askPermission() },
                    {
                      onSuccess: (d) => {
                        setThisHash(d.endpointHash);
                        toast.success('Notifications are on for this device');
                      },
                      onError: (e) => toast.error(e.message),
                    },
                  )
                }
              >
                {enable.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <BellRing aria-hidden />}
                Enable on this device
              </Button>
            </div>
          ) : null}

          {devices.length === 0 ? (
            <EmptyState title="No devices yet" compact />
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Devices">
              {devices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  thisDevice={d.endpointHash === thisHash}
                  serverMinSeverity={status.data.serverMinSeverity}
                />
              ))}
            </ul>
          )}
          {status.data.serverMinSeverity !== 'info' ? (
            <p className="text-xs text-muted">
              Findings below “{status.data.serverMinSeverity}” are never sent (NOTIFY_MIN_SEVERITY on the server).
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
