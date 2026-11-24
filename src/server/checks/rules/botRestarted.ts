import type { RawFinding } from '@/shared/types/findings';
import { clusterStarts, eventsOf, fingerprint, isoTime, type Rule } from '../util';

/** At least one distinct restart in the last `restartedWindowMs`. */
export const botRestarted: Rule = ({ now, cfg, bots, events }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const starts = clusterStarts(
      eventsOf(events, b.botId, ['startup'], now, cfg.restartedWindowMs).map((e) => e.at),
      cfg.restartClusterMs,
    );
    const last = starts[starts.length - 1];
    if (last === undefined) continue;
    out.push({
      rule: 'BOT_RESTARTED',
      fingerprint: fingerprint('BOT_RESTARTED', b.botId),
      severity: 'info',
      title: `${b.name} restarted`,
      detail: `${b.name} started ${starts.length === 1 ? 'once' : `${starts.length} times`} in the last ${Math.round(cfg.restartedWindowMs / 60_000)} minutes (latest ${isoTime(last)}).`,
      subject: { botId: b.botId },
      evidence: { count: starts.length, lastAt: last, startedAt: starts },
    });
  }
  return out;
};
