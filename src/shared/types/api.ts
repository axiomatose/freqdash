// Frozen shared contract (docs/PLAN.md section 5.3). Do not change without the integrator.
import type {
  Acknowledgement, AccountSnapshot, Allocation, BotConfigInfo, BotEvent, BotHealth, BotId, BotStats, BotTrade,
  Freshness, FtWalletView, KrakenFlow, KrakenOrder, ManualPosition, Ms, Pair, Severity, SourceKey,
} from './domain';
import type { Finding, FindingSubject, RuleId } from './findings';
import type { AppState, BotRuntime, KrakenRuntime } from './state';

export interface KillswitchBotInfo { botId: BotId; container: string | null; status: 'pending' | 'stopped' | 'failed' | 'not-stoppable'; attempts: number; message: string | null }
export interface KillswitchInfo { mode: 'off' | 'dry-run' | 'armed'; resetAt: Ms | null;
  tripped: { at: Ms; dryRun: boolean; rule: 'burst-short' | 'burst-long'; pair: Pair; count: number; max: number; windowMs: Ms;
             bots: KillswitchBotInfo[] } | null }
export type BotStatusPill = 'running' | 'stale' | 'down' | 'restarting' | 'stopped' | 'auth_error' | 'unknown';
 // auth_error > down(unreachable>=30s) > restarting(startup<2min or loop active) > stale(lastProcess>120s) > stopped(state!=running) > running
export interface FindingLite { id: number; rule: RuleId; severity: Severity; title: string; subject: FindingSubject; activeSince: Ms | null }
export interface SummaryResponse { generatedAt: Ms; mode: 'kraken' | 'freqtrade-only'; modeReason: string | null;
  monitor: { startedAt: Ms | null; lastCycleAt: Ms | null; lastEvalAt: Ms | null; stalled: boolean /* lastCycleAt older than 60s */ };
  findings: { critical: number; warning: number; info: number; silenced: number; top: FindingLite | null };
  accountTotalUsd: number | null; accountFreshness: Freshness | null; killswitch: KillswitchInfo;
  bots: { botId: BotId; name: string; color: string; status: BotStatusPill }[]; }
export interface BotCard { botId: BotId; name: string; color: string; status: BotStatusPill; config: BotConfigInfo | null;
  health: BotHealth | null; stats: BotStats | null; uptimeSince: Ms | null; restarts24h: number; sources: SourceKey[] }
export interface OverviewResponse { generatedAt: Ms; mode: SummaryResponse['mode']; modeReason: string | null;
  account: AccountSnapshot | null; allocation: Allocation | null;
  change24h: { usd: number; pct: number; netFlowsUsd: number | null } | null;
  walletViews: { botId: BotId; usd: number | null; totalUsd: number | null; syncedAt: Ms | null }[];
  bots: BotCard[]; openPositions: BotTrade[];
  combined: { realizedUsd: number; unrealizedUsd: number; totalUsd: number; openCostBasisUsd: number; feesUsd: number; roiOnStake: number | null };
  findings: { counts: { critical: number; warning: number; info: number }; top: FindingLite[] }; sources: Freshness[]; }
export interface BotDetailResponse { generatedAt: Ms; bot: BotCard; openTrades: BotTrade[]; recentClosed: BotTrade[];
  perPair: { pair: Pair; closedTrades: number; realizedUsd: number; roiOnStake: number | null; openQty: number }[];
  events: BotEvent[]; whitelist: Pair[]; locks: BotRuntime['locks']; wallet: FtWalletView | null; sources: Freshness[] }
export type OrderMatch = 'matched' | 'missing' | 'mismatch' | 'unknown';   // 'unknown' in freqtrade-only mode
export interface TradesResponse { generatedAt: Ms; trades: (BotTrade & { krakenMatch: Record<string, OrderMatch> })[];
  total: number; totals: { realizedUsd: number; unrealizedUsd: number; feesUsd: number }; sources: Freshness[] }
export interface KrakenOrdersResponse { generatedAt: Ms; enabled: boolean; orders: (KrakenOrder & {
  match: { botId: BotId; tradeId: number } | null; ack: Acknowledgement | null; createdByBotLog: BotId | null })[]; sources: Freshness[] }
