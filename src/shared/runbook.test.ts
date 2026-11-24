import { describe, expect, it } from 'vitest';
import { RUNBOOK } from './runbook';
import type { RuleId } from './types/findings';

const RULE_IDS: RuleId[] = [
  'BOT_UNREACHABLE',
  'BOT_AUTH_FAILED',
  'BOT_STALE_PROCESS',
  'BOT_NOT_RUNNING',
  'BOT_RESTARTED',
  'BOT_RESTART_LOOP',
  'BOT_IDENTITY_CHANGED',
  'BOT_FATAL_LOG',
  'BOT_ERROR_LOG',
  'UNPERSISTED_ORDER',
  'ORPHAN_KRAKEN_ORDER',
  'BOT_ORDER_MISSING_ON_KRAKEN',
  'ORDER_MISMATCH',
  'ORDER_STORM',
  'FEE_ANOMALY',
  'UNTRACKED_HOLDING',
  'BOT_OVERCLAIMS_HOLDING',
  'USD_VIEW_DRIFT',
  'KRAKEN_ERROR',
  'CLOCK_SKEW',
  'LOG_TAIL_UNAVAILABLE',
  'NOTIFIER_FAILING',
];

describe('RUNBOOK', () => {
  it('has an entry with a summary and at least two steps for every rule, and nothing else', () => {
    expect(Object.keys(RUNBOOK).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) {
      const e = RUNBOOK[id];
      expect(e.summary.length, id).toBeGreaterThan(20);
      expect(e.steps.length, id).toBeGreaterThanOrEqual(2);
      for (const s of e.steps) expect(s.trim().length, id).toBeGreaterThan(10);
    }
  });

  it('never asks the operator to expose a secret', () => {
    const text = JSON.stringify(RUNBOOK);
    // sharing verbs next to a secret noun, anywhere in one sentence
    expect(text).not.toMatch(
      /\b(share|paste|post|send|email|upload|screenshot|publish|commit)\b[^.]*\b(api[ -]?key|api[ -]?secret|secret|password|token|webhook url|credentials)\b/i,
    );
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/webhooks\/\d/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('keeps key advice read-only: no trading or withdrawal permission is recommended', () => {
    const kraken = RUNBOOK.KRAKEN_ERROR.steps.join(' ');
    expect(kraken).toMatch(/never enable trading or withdrawal/i);
  });

  it('guides unpersisted and orphan orders through Kraken history, a sell-or-keep decision and an acknowledgement', () => {
    for (const id of ['UNPERSISTED_ORDER', 'ORPHAN_KRAKEN_ORDER'] as const) {
      const text = RUNBOOK[id].steps.join(' ');
      expect(text, id).toMatch(/Kraken order history/);
      expect(text, id).toMatch(/sell|keep/i);
      expect(text, id).toMatch(/acknowledge/i);
    }
  });

  it('for crash loops and storms, stops the source before anything else', () => {
    expect(RUNBOOK.BOT_RESTART_LOOP.steps[0]).toMatch(/stop/i);
    expect(RUNBOOK.ORDER_STORM.steps[0]).toMatch(/stop/i);
  });
});
