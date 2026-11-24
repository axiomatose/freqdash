import { describe, expect, it } from 'vitest';
import type { RuleId } from '@/shared/types/findings';
import { RUNBOOK } from '@/shared/runbook';
import { T0, healthyBot, input } from '../../../test/fixtures/incident/builders';
import { DEFAULT_CHECK_CONFIG } from './config';
import { RULES, evaluate, evaluateDetailed } from './engine';

const ALL_RULES: Record<RuleId, true> = {
  BOT_UNREACHABLE: true,
  BOT_AUTH_FAILED: true,
  BOT_STALE_PROCESS: true,
  BOT_NOT_RUNNING: true,
  BOT_RESTARTED: true,
  BOT_RESTART_LOOP: true,
  BOT_IDENTITY_CHANGED: true,
  BOT_FATAL_LOG: true,
  BOT_ERROR_LOG: true,
  UNPERSISTED_ORDER: true,
  ORPHAN_KRAKEN_ORDER: true,
  BOT_ORDER_MISSING_ON_KRAKEN: true,
  ORDER_MISMATCH: true,
  ORDER_STORM: true,
  FEE_ANOMALY: true,
  UNTRACKED_HOLDING: true,
  BOT_OVERCLAIMS_HOLDING: true,
  USD_VIEW_DRIFT: true,
  KRAKEN_ERROR: true,
  CLOCK_SKEW: true,
  LOG_TAIL_UNAVAILABLE: true,
  NOTIFIER_FAILING: true,
};

describe('engine', () => {
  it('runs one rule per RuleId of the contract, each once', () => {
    expect(RULES.map((r) => r.id).sort()).toEqual(Object.keys(ALL_RULES).sort());
    expect(new Set(RULES.map((r) => r.id)).size).toBe(22);
  });

  it('every rule has runbook guidance', () => {
    for (const { id } of RULES) expect(RUNBOOK[id].steps.length, id).toBeGreaterThan(0);
  });

  it('a quiet, healthy system produces no findings and counts every rule as evaluated', () => {
    const r = evaluateDetailed(input({ bots: [healthyBot('votemax', T0), healthyBot('dca', T0)] }));
    expect(r.findings).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.rulesEvaluated).toBe(22);
  });

  it('collects the findings of several rules', () => {
    const bot = healthyBot('votemax', T0);
    const broken = { ...bot, health: { ...bot.health!, authFailed: true } };
    const findings = evaluate(input({ bots: [broken], clockSkewMs: 9000, notifierFailures: 4 }));
    expect(findings.map((f) => f.rule).sort()).toEqual(['BOT_AUTH_FAILED', 'CLOCK_SKEW', 'NOTIFIER_FAILING']);
  });

  it('a rule that throws is skipped and reported, and the other rules still run', () => {
    const rules = [
      {
        id: 'CLOCK_SKEW' as const,
        run: () => {
          throw new Error('boom');
        },
      },
      {
        id: 'BOT_UNREACHABLE' as const,
        run: () => {
          throw 'not an error object';
        },
      },
      { id: 'NOTIFIER_FAILING' as const, run: RULES.find((r) => r.id === 'NOTIFIER_FAILING')!.run },
    ];
    const r = evaluateDetailed(input({ notifierFailures: 5 }), rules);
    expect(r.findings.map((f) => f.rule)).toEqual(['NOTIFIER_FAILING']);
    expect(r.errors).toEqual([
      { rule: 'CLOCK_SKEW', message: 'boom' },
      { rule: 'BOT_UNREACHABLE', message: 'not an error object' },
    ]);
    expect(r.rulesEvaluated).toBe(1);
  });

  it('is deterministic and does not mutate its input', () => {
    const inp = input({ bots: [healthyBot('votemax', T0)], clockSkewMs: 9000 });
    const snapshot = JSON.stringify(inp);
    expect(evaluate(inp)).toEqual(evaluate(inp));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});

describe('DEFAULT_CHECK_CONFIG', () => {
  it('holds numbers only', () => {
    for (const [k, v] of Object.entries(DEFAULT_CHECK_CONFIG)) expect(typeof v, k).toBe('number');
  });

  it('carries the documented defaults of PLAN section 8.1 and 8.2', () => {
    expect(DEFAULT_CHECK_CONFIG).toMatchObject({
      unreachableWarnMs: 30_000,
      unreachableCriticalMs: 180_000,
      staleProcessWarnMs: 120_000,
      staleProcessCriticalMs: 600_000,
      restartLoopCount: 3,
      restartLoopWindowMs: 900_000,
      restartClusterMs: 10_000,
      fatalWindowMs: 3_600_000,
      errorWindowMs: 1_800_000,
      unpersistedMinAgeMs: 60_000,
      refreshMarginMs: 5000,
      orphanMinAgeMs: 60_000,
      orphanBotDownIgnoreMs: 300_000,
      stormWindowMs: 600_000,
      stormWarnCount: 4,
      stormCriticalCount: 6,
      untrackedCriticalUsd: 25,
      untrackedWarnUsd: 5,
      untrackedIgnoreUsd: 1,
      untrackedMinMs: 90_000,
      usdDriftEscalateMs: 4_500_000,
      clockSkewWarnMs: 5000,
      clockSkewCriticalMs: 30_000,
      reopenWindowMs: 1_800_000,
      warningNotifyAfterMs: 300_000,
      growCooldownMs: 600_000,
      mismatchMinMs: 120_000,
    });
  });
});
