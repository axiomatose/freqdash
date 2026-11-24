import 'server-only';
import { z } from 'zod';
import type { BotId, Ms, Severity } from '@/shared/types/domain';
import { log, registerSecrets, type LogLevel } from './log';

// Environment configuration (docs/PLAN.md section 3 and section 4 `.env.example`).
//
// Rules for this module:
//  * Nothing here runs at import time: `next build` imports route modules without any environment.
//  * Errors name variables and the kind of problem only. A rejected value is never echoed, so a mistyped password
//    or secret cannot end up in container logs.

export const DEFAULT_KRAKEN_BASE_URL = 'https://api.kraken.com';
export const MAX_BOTS = 10;
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SESSION_SECRET_LENGTH = 32;
export const KRAKEN_SECRET_BYTES = 64;

const DEFAULT_BOT_COLORS = [
  '#4F8CFF',
  '#B38CFF',
  '#2EBD85',
  '#F5A524',
  '#E5484D',
  '#3E63DD',
  '#12A594',
  '#D6409F',
  '#8E8C99',
  '#FFC53D',
];

export type KrakenTier = 'starter' | 'intermediate' | 'pro';
export type TrustProxy = 'none' | 'cloudflare';

export interface BotConnection {
  id: BotId;
  name: string;
  /** Base URL without a trailing slash, e.g. http://freqtrade-votemax:8080 */
  url: string;
  username: string;
  password: string;
  /** Path of the bot's log file as seen from this container, or null when log tailing is not configured. */
  logFile: string | null;
  /** Docker container the killswitch agent may stop for this bot, or null when the bot is not stoppable. */
  container: string | null;
  color: string;
}

export interface AppConfig {
  auth: {
    /** SESSION_SECRET: keys the encryption of secrets stored in the database (no longer part of the session). */
    sessionSecret: string;
    /** Optional read-only bearer token for automation (GET /api/v1/* only), or null when disabled. */
    agentToken: string | null;
    /** Idle timeout of a session in days (slides on use); the absolute lifetime is at least 90 days. */
    sessionMaxAgeDays: number;
    /** 'auto' = Secure only when the request arrived over https (X-Forwarded-Proto). */
    cookieSecure: 'auto' | boolean;
    appOrigins: string[];
    appPublicUrl: string | null;
    trustProxy: TrustProxy;
    /** AUTH_RESET_USER / AUTH_RESET_PASSWORD: account recovery, applied once at start (see boot.ts), or null. */
    reset: { username: string; password: string } | null;
  };
  bots: BotConnection[];
  kraken: {
    enabled: boolean;
    apiKey: string | null;
    apiSecret: string | null;
    baseUrl: string;
    tier: KrakenTier;
  };
  reconStartAt: Ms | null;
  killswitch: {
    /** off: nothing runs. dry-run: detects and alerts but stops nothing. armed: stops the bots' containers. */
    mode: 'off' | 'dry-run' | 'armed';
    agentUrl: string | null;
    token: string | null;
    /** More than this many buys of one pair inside `windowShortMs` trips it. */
    maxBuysShort: number;
    windowShortMs: number;
    /** More than this many buys of one pair inside `windowLongMs` trips it. */
    maxBuysLong: number;
    windowLongMs: number;
  };
  notify: {
    discordWebhookUrl: string | null;
    minSeverity: Severity;
    /** Web Push. Keys from the environment, or null to generate and store a pair in the database on first use. */
    vapid: { publicKey: string; privateKey: string } | null;
    /** `sub` claim of the VAPID token (mailto: or https: URL). */
    vapidSubject: string;
  };
  runtime: {
    pollerEnabled: boolean;
    logBackfillHours: number;
    logLevel: LogLevel;
    dataDir: string;
  };
  /** Non-fatal findings (never contain secret values); logged once when the config is loaded. */
  warnings: string[];
}

