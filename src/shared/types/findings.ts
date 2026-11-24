// Frozen shared contract (docs/PLAN.md section 5.2). Do not change without the integrator.
import type { Asset, BotId, Ms, Pair, Severity } from './domain';

export type RuleId = 'BOT_UNREACHABLE' | 'BOT_AUTH_FAILED' | 'BOT_STALE_PROCESS' | 'BOT_NOT_RUNNING' | 'BOT_RESTARTED'
  | 'BOT_RESTART_LOOP' | 'BOT_IDENTITY_CHANGED' | 'BOT_FATAL_LOG' | 'BOT_ERROR_LOG' | 'UNPERSISTED_ORDER'
  | 'ORPHAN_KRAKEN_ORDER' | 'BOT_ORDER_MISSING_ON_KRAKEN' | 'ORDER_MISMATCH' | 'ORDER_STORM' | 'FEE_ANOMALY'
  | 'UNTRACKED_HOLDING' | 'BOT_OVERCLAIMS_HOLDING' | 'USD_VIEW_DRIFT' | 'KRAKEN_ERROR' | 'CLOCK_SKEW'
  | 'LOG_TAIL_UNAVAILABLE' | 'NOTIFIER_FAILING';
export interface FindingSubject { botId?: BotId; pair?: Pair; asset?: Asset; orderId?: string; tradeId?: number; kind?: string }
export interface RawFinding { rule: RuleId; fingerprint: string; severity: Severity; title: string; detail: string;
  subject: FindingSubject; evidence: Record<string, unknown>; evidenceKeys?: string[];
  minDurationMs?: number; clearAfterMs?: number; escalateAfterMs?: number; escalateTo?: Severity; }
export type FindingStatus = 'pending' | 'active' | 'resolved';
export interface Finding extends RawFinding { id: number; status: FindingStatus; maxSeverity: Severity;
  firstSeenAt: Ms; episodeStartAt: Ms; activeSince: Ms | null; lastSeenAt: Ms; clearedAt: Ms | null; resolvedAt: Ms | null;
  occurrences: number; flapCount: number;
  silenced: { at: Ms; by: string | null; note: string | null; severity: Severity; evidenceCount: number } | null;
  notifiedAt: Ms | null; notifiedSeverity: Severity | null; notifiedEvidenceCount: number | null; }
export interface NotificationIntent { fingerprint: string; findingId: number | null;
  kind: 'opened' | 'escalated' | 'grew' | 'resolved'; severity: Severity; title: string; detail: string; }