export interface PositionsResponse { generatedAt: Ms; mode: SummaryResponse['mode']; modeReason: string | null;
  enabled: boolean;                 // false without Kraken order history: no cost basis can be derived
  historyStartAt: Ms | null;        // orders before this are unknown, so older buys are missing from the basis
  positions: ManualPosition[];
  totals: { valueUsd: number; costBasisUsd: number; unrealizedUsd: number; realizedUsd: number; feesUsd: number };
  sources: Freshness[] }
export interface FindingsResponse { generatedAt: Ms; findings: Finding[];
  counts: { critical: number; warning: number; info: number; silenced: number; resolved24h: number };
  engine: { lastEvalAt: Ms | null; rules: number; mode: SummaryResponse['mode'] } }
export interface EquityResponse { generatedAt: Ms; points: { t: Ms; totalUsd: number; usdCash: number; source: 'kraken' | 'bot-wallet' }[];
  flows: KrakenFlow[] | null; flowsAvailable: boolean; change: { usd: number; pct: number; netFlowsUsd: number | null } | null }
export interface StatusResponse { generatedAt: Ms; version: string; startedAt: Ms; mode: SummaryResponse['mode']; modeReason: string | null;
  kraken: { configured: boolean; status: KrakenRuntime['status']; reason: string | null; permissionDenied: string[];
            backfillComplete: boolean; reconStartAt: Ms | null; tier: string };
  sources: Freshness[]; logTails: { botId: BotId; file: string | null; configured: boolean; available: boolean; lastLineAt: Ms | null; error: string | null }[];
  notifier: AppState['notifier']; db: { sizeBytes: number; findings: number; krakenOrders: number; equityPoints: number };
  clockSkewMs: number | null; killswitch: KillswitchInfo }

// ---------------------------------------------------------------------------------------------------------------------
// Additions by WP0a: named types for the parts of the section 5.3 route table that the plan gives only as prose.
// They introduce no new fields; ChartData (domain.ts) is the /api/v1/chart response and is not repeated here.
// ---------------------------------------------------------------------------------------------------------------------

export type ApiErrorCode = 'unauthorized' | 'forbidden' | 'bad_request' | 'not_found' | 'rate_limited' | 'unavailable' | 'internal'
  | 'password_change_required';
export interface CaptchaChallenge { id: string; image: string; expiresAt: Ms }                 // image: data:image/png URL
export interface ApiErrorBody { error: ApiErrorCode; message?: string; retryAfterSec?: number;
  /** Login only: the next attempt must solve this challenge (after two wrong passwords). */
  captcha?: CaptchaChallenge }
export interface HealthResponse { ok: true; version: string }                                   // GET /api/health
export interface SessionResponse { name: string | null; expiresAt: Ms; mustChangePassword: boolean } // GET /api/auth/session
export interface LoginBody { username: string; password: string; captchaId?: string; captchaAnswer?: string } // POST /api/auth/login
export interface SessionInfo { id: number; label: string | null; ip: string | null; createdAt: Ms; lastSeenAt: Ms;
  expiresAt: Ms; current: boolean }
export interface SessionsResponse { sessions: SessionInfo[] }                                    // GET /api/v1/sessions
export interface ChangePasswordBody { currentPassword: string; newPassword: string }             // POST /api/auth/password
export type TradesStatusFilter = 'open' | 'closed' | 'all';
export type KrakenOrdersMatchFilter = 'all' | 'unmatched' | 'matched' | 'acked';
export type FindingsStatusFilter = 'active' | 'silenced' | 'resolved' | 'all';
export type EquityRange = '24h' | '7d' | '30d' | '90d' | 'all';
export interface SilenceBody { note?: string }                                                   // POST /api/v1/findings/:id/silence
export interface FindingResponse { finding: Finding }                                            // silence + unsilence
export interface AcksResponse { acks: Acknowledgement[] }                                        // GET + POST /api/v1/acks
export interface CreateAcksBody { kind: Acknowledgement['kind']; subjects: string[]; label: Acknowledgement['label'];
  note?: string; qtyBaseline?: number | null; expiresAt?: Ms | null }                            // POST /api/v1/acks
export interface NotifyTestResponse { ok: boolean; error?: string }                              // POST /api/v1/notify/test
