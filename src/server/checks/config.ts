// Numeric defaults for every rule (docs/PLAN.md section 8.1) and for the finding lifecycle (section 8.2).
// CheckConfig (types.ts) is `typeof DEFAULT_CHECK_CONFIG`, so keep this a plain object of numbers.
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_CHECK_CONFIG = {
  // --- bot health --------------------------------------------------------------------------------------------
  /** BOT_UNREACHABLE: warning once the health check has been failing this long, critical from the second value. */
  unreachableWarnMs: 30 * SECOND,
  unreachableCriticalMs: 180 * SECOND,
  unreachableClearMs: 30 * SECOND,
  authFailedClearMs: 60 * SECOND,
  /** BOT_STALE_PROCESS: reachable, but the bot loop has not run for this long. */
  staleProcessWarnMs: 120 * SECOND,
  staleProcessCriticalMs: 600 * SECOND,
  staleProcessClearMs: 30 * SECOND,
  notRunningMinMs: 60 * SECOND,

  // --- restarts, fatal and error logs ------------------------------------------------------------------------
  /** Startup events closer than this to the first event of a cluster are one restart (log line + health diff). */
  restartClusterMs: 10 * SECOND,
  restartedWindowMs: 30 * MINUTE,
  restartLoopWindowMs: 15 * MINUTE,
  restartLoopCount: 3,
  identityWindowMs: DAY,
  fatalWindowMs: 60 * MINUTE,
  errorWindowMs: 30 * MINUTE,
  errorSignatureLength: 120,

  // --- order reconciliation ----------------------------------------------------------------------------------
  /** Margin by which a fresh bot poll must be newer than an order before its absence means anything. */
  refreshMarginMs: 5 * SECOND,
  unpersistedMinAgeMs: 60 * SECOND,
  /** UNPERSISTED_ORDER is critical while any (non zero-fill-canceled) order is younger than this. */
  unpersistedCriticalAgeMs: DAY,
  orphanMinAgeMs: 60 * SECOND,
  /** Bots unreachable for longer than this no longer hold back the orphan check. */
  orphanBotDownIgnoreMs: 5 * MINUTE,
  orphanCriticalAgeMs: 7 * DAY,
  /** BOT_ORDER_MISSING_ON_KRAKEN considers bot orders placed between recon start + grace and now - minAge. */
  missingOnKrakenGraceMs: HOUR,
  missingOnKrakenMinAgeMs: 10 * MINUTE,
  mismatchMinMs: 2 * MINUTE,
  mismatchAbsVol: 1e-7,
  mismatchRelVol: 0.002,
  stormWindowMs: 10 * MINUTE,
  stormWarnCount: 4,
  stormCriticalCount: 6,

  // --- fees --------------------------------------------------------------------------------------------------
  feeTakerFactor: 1.25,
  feeTakerSlack: 0.0005,
  feeDefaultTaker: 0.004,
  feeBotVsKrakenTolerance: 0.001,
  /** Freqtrade-only sanity bound for a bot-reported fee rate. */
  feeBotMaxRate: 0.006,
  /** Fee anomalies on orders filled longer ago than this are informational. */
  feeInfoAgeMs: 30 * DAY,

  // --- holdings ----------------------------------------------------------------------------------------------
  untrackedIgnoreUsd: 1,
  untrackedWarnUsd: 5,
  untrackedWarnEquityRatio: 0.005,
  untrackedCriticalUsd: 25,
  untrackedMinMs: 90 * SECOND,
  untrackedClearMs: 90 * SECOND,
  overclaimAbsQty: 1e-7,
  overclaimRelQty: 0.002,
  overclaimMinMs: 90 * SECOND,
  overclaimClearMs: 90 * SECOND,
  usdDriftAbsUsd: 2,
  usdDriftRatio: 0.01,
  usdDriftEscalateMs: 75 * MINUTE,
  usdDriftClearMs: 5 * MINUTE,

  // --- infrastructure ----------------------------------------------------------------------------------------
  krakenErrorSustainedMs: 2 * MINUTE,
  krakenErrorClearMs: 60 * SECOND,
  clockSkewWarnMs: 5 * SECOND,
  clockSkewCriticalMs: 30 * SECOND,
  clockSkewClearMs: 10 * MINUTE,
  logTailSilenceMs: 5 * MINUTE,
  logTailMinMs: 60 * SECOND,
  notifierFailureThreshold: 3,

  // --- lifecycle (section 8.2) -------------------------------------------------------------------------------
  /** Clear timer for findings whose rule does not set one. */
  defaultClearAfterMs: 30 * SECOND,
  /** A resolved finding with the same fingerprint reopens (flapCount + 1) inside this window. */
  reopenWindowMs: 30 * MINUTE,
  /** A warning is only announced once it has been active this long. */
  warningNotifyAfterMs: 5 * MINUTE,
  /** `grew` notifications are at least this far apart ... */
  growCooldownMs: 10 * MINUTE,
  /** ... and only sent once the evidence count reached this multiple of the count last announced. */
  growMinRatio: 1.5,
  /** `resolved` notifications wait this long, so that a finding that reopens meanwhile does not flap in the channel. */
  resolvedNotifyDelayMs: 10 * MINUTE,
};