export interface ConfigIssue {
  variable: string;
  problem: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  - ${i.variable}: ${i.problem}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isKrakenSecret(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === KRAKEN_SECRET_BYTES;
}

function intInRange(min: number, max: number): (value: string) => boolean {
  return (value) => /^\d{1,9}$/.test(value) && Number(value) >= min && Number(value) <= max;
}

const optionalUrl = z
  .string()
  .refine((v) => httpUrl(v) !== null, 'must be an http(s) URL')
  .optional();

const base64urlBytes =
  (bytes: number) =>
  (v: string): boolean =>
    /^[A-Za-z0-9_-]+$/.test(v) && Buffer.from(v, 'base64url').length === bytes;

const envSchema = z.object({
  // Retired: sign-in uses the user accounts now. Still accepted (and kept out of logs) so an old .env keeps working.
  DASHBOARD_PASSWORD: z.string().optional(),
  AUTH_RESET_USER: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,32}$/, 'must be a username')
    .optional(),
  AUTH_RESET_PASSWORD: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .optional(),
  SESSION_SECRET: z
    .string('is required')
    .min(MIN_SESSION_SECRET_LENGTH, `must be at least ${MIN_SESSION_SECRET_LENGTH} characters`),
  AGENT_API_TOKEN: z
    .string()
    .min(MIN_SESSION_SECRET_LENGTH, `must be at least ${MIN_SESSION_SECRET_LENGTH} characters`)
    .optional(),
  SESSION_MAX_AGE_DAYS: z
    .string()
    .refine(intInRange(1, 365), 'must be a whole number of days between 1 and 365')
    .optional(),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false'], 'must be auto, true or false').optional(),
  APP_ORIGINS: z
    .string()
    .refine(
      (v) => v.split(',').every((o) => o.trim() === '' || httpUrl(o.trim()) !== null),
      'must be a comma-separated list of http(s) origins',
    )
    .optional(),
  APP_PUBLIC_URL: optionalUrl,
  TRUST_PROXY: z.enum(['none', 'cloudflare'], 'must be none or cloudflare').optional(),
  KRAKEN_API_KEY: z
    .string()
    .refine((v) => !/\s/.test(v), 'must not contain whitespace')
    .optional(),
  KRAKEN_API_SECRET: z
    .string()
    .refine(isKrakenSecret, `must be base64 that decodes to ${KRAKEN_SECRET_BYTES} bytes`)
    .optional(),
  KRAKEN_API_BASE_URL: optionalUrl,
  KRAKEN_TIER: z.enum(['starter', 'intermediate', 'pro'], 'must be starter, intermediate or pro').optional(),
  KILLSWITCH_MODE: z.enum(['off', 'dry-run', 'armed'], 'must be off, dry-run or armed').optional(),
  KILLSWITCH_AGENT_URL: optionalUrl,
  KILLSWITCH_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
  KILLSWITCH_MAX_BUYS_30S: z.string().refine(intInRange(1, 50), 'must be a whole number between 1 and 50').optional(),
  KILLSWITCH_MAX_BUYS_10M: z.string().refine(intInRange(1, 200), 'must be a whole number between 1 and 200').optional(),
  RECON_START: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)), 'must be an ISO 8601 date-time')
    .optional(),
  DISCORD_WEBHOOK_URL: optionalUrl,
  NOTIFY_MIN_SEVERITY: z.enum(['info', 'warning', 'critical'], 'must be info, warning or critical').optional(),
  VAPID_PUBLIC_KEY: z
    .string()
    .refine(base64urlBytes(65), 'must be base64url of an uncompressed P-256 public key (65 bytes)')
    .optional(),
  VAPID_PRIVATE_KEY: z
    .string()
    .refine(base64urlBytes(32), 'must be base64url of a P-256 private key (32 bytes)')
    .optional(),
  VAPID_SUBJECT: z
    .string()
    .refine(
      (v) => /^mailto:[^\s@]+@[^\s@]+$/.test(v) || httpUrl(v)?.protocol === 'https:',
      'must be a mailto: or https: URL',
    )
    .optional(),
  POLLER_ENABLED: z.enum(['true', 'false', '1', '0'], 'must be true or false').optional(),
  LOG_BACKFILL_HOURS: z
    .string()
    .refine(intInRange(1, 24 * 30), 'must be a whole number of hours between 1 and 720')
    .optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'warning', 'error'], 'must be debug, info, warn or error').optional(),
  DATA_DIR: z.string().optional(),
});

const botSchema = z.object({
  ID: z.string('is required').regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 characters of a-z, 0-9 and -'),
  NAME: z.string().max(40, 'must be at most 40 characters').optional(),
  URL: z.string('is required').refine((v) => {
    const url = httpUrl(v);
    return url !== null && url.username === '' && url.password === '';
  }, 'must be an http(s) URL without embedded credentials'),
  USERNAME: z.string('is required'),
  PASSWORD: z.string('is required'),
  LOGFILE: z.string().optional(),
  CONTAINER: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 'must be a Docker container name')
    .optional(),
  COLOR: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB color')
    .optional(),
});

