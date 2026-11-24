'use client';

import { KeyRound, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, SkeletonRows, TimeAgo } from '@/components/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEndOtherSessions, useEndSession, useSessions } from '@/lib/client/account';
import { useSession } from '@/lib/client/queries';

export function AccountTab({ active }: { active: boolean }) {
  const me = useSession();
  const q = useSessions(active);
  const end = useEndSession();
  const endOthers = useEndOtherSessions();
  const sessions = q.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          Signed in as <span className="font-medium">{me.data?.name ?? '…'}</span>
        </p>
        <Button asChild variant="outline" size="sm">
          {/* A full page load: the change-password page lives outside the app shell. */}
          <a href="/change-password">
            <KeyRound aria-hidden /> Change password
          </a>
        </Button>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="sessions-heading">
        <div>
          <h3 id="sessions-heading" className="text-sm font-medium">
            Active sessions
          </h3>
          <p className="mt-1 text-xs text-muted">
            Every browser or phone you are signed in on. Sessions end on their own after a while without use, and
            changing your password ends all of them.
          </p>
        </div>

        {q.isError ? (
          <p className="text-sm text-critical-fg">{q.error.message}</p>
        ) : q.data === undefined ? (
          <SkeletonRows rows={2} />
        ) : sessions.length === 0 ? (
          <EmptyState title="No sessions" compact />
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border bg-surface" aria-label="Sessions">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-start gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.label ?? 'Unknown device'}</span>
                    {s.current ? <Badge variant="positive">This session</Badge> : null}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Active <TimeAgo at={s.lastSeenAt} />
                    {s.ip ? ` · ${s.ip}` : ''} · signed in <TimeAgo at={s.createdAt} />
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={end.isPending}
                  aria-label={s.current ? 'Sign out this session' : `End session on ${s.label ?? 'unknown device'}`}
                  onClick={() =>
                    end.mutate({ id: s.id, current: s.current }, { onError: (e) => toast.error(e.message) })
                  }
                >
                  <LogOut aria-hidden /> {s.current ? 'Sign out' : 'End'}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {others > 0 ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={endOthers.isPending}
              onClick={() =>
                endOthers.mutate(undefined, {
                  onSuccess: (r) => toast.success(`Ended ${r.ended} other session${r.ended === 1 ? '' : 's'}`),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              {endOthers.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              Sign out everywhere else
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
