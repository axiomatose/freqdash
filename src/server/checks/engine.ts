// The checks engine: runs every rule of docs/PLAN.md section 8.1 over one CheckInput snapshot. Pure.
import type { RawFinding, RuleId } from '@/shared/types/findings';
import { botAuthFailed } from './rules/botAuthFailed';
import { botErrorLog } from './rules/botErrorLog';
import { botFatalLog } from './rules/botFatalLog';
import { botIdentityChanged } from './rules/botIdentityChanged';
import { botNotRunning } from './rules/botNotRunning';
import { botOrderMissingOnKraken } from './rules/botOrderMissingOnKraken';
import { botOverclaimsHolding } from './rules/botOverclaimsHolding';
import { botRestartLoop } from './rules/botRestartLoop';
import { botRestarted } from './rules/botRestarted';
import { botStaleProcess } from './rules/botStaleProcess';
import { botUnreachable } from './rules/botUnreachable';
import { clockSkew } from './rules/clockSkew';
import { feeAnomaly } from './rules/feeAnomaly';
import { krakenError } from './rules/krakenError';
import { logTailUnavailable } from './rules/logTailUnavailable';
import { notifierFailing } from './rules/notifierFailing';
import { orderMismatch } from './rules/orderMismatch';
import { orderStorm } from './rules/orderStorm';
import { orphanKrakenOrder } from './rules/orphanKrakenOrder';
import { unpersistedOrder } from './rules/unpersistedOrder';
import { untrackedHolding } from './rules/untrackedHolding';
import { usdViewDrift } from './rules/usdViewDrift';
import type { CheckInput } from './types';
import type { Rule } from './util';

export const RULES: readonly { id: RuleId; run: Rule }[] = [
  { id: 'BOT_UNREACHABLE', run: botUnreachable },
  { id: 'BOT_AUTH_FAILED', run: botAuthFailed },
  { id: 'BOT_STALE_PROCESS', run: botStaleProcess },
  { id: 'BOT_NOT_RUNNING', run: botNotRunning },
  { id: 'BOT_RESTARTED', run: botRestarted },
  { id: 'BOT_RESTART_LOOP', run: botRestartLoop },
  { id: 'BOT_IDENTITY_CHANGED', run: botIdentityChanged },
  { id: 'BOT_FATAL_LOG', run: botFatalLog },
  { id: 'BOT_ERROR_LOG', run: botErrorLog },
  { id: 'UNPERSISTED_ORDER', run: unpersistedOrder },
  { id: 'ORPHAN_KRAKEN_ORDER', run: orphanKrakenOrder },
  { id: 'BOT_ORDER_MISSING_ON_KRAKEN', run: botOrderMissingOnKraken },
  { id: 'ORDER_MISMATCH', run: orderMismatch },
  { id: 'ORDER_STORM', run: orderStorm },
  { id: 'FEE_ANOMALY', run: feeAnomaly },
  { id: 'UNTRACKED_HOLDING', run: untrackedHolding },
  { id: 'BOT_OVERCLAIMS_HOLDING', run: botOverclaimsHolding },
  { id: 'USD_VIEW_DRIFT', run: usdViewDrift },
  { id: 'KRAKEN_ERROR', run: krakenError },
  { id: 'CLOCK_SKEW', run: clockSkew },
  { id: 'LOG_TAIL_UNAVAILABLE', run: logTailUnavailable },
  { id: 'NOTIFIER_FAILING', run: notifierFailing },
];

export interface EvaluationResult {
  findings: RawFinding[];
  rulesEvaluated: number;
  /** Rules that threw. One broken rule must not blind the others, so it is skipped and reported here. */
  errors: { rule: RuleId; message: string }[];
}

export function evaluateDetailed(
  input: CheckInput,
  rules: readonly { id: RuleId; run: Rule }[] = RULES,
): EvaluationResult {
  const findings: RawFinding[] = [];
  const errors: EvaluationResult['errors'] = [];
  let rulesEvaluated = 0;
  for (const { id, run } of rules) {
    try {
      findings.push(...run(input));
      rulesEvaluated += 1;
    } catch (err) {
      errors.push({ rule: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { findings, rulesEvaluated, errors };
}

/** All findings the rules raise for this snapshot (before lifecycle: no dedup, timing or notification logic). */
export function evaluate(input: CheckInput): RawFinding[] {
  return evaluateDetailed(input).findings;
}