const LOWERCASE_KEYS = [
  'COOKIE_SECURE',
  'TRUST_PROXY',
  'KRAKEN_TIER',
  'NOTIFY_MIN_SEVERITY',
  'POLLER_ENABLED',
  'LOG_LEVEL',
  'KILLSWITCH_MODE',
];
const BOT_FIELDS = ['ID', 'NAME', 'URL', 'USERNAME', 'PASSWORD', 'LOGFILE', 'CONTAINER', 'COLOR'] as const;

function issuesFrom(error: z.ZodError, toVariable: (key: string) => string): ConfigIssue[] {
  // Only the path and our own fixed messages are used; zod's `input` (the rejected value) is deliberately dropped.
  return error.issues.map((issue) => ({
    variable: toVariable(String(issue.path[0] ?? 'ENV')),
    problem: issue.message,
  }));
}

function parseBots(env: Env, issues: ConfigIssue[], warnings: string[]): BotConnection[] {
  for (const key of Object.keys(env)) {
    const match = /^FT_BOT_(\d+)_/.exec(key);
    if (match && (Number(match[1]) < 1 || Number(match[1]) > MAX_BOTS) && clean(env[key]) !== undefined) {
      warnings.push(`${key} is ignored: bots are numbered 1 to ${MAX_BOTS}.`);
    }
  }

  const bots: BotConnection[] = [];
  const idOwner = new Map<string, number>();
  for (let n = 1; n <= MAX_BOTS; n += 1) {
    const raw: Record<string, string | undefined> = {};
    for (const field of BOT_FIELDS) raw[field] = clean(env[`FT_BOT_${n}_${field}`]);
    if (BOT_FIELDS.every((field) => raw[field] === undefined)) continue;

    const parsed = botSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(...issuesFrom(parsed.error, (key) => `FT_BOT_${n}_${key}`));
      continue;
    }
    const data = parsed.data;
    const owner = idOwner.get(data.ID);
    if (owner !== undefined) {
      issues.push({ variable: `FT_BOT_${n}_ID`, problem: `must be unique (already used by FT_BOT_${owner}_ID)` });
      continue;
    }
    idOwner.set(data.ID, n);
    bots.push({
      id: data.ID,
      name: data.NAME ?? data.ID,
      url: stripTrailingSlashes(data.URL),
      username: data.USERNAME,
      password: data.PASSWORD,
      logFile: data.LOGFILE ?? null,
      container: data.CONTAINER ?? null,
      color: data.COLOR ?? DEFAULT_BOT_COLORS[(n - 1) % DEFAULT_BOT_COLORS.length] ?? '#4F8CFF',
    });
  }
  return bots;
}

/**
 * Parses and validates the environment. Throws ConfigError listing every problem (variable names and reasons only).
 * Pure: reads nothing but `env`.
 */
