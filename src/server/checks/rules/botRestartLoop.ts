import type { RawFinding } from '@/shared/types/findings';
import { clusterStarts, eventsOf, fingerprint, type Rule } from '../util';

/** `restartLoopCount` or more distinct restarts within `restartLoopWindowMs`: the bot is crash-looping. */
export const botRestartLoop: Rule = ({ now, cfg, bots, events }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const starts = clusterStarts(
      eventsOf(events, b.botId, ['startup'], now, cfg.restartLoopWindowMs).map((e) => e.at),
      cfg.restartClusterMs,
    );
    if (starts.length < cfg.restartLoopCount) continue;
    out.push({
      rule: 'BOT_RESTART_LOOP',
      fingerprint: fingerprint('BOT_RESTART_LOOP', b.botId),
      severity: 'critical',
      title: `${b.name} is restart-looping`,
      detail: `${b.name} restarted ${starts.length} times in the last ${Math.round(cfg.restartLoopWindowMs / 60_000)} minutes. A crash loop can place duplicate orders that the bot forgets; check Kraken for orders it did not record.`,
      subject: { botId: b.botId },
      evidence: {
        count: starts.length,
        firstAt: starts[0],
        lastAt: starts[starts.length - 1],
        windowMs: cfg.restartLoopWindowMs,
      },
    });
  }
  return out;
};
