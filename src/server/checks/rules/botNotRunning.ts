import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, type Rule } from '../util';

/** The bot is up but not in the RUNNING state (stopped or paused by an operator, or by a crash handler). */
export const botNotRunning: Rule = ({ cfg, bots }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    if (b.config === null || (b.health !== null && !b.health.reachable)) continue;
    const state = b.config.state;
    if (state.toLowerCase() === 'running') continue;
    out.push({
      rule: 'BOT_NOT_RUNNING',
      fingerprint: fingerprint('BOT_NOT_RUNNING', b.botId),
      severity: 'warning',
      title: `${b.name} is ${state}`,
      detail: `${b.name} reports state "${state}" instead of "running", so it will not open or close trades.`,
      subject: { botId: b.botId },
      evidence: { state },
      minDurationMs: cfg.notRunningMinMs,
    });
  }
  return out;
};