export function parseConfig(env: Env): AppConfig {
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];

  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = clean(env[key]);
    raw[key] = value !== undefined && LOWERCASE_KEYS.includes(key) ? value.toLowerCase() : value;
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) issues.push(...issuesFrom(parsed.error, (key) => key));

  const bots = parseBots(env, issues, warnings);
  if (bots.length === 0 && !issues.some((i) => /^FT_BOT_\d+_/.test(i.variable))) {
    issues.push({
      variable: 'FT_BOT_1_ID',
      problem: 'at least one bot must be configured (FT_BOT_1_* .. FT_BOT_10_*)',
    });
  }

  const keyPresent = raw.KRAKEN_API_KEY !== undefined;
  const secretPresent = raw.KRAKEN_API_SECRET !== undefined;
  if (keyPresent && !secretPresent)
    issues.push({ variable: 'KRAKEN_API_SECRET', problem: 'is required when KRAKEN_API_KEY is set' });
  if (secretPresent && !keyPresent)
    issues.push({ variable: 'KRAKEN_API_KEY', problem: 'is required when KRAKEN_API_SECRET is set' });

  const ksMode = raw.KILLSWITCH_MODE ?? 'off';
  if (ksMode === 'armed') {
    if (raw.KILLSWITCH_AGENT_URL === undefined)
      issues.push({ variable: 'KILLSWITCH_AGENT_URL', problem: 'is required when KILLSWITCH_MODE is armed' });
    if (raw.KILLSWITCH_TOKEN === undefined)
      issues.push({ variable: 'KILLSWITCH_TOKEN', problem: 'is required when KILLSWITCH_MODE is armed' });
    if (!bots.some((b) => b.container !== null))
      issues.push({
        variable: 'FT_BOT_1_CONTAINER',
        problem: 'at least one bot needs a container when KILLSWITCH_MODE is armed',
      });
  }
  if (ksMode !== 'off' && !(raw.KRAKEN_API_KEY !== undefined && secretPresent))
    issues.push({
      variable: 'KRAKEN_API_KEY',
      problem: 'is required when the killswitch is enabled (it watches Kraken orders)',
    });

  if ((raw.VAPID_PUBLIC_KEY === undefined) !== (raw.VAPID_PRIVATE_KEY === undefined)) {
    issues.push({
      variable: raw.VAPID_PUBLIC_KEY === undefined ? 'VAPID_PUBLIC_KEY' : 'VAPID_PRIVATE_KEY',
      problem: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together',
    });
  }
  if ((raw.AUTH_RESET_USER === undefined) !== (raw.AUTH_RESET_PASSWORD === undefined)) {
    issues.push({
      variable: raw.AUTH_RESET_USER === undefined ? 'AUTH_RESET_USER' : 'AUTH_RESET_PASSWORD',
      problem: 'AUTH_RESET_USER and AUTH_RESET_PASSWORD must be set together',
    });
  }

  if (issues.length > 0 || !parsed.success) throw new ConfigError(issues);
  const e = parsed.data;

  if (e.DASHBOARD_PASSWORD !== undefined) {
    warnings.push('DASHBOARD_PASSWORD is no longer used: sign in with a user account. Remove it from the environment.');
  }
  if (e.AUTH_RESET_USER !== undefined) {
    warnings.push('AUTH_RESET_USER is set: remove AUTH_RESET_USER and AUTH_RESET_PASSWORD once you have signed in.');
  }

  const krakenBaseUrl = stripTrailingSlashes(e.KRAKEN_API_BASE_URL ?? DEFAULT_KRAKEN_BASE_URL);
  if (krakenBaseUrl !== DEFAULT_KRAKEN_BASE_URL) {
    warnings.push(
      `KRAKEN_API_BASE_URL is not the default (${DEFAULT_KRAKEN_BASE_URL}): signed requests go to the configured endpoint.`,
    );
  }

  const logLevel = e.LOG_LEVEL === 'warning' ? 'warn' : (e.LOG_LEVEL ?? 'info');
  const vapidSubject =
    e.VAPID_SUBJECT ??
    (e.APP_PUBLIC_URL !== undefined && httpUrl(e.APP_PUBLIC_URL)?.protocol === 'https:'
      ? new URL(e.APP_PUBLIC_URL).origin
      : 'mailto:freqdash@example.com');
  return {
    auth: {
      sessionSecret: e.SESSION_SECRET,
      agentToken: e.AGENT_API_TOKEN ?? null,
      sessionMaxAgeDays: e.SESSION_MAX_AGE_DAYS === undefined ? 30 : Number(e.SESSION_MAX_AGE_DAYS),
      cookieSecure: e.COOKIE_SECURE === undefined || e.COOKIE_SECURE === 'auto' ? 'auto' : e.COOKIE_SECURE === 'true',
      appOrigins: (e.APP_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== '')
        .map((o) => new URL(o).origin),
      appPublicUrl: e.APP_PUBLIC_URL === undefined ? null : stripTrailingSlashes(e.APP_PUBLIC_URL),
      trustProxy: e.TRUST_PROXY ?? 'none',
      reset:
        e.AUTH_RESET_USER !== undefined && e.AUTH_RESET_PASSWORD !== undefined
          ? { username: e.AUTH_RESET_USER, password: e.AUTH_RESET_PASSWORD }
          : null,
    },
    bots,
    kraken: {
      enabled: keyPresent && secretPresent,
      apiKey: raw.KRAKEN_API_KEY ?? null,
      apiSecret: raw.KRAKEN_API_SECRET ?? null,
      baseUrl: krakenBaseUrl,
      tier: e.KRAKEN_TIER ?? 'starter',
    },
    reconStartAt: e.RECON_START === undefined ? null : Date.parse(e.RECON_START),
    killswitch: {
      mode: e.KILLSWITCH_MODE ?? 'off',
      agentUrl: e.KILLSWITCH_AGENT_URL === undefined ? null : stripTrailingSlashes(e.KILLSWITCH_AGENT_URL),
      token: e.KILLSWITCH_TOKEN ?? null,
      maxBuysShort: e.KILLSWITCH_MAX_BUYS_30S === undefined ? 2 : Number(e.KILLSWITCH_MAX_BUYS_30S),
      windowShortMs: 30_000,
      maxBuysLong: e.KILLSWITCH_MAX_BUYS_10M === undefined ? 3 : Number(e.KILLSWITCH_MAX_BUYS_10M),
      windowLongMs: 10 * 60_000,
    },
    notify: {
      discordWebhookUrl: e.DISCORD_WEBHOOK_URL ?? null,
      minSeverity: e.NOTIFY_MIN_SEVERITY ?? 'warning',
      vapid:
        e.VAPID_PUBLIC_KEY !== undefined && e.VAPID_PRIVATE_KEY !== undefined
          ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }
          : null,
      vapidSubject,
    },
    runtime: {
      pollerEnabled: e.POLLER_ENABLED === undefined ? true : e.POLLER_ENABLED === 'true' || e.POLLER_ENABLED === '1',
      logBackfillHours: e.LOG_BACKFILL_HOURS === undefined ? 96 : Number(e.LOG_BACKFILL_HOURS),
      logLevel,
      dataDir: e.DATA_DIR ?? './data',
    },
    warnings,
  };
}

