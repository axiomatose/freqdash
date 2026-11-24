import 'server-only';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[REDACTED]';
/** Exact-value redaction skips shorter strings: replacing "abc" everywhere would garble every log line. */
const MIN_EXACT_SECRET_LENGTH = 6;

// Registry of exact secret values (and their URL/JSON-encoded forms), kept on globalThis so that every bundled
// copy of this module (instrumentation, route handlers) redacts the same set.
const REGISTRY_KEY = Symbol.for('freqdash.log.secrets');
type SecretRegistry = { values: string[] };
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: SecretRegistry };

function registry(): SecretRegistry {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] ??= { values: [] };
  return g[REGISTRY_KEY];
}

function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret]);
  const encoded = encodeURIComponent(secret);
  variants.add(encoded);
  // JSON.stringify escapes quotes and backslashes; the logger redacts the final JSON line.
  variants.add(JSON.stringify(secret).slice(1, -1));
  return [...variants].filter((v) => v.length >= MIN_EXACT_SECRET_LENGTH);
}

/** Registers exact secret values to be masked by redactSecrets(). Safe to call repeatedly. */
export function registerSecrets(values: Iterable<string | null | undefined>): void {
  const reg = registry();
  const known = new Set(reg.values);
  for (const value of values) {
    if (!value) continue;
    for (const variant of variantsOf(value)) known.add(variant);
  }
  // Longest first so a secret that contains another one is masked as a whole.
  reg.values = [...known].sort((a, b) => b.length - a.length);
}

/** Test helper: forget every registered secret. */
export function clearRegisteredSecrets(): void {
  registry().values = [];
}

const PATTERNS: [RegExp, string][] = [
  // Discord webhook path (id + token). The host is left visible on purpose.
  [/\/api\/webhooks\/\d+\/[\w-]+/g, '/api/webhooks/[REDACTED]'],
  // JWTs (uvicorn logs websocket URLs with ?token=<JWT>).
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'],
  // token=... in URLs, query strings and form bodies (also matches access_token=, refresh_token=).
  [/token=[^&\s"']+/gi, 'token=[REDACTED]'],
  // Secret-bearing headers, with or without a scheme word, plain or JSON-quoted.
  [
    /\b(Authorization|API-Sign|API-Key)(["']?\s*[:=]\s*)(["']?)(?:(?:Basic|Bearer|Token)\s+)?[^\s"',;]+\3/gi,
    `$1$2$3${REDACTED}$3`,
  ],
  // Bare credentials that lost their header name.
  [/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/g, `Basic ${REDACTED}`],
  [/\bBearer\s+[\w.~+/-]{8,}=*/g, `Bearer ${REDACTED}`],
];

/**
 * Masks Discord webhook paths, JWTs, `token=` values, Authorization / API-Sign / API-Key headers and the exact
 * values of every registered secret. Applied to all logged text, stored errors and ingested log lines.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  for (const secret of registry().values) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Message of an unknown thrown value, redacted, never including a stack trace. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    return redactSecrets(`${err.message}${cause}`);
  }
  if (typeof err === 'string') return redactSecrets(err);
  return 'unknown error';
}

export interface LoggerOptions {
  scope?: string;
  /** Minimum level; defaults to LOG_LEVEL from the environment (info). Read on every call so tests can change it. */
  level?: LogLevel;
  sink?: (line: string, level: LogLevel) => void;
  now?: () => number;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(scope: string): Logger;
}

function envLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  if (raw === 'warning') return 'warn';
  return 'info';
}

function defaultSink(line: string, level: LogLevel): void {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

function serializeValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** JSON-line logger. Every line is redacted as a whole, so context values cannot leak secrets either. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const now = options.now ?? Date.now;
  const sink = options.sink ?? defaultSink;

  const emit = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    const min = options.level ?? envLevel();
    if (LEVEL_RANK[level] < LEVEL_RANK[min]) return;
    const record: LogContext = { ts: new Date(now()).toISOString(), level, msg };
    if (options.scope) record.scope = options.scope;
    // Caller context can add fields but never overwrite the envelope.
    for (const [key, value] of Object.entries(ctx ?? {})) if (!(key in record)) record[key] = value;
    let line: string;
    try {
      line = JSON.stringify(record, serializeValue);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg, note: 'context not serializable' });
    }
    sink(redactSecrets(line), level);
  };

  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
    child: (scope) => createLogger({ ...options, scope: options.scope ? `${options.scope}.${scope}` : scope }),
  };
}

/** Process-wide logger. */
export const log: Logger = createLogger();