/** Every value that must never appear in logs, stored errors or ingested log lines. */
export function collectSecrets(cfg: AppConfig, env: Env = {}): string[] {
  const secrets: (string | null | undefined)[] = [
    cfg.auth.sessionSecret,
    cfg.auth.reset?.password,
    cfg.notify.vapid?.privateKey,
    cfg.auth.agentToken,
    cfg.kraken.apiKey,
    cfg.kraken.apiSecret,
    cfg.killswitch.token,
    cfg.notify.discordWebhookUrl,
  ];
  if (cfg.notify.discordWebhookUrl) {
    const segments = new URL(cfg.notify.discordWebhookUrl).pathname.split('/').filter(Boolean);
    secrets.push(segments.at(-1) ?? null);
  }
  secrets.push(clean(env.DASHBOARD_PASSWORD));
  for (const bot of cfg.bots) {
    secrets.push(bot.password, Buffer.from(`${bot.username}:${bot.password}`).toString('base64'));
  }
  return secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** Configuration summary that is safe to log or show in the UI: no credentials, no URLs with tokens. */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    bots: cfg.bots.map((b) => ({ id: b.id, name: b.name, logFile: b.logFile !== null })),
    kraken: {
      enabled: cfg.kraken.enabled,
      tier: cfg.kraken.tier,
      defaultEndpoint: cfg.kraken.baseUrl === DEFAULT_KRAKEN_BASE_URL,
    },
    notify: {
      discord: cfg.notify.discordWebhookUrl !== null,
      minSeverity: cfg.notify.minSeverity,
      vapidFromEnv: cfg.notify.vapid !== null,
    },
    pollerEnabled: cfg.runtime.pollerEnabled,
    trustProxy: cfg.auth.trustProxy,
  };
}

const CONFIG_KEY = Symbol.for('freqdash.config');
type GlobalWithConfig = typeof globalThis & { [CONFIG_KEY]?: AppConfig };

/** Parses `env`, registers its secrets with the log redactor and logs the warnings. Throws ConfigError. */
export function loadConfig(env: Env = process.env): AppConfig {
  const cfg = parseConfig(env);
  registerSecrets(collectSecrets(cfg, env));
  for (const warning of cfg.warnings) log.warn(warning);
  return cfg;
}

/** Process-wide configuration, loaded on first use and shared across bundled module copies via globalThis. */
export function getConfig(): AppConfig {
  const g = globalThis as GlobalWithConfig;
  g[CONFIG_KEY] ??= loadConfig();
  return g[CONFIG_KEY];
}

/** Test helper: drop the cached configuration. */
export function resetConfigForTests(): void {
  delete (globalThis as GlobalWithConfig)[CONFIG_KEY];
}
