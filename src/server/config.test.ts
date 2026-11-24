import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSecrets,
  ConfigError,
  DEFAULT_KRAKEN_BASE_URL,
  describeConfig,
  getConfig,
  loadConfig,
  parseConfig,
  resetConfigForTests,
} from './config';
import { clearRegisteredSecrets, redactSecrets } from './log';

const KRAKEN_SECRET_64 = Buffer.alloc(64, 7).toString('base64');

const minimal = {
  SESSION_SECRET: 'session-secret-that-is-long-enough-0123456789',
  FT_BOT_1_ID: 'votemax',
  FT_BOT_1_URL: 'http://freqtrade-votemax:8080',
  FT_BOT_1_USERNAME: 'votemax-user',
  FT_BOT_1_PASSWORD: 'votemax-pass-value',
};

function issuesOf(env: Record<string, string | undefined>) {
  try {
    parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected parseConfig to throw');
}

function variables(err: ConfigError): string[] {
  return err.issues.map((i) => i.variable);
}

afterEach(() => {
  clearRegisteredSecrets();
  resetConfigForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseConfig: valid input', () => {
  it('applies defaults to a minimal environment', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.auth).toEqual({
      sessionSecret: minimal.SESSION_SECRET,
      agentToken: null,
      sessionMaxAgeDays: 30,
      cookieSecure: 'auto',
      appOrigins: [],
      appPublicUrl: null,
      trustProxy: 'none',
      reset: null,
    });
    expect(cfg.bots).toEqual([
      {
        id: 'votemax',
        name: 'votemax',
        url: 'http://freqtrade-votemax:8080',
        username: 'votemax-user',
        password: 'votemax-pass-value',
        logFile: null,
        container: null,
        color: '#4F8CFF',
      },
    ]);
    expect(cfg.kraken).toEqual({
      enabled: false,
      apiKey: null,
      apiSecret: null,
      baseUrl: DEFAULT_KRAKEN_BASE_URL,
      tier: 'starter',
    });
    expect(cfg.reconStartAt).toBeNull();
    expect(cfg.notify).toEqual({
      discordWebhookUrl: null,
      minSeverity: 'warning',
      vapid: null,
      vapidSubject: 'mailto:freqdash@example.com',
    });
    expect(cfg.runtime).toEqual({ pollerEnabled: true, logBackfillHours: 96, logLevel: 'info', dataDir: './data' });
    expect(cfg.warnings).toEqual([]);
  });

  it('parses every optional setting', () => {
    const cfg = parseConfig({
      ...minimal,
      SESSION_MAX_AGE_DAYS: '7',
      COOKIE_SECURE: 'TRUE',
      APP_ORIGINS: 'http://localhost:8043/, https://dash.example.com ,',
      APP_PUBLIC_URL: 'https://dash.example.com/',
      TRUST_PROXY: 'cloudflare',
      FT_BOT_1_NAME: 'VoteMax',
      FT_BOT_1_URL: 'http://freqtrade-votemax:8080/',
      FT_BOT_1_LOGFILE: '/ftlogs/votemax.log',
      FT_BOT_1_COLOR: '#00ff00',
      FT_BOT_2_ID: 'dca',
      FT_BOT_2_URL: 'http://freqtrade-dca:8080',
      FT_BOT_2_USERNAME: 'dca-user',
      FT_BOT_2_PASSWORD: 'dca-pass-value',
      KRAKEN_API_KEY: 'KEYKEYKEYKEY',
      KRAKEN_API_SECRET: KRAKEN_SECRET_64,
      KRAKEN_TIER: 'Pro',
      RECON_START: '2026-09-01T00:00:00Z',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      NOTIFY_MIN_SEVERITY: 'critical',
      POLLER_ENABLED: 'false',
      LOG_BACKFILL_HOURS: '24',
      LOG_LEVEL: 'WARNING',
      DATA_DIR: '/data',
    });
    expect(cfg.auth).toMatchObject({
      sessionMaxAgeDays: 7,
      cookieSecure: true,
      appOrigins: ['http://localhost:8043', 'https://dash.example.com'],
      appPublicUrl: 'https://dash.example.com',
      trustProxy: 'cloudflare',
    });
    expect(cfg.bots.map((b) => [b.id, b.name, b.url, b.logFile, b.color])).toEqual([
      ['votemax', 'VoteMax', 'http://freqtrade-votemax:8080', '/ftlogs/votemax.log', '#00ff00'],
      ['dca', 'dca', 'http://freqtrade-dca:8080', null, '#B38CFF'],
    ]);
    expect(cfg.kraken).toMatchObject({
      enabled: true,
      apiKey: 'KEYKEYKEYKEY',
      apiSecret: KRAKEN_SECRET_64,
      tier: 'pro',
    });
    expect(cfg.reconStartAt).toBe(Date.UTC(2026, 8, 1));
    expect(cfg.notify.minSeverity).toBe('critical');
    expect(cfg.runtime).toEqual({ pollerEnabled: false, logBackfillHours: 24, logLevel: 'warn', dataDir: '/data' });
  });

  it('treats blank values like unset ones, as the .env examples ship them', () => {
    const cfg = parseConfig({
      ...minimal,
      KRAKEN_API_KEY: '',
      KRAKEN_API_SECRET: '  ',
      DISCORD_WEBHOOK_URL: '',
      FT_BOT_2_ID: '',
      FT_BOT_2_URL: '',
    });
    expect(cfg.kraken.enabled).toBe(false);
    expect(cfg.notify.discordWebhookUrl).toBeNull();
    expect(cfg.bots).toHaveLength(1);
  });

  it('accepts bots with gaps in their numbering and up to ten of them', () => {
    const env: Record<string, string> = { ...minimal };
    for (const n of [3, 10]) {
      env[`FT_BOT_${n}_ID`] = `bot-${n}`;
      env[`FT_BOT_${n}_URL`] = `http://bot-${n}:8080`;
      env[`FT_BOT_${n}_USERNAME`] = 'user';
      env[`FT_BOT_${n}_PASSWORD`] = 'pass';
    }
    expect(parseConfig(env).bots.map((b) => b.id)).toEqual(['votemax', 'bot-3', 'bot-10']);
  });

  it('warns about a non-default Kraken endpoint without printing it', () => {
    const cfg = parseConfig({ ...minimal, KRAKEN_API_BASE_URL: 'http://localhost:9999/kraken/' });
    expect(cfg.kraken.baseUrl).toBe('http://localhost:9999/kraken');
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings[0]).toContain('KRAKEN_API_BASE_URL');
    expect(cfg.warnings[0]).not.toContain('localhost');
    expect(parseConfig({ ...minimal, KRAKEN_API_BASE_URL: DEFAULT_KRAKEN_BASE_URL }).warnings).toEqual([]);
  });

  it('ignores bot numbers outside 1..10 with a warning', () => {
    const cfg = parseConfig({ ...minimal, FT_BOT_11_ID: 'extra', FT_BOT_0_ID: 'zero' });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.warnings.join('\n')).toContain('FT_BOT_11_ID');
    expect(cfg.warnings.join('\n')).toContain('FT_BOT_0_ID');
  });
});

describe('parseConfig: invalid input', () => {
  it('lists every missing required variable by name', () => {
    const err = issuesOf({});
    expect(variables(err)).toEqual(['SESSION_SECRET', 'FT_BOT_1_ID']);
    expect(err.message).toContain('SESSION_SECRET');
    expect(err.message).toContain('FT_BOT_1_ID');
  });

  it('rejects a weak reset password and a short session secret', () => {
    const err = issuesOf({
      ...minimal,
      AUTH_RESET_USER: 'partner',
      AUTH_RESET_PASSWORD: 'short-pw',
      SESSION_SECRET: 'too-short',
    });
    expect(variables(err)).toEqual(['AUTH_RESET_PASSWORD', 'SESSION_SECRET']);
    expect(err.issues[0]?.problem).toContain('12');
    expect(err.issues[1]?.problem).toContain('32');
  });

  it('accepts the boundary lengths', () => {
    expect(() =>
      parseConfig({
        ...minimal,
        AUTH_RESET_USER: 'partner',
        AUTH_RESET_PASSWORD: 'x'.repeat(12),
        SESSION_SECRET: 'y'.repeat(32),
      }),
    ).not.toThrow();
    expect(() => parseConfig({ ...minimal, SESSION_SECRET: 'y'.repeat(31) })).toThrow(ConfigError);
  });

  it('needs AUTH_RESET_USER and AUTH_RESET_PASSWORD together, and warns while they are set', () => {
    expect(variables(issuesOf({ ...minimal, AUTH_RESET_USER: 'partner' }))).toEqual(['AUTH_RESET_PASSWORD']);
    expect(variables(issuesOf({ ...minimal, AUTH_RESET_PASSWORD: 'long-enough-password' }))).toEqual([
      'AUTH_RESET_USER',
    ]);
    const cfg = parseConfig({ ...minimal, AUTH_RESET_USER: 'partner', AUTH_RESET_PASSWORD: 'long-enough-password' });
    expect(cfg.auth.reset).toEqual({ username: 'partner', password: 'long-enough-password' });
    expect(cfg.warnings.join('\n')).toContain('AUTH_RESET_USER');
    expect(cfg.warnings.join('\n')).not.toContain('long-enough-password');
  });

  it('accepts a leftover DASHBOARD_PASSWORD with a warning (sign-in uses accounts now)', () => {
    const cfg = parseConfig({ ...minimal, DASHBOARD_PASSWORD: 'old-shared-password' });
    expect(cfg.warnings.join('\n')).toContain('DASHBOARD_PASSWORD is no longer used');
    expect(cfg.warnings.join('\n')).not.toContain('old-shared-password');
    expect(collectSecrets(cfg, { DASHBOARD_PASSWORD: 'old-shared-password' })).toContain('old-shared-password');
  });

  it('validates VAPID keys (both or neither) and the subject', () => {
    const pub = Buffer.alloc(65, 4).toString('base64url');
    const priv = Buffer.alloc(32, 9).toString('base64url');
    expect(parseConfig({ ...minimal, VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv }).notify.vapid).toEqual({
      publicKey: pub,
      privateKey: priv,
    });
    expect(variables(issuesOf({ ...minimal, VAPID_PUBLIC_KEY: pub }))).toEqual(['VAPID_PRIVATE_KEY']);
    expect(variables(issuesOf({ ...minimal, VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: priv }))).toEqual([
      'VAPID_PUBLIC_KEY',
    ]);
    expect(variables(issuesOf({ ...minimal, VAPID_SUBJECT: 'http://insecure.example' }))).toEqual(['VAPID_SUBJECT']);
    expect(parseConfig({ ...minimal, VAPID_SUBJECT: 'mailto:ops@example.org' }).notify.vapidSubject).toBe(
      'mailto:ops@example.org',
    );
    expect(parseConfig({ ...minimal, APP_PUBLIC_URL: 'https://dash.example.org/' }).notify.vapidSubject).toBe(
      'https://dash.example.org',
    );
    const withKey = parseConfig({ ...minimal, VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv });
    expect(collectSecrets(withKey)).toContain(priv);
  });

  it('requires a fully specified bot once any of its variables is set', () => {
    const err = issuesOf({ ...minimal, FT_BOT_2_ID: 'dca' });
    expect(variables(err)).toEqual(['FT_BOT_2_URL', 'FT_BOT_2_USERNAME', 'FT_BOT_2_PASSWORD']);
  });

  it('rejects malformed bot ids, urls and colors', () => {
    const err = issuesOf({ ...minimal, FT_BOT_1_ID: 'Vote Max', FT_BOT_1_URL: 'ftp://host', FT_BOT_1_COLOR: 'blue' });
    expect(variables(err).sort()).toEqual(['FT_BOT_1_COLOR', 'FT_BOT_1_ID', 'FT_BOT_1_URL']);
  });

  it('rejects duplicate bot ids and points at the earlier one', () => {
    const err = issuesOf({
      ...minimal,
      FT_BOT_2_ID: 'votemax',
      FT_BOT_2_URL: 'http://other:8080',
      FT_BOT_2_USERNAME: 'u',
      FT_BOT_2_PASSWORD: 'p',
    });
    expect(err.issues).toEqual([{ variable: 'FT_BOT_2_ID', problem: 'must be unique (already used by FT_BOT_1_ID)' }]);
  });

  it('rejects a bot url with embedded credentials', () => {
    const err = issuesOf({ ...minimal, FT_BOT_1_URL: 'http://admin:sup3rs3cret@freqtrade:8080' });
    expect(variables(err)).toEqual(['FT_BOT_1_URL']);
  });

  it('requires the Kraken key and secret together', () => {
    expect(variables(issuesOf({ ...minimal, KRAKEN_API_KEY: 'KEYKEY' }))).toEqual(['KRAKEN_API_SECRET']);
    expect(variables(issuesOf({ ...minimal, KRAKEN_API_SECRET: KRAKEN_SECRET_64 }))).toEqual(['KRAKEN_API_KEY']);
  });

  it('requires the Kraken secret to be base64 of exactly 64 bytes', () => {
    const wrongLength = Buffer.alloc(32, 1).toString('base64');
    expect(variables(issuesOf({ ...minimal, KRAKEN_API_KEY: 'KEYKEY', KRAKEN_API_SECRET: wrongLength }))).toEqual([
      'KRAKEN_API_SECRET',
    ]);
    expect(
      variables(issuesOf({ ...minimal, KRAKEN_API_KEY: 'KEYKEY', KRAKEN_API_SECRET: 'not base64 at all!' })),
    ).toEqual(['KRAKEN_API_SECRET']);
    expect(() =>
      parseConfig({ ...minimal, KRAKEN_API_KEY: 'KEYKEY', KRAKEN_API_SECRET: KRAKEN_SECRET_64 }),
    ).not.toThrow();
  });

  it('rejects invalid enums, numbers, urls and dates', () => {
    const err = issuesOf({
      ...minimal,
      COOKIE_SECURE: 'maybe',
      TRUST_PROXY: 'nginx',
      KRAKEN_TIER: 'gold',
      NOTIFY_MIN_SEVERITY: 'loud',
      POLLER_ENABLED: 'perhaps',
      LOG_LEVEL: 'chatty',
      SESSION_MAX_AGE_DAYS: '0',
      LOG_BACKFILL_HOURS: '9999',
      APP_ORIGINS: 'http://ok.example, not-a-url',
      APP_PUBLIC_URL: 'nope',
      KRAKEN_API_BASE_URL: 'ftp://x',
      DISCORD_WEBHOOK_URL: 'nope',
      RECON_START: 'yesterday-ish',
    });
    expect(variables(err).sort()).toEqual(
      [
        'APP_ORIGINS',
        'APP_PUBLIC_URL',
        'COOKIE_SECURE',
        'DISCORD_WEBHOOK_URL',
        'KRAKEN_API_BASE_URL',
        'KRAKEN_TIER',
        'LOG_BACKFILL_HOURS',
        'LOG_LEVEL',
        'NOTIFY_MIN_SEVERITY',
        'POLLER_ENABLED',
        'RECON_START',
        'SESSION_MAX_AGE_DAYS',
        'TRUST_PROXY',
      ].sort(),
    );
  });

  it('never puts a rejected value in the error, its message or its issues', () => {
    const sentinels = [
      'SENTINEL-pw', // too short for AUTH_RESET_PASSWORD
      'SENTINEL-session', // too short for SESSION_SECRET
      'SENTINEL-kraken-secret!', // not base64
      'SENTINEL-kraken-key with space',
      'sup3rs3cret-SENTINEL', // credentials embedded in a URL
      'SENTINEL-mode', // bad enum
      'SENTINEL-date', // bad date
      'SENTINEL-origin', // bad origin list
      'SENTINEL-color',
      'SENTINEL-botid',
      'SENTINEL-webhook',
    ];
    const err = issuesOf({
      AUTH_RESET_USER: 'partner',
      AUTH_RESET_PASSWORD: sentinels[0],
      SESSION_SECRET: sentinels[1],
      KRAKEN_API_SECRET: sentinels[2],
      KRAKEN_API_KEY: sentinels[3],
      FT_BOT_1_ID: sentinels[10],
      FT_BOT_1_URL: `http://admin:${sentinels[4]}@freqtrade:8080`,
      FT_BOT_1_USERNAME: 'user',
      FT_BOT_1_PASSWORD: 'pass',
      FT_BOT_1_COLOR: sentinels[8],
      FT_BOT_2_ID: sentinels[9],
      COOKIE_SECURE: sentinels[5],
      RECON_START: sentinels[6],
      APP_ORIGINS: sentinels[7],
      DISCORD_WEBHOOK_URL: sentinels[10],
    });
    expect(err.issues.length).toBeGreaterThanOrEqual(10);
    const printed = [err.message, err.stack ?? '', JSON.stringify(err.issues), String(err)].join('\n');
    for (const sentinel of sentinels) expect(printed).not.toContain(sentinel);
    expect(printed).not.toContain('sup3rs3cret');
    expect(printed).not.toContain('admin');
  });
});

describe('secrets handling', () => {
  it('collects every credential, including the derived Basic header value', () => {
    const cfg = parseConfig({
      ...minimal,
      KRAKEN_API_KEY: 'KEYKEYKEYKEY',
      KRAKEN_API_SECRET: KRAKEN_SECRET_64,
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456/tokenpart-abc_DEF',
      AUTH_RESET_USER: 'partner',
      AUTH_RESET_PASSWORD: 'reset-password-value',
    });
    const secrets = collectSecrets(cfg);
    expect(secrets).toEqual(
      expect.arrayContaining([
        'reset-password-value',
        minimal.SESSION_SECRET,
        minimal.FT_BOT_1_PASSWORD,
        Buffer.from(`${minimal.FT_BOT_1_USERNAME}:${minimal.FT_BOT_1_PASSWORD}`).toString('base64'),
        'KEYKEYKEYKEY',
        KRAKEN_SECRET_64,
        'https://discord.com/api/webhooks/123456/tokenpart-abc_DEF',
        'tokenpart-abc_DEF',
      ]),
    );
  });

  it('loadConfig registers the secrets so redactSecrets masks them', () => {
    loadConfig({ ...minimal, KRAKEN_API_KEY: 'KEYKEYKEYKEY', KRAKEN_API_SECRET: KRAKEN_SECRET_64 });
    const text = `ss=${minimal.SESSION_SECRET} bot=${minimal.FT_BOT_1_PASSWORD} secret=${KRAKEN_SECRET_64} key=KEYKEYKEYKEY`;
    const out = redactSecrets(text);
    for (const value of [minimal.SESSION_SECRET, minimal.FT_BOT_1_PASSWORD, KRAKEN_SECRET_64, 'KEYKEYKEYKEY']) {
      expect(out).not.toContain(value);
    }
  });

  it('loadConfig logs warnings but never the configuration', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    loadConfig({ ...minimal, KRAKEN_API_BASE_URL: 'http://localhost:9999/kraken' });
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('KRAKEN_API_BASE_URL');
    expect(written).not.toContain(minimal.SESSION_SECRET);
    expect(written).not.toContain(minimal.FT_BOT_1_PASSWORD);
  });

  it('describeConfig contains no secret value', () => {
    const cfg = parseConfig({
      ...minimal,
      KRAKEN_API_KEY: 'KEYKEYKEYKEY',
      KRAKEN_API_SECRET: KRAKEN_SECRET_64,
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456/tokenpart-abc_DEF',
    });
    const text = JSON.stringify(describeConfig(cfg));
    for (const secret of collectSecrets(cfg)) expect(text).not.toContain(secret);
    expect(text).not.toContain('freqtrade-votemax');
    expect(JSON.parse(text)).toMatchObject({ kraken: { enabled: true }, notify: { discord: true } });
  });
});

describe('getConfig', () => {
  it('loads from process.env once and caches the result', () => {
    for (const [key, value] of Object.entries(minimal)) vi.stubEnv(key, value);
    const first = getConfig();
    vi.stubEnv('SESSION_SECRET', 'changed-after-first-load-0123456789-abcdef');
    expect(getConfig()).toBe(first);
    resetConfigForTests();
    expect(getConfig().auth.sessionSecret).toBe('changed-after-first-load-0123456789-abcdef');
  });

  it('does not cache a failure', () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('FT_BOT_1_ID', '');
    expect(() => getConfig()).toThrow(ConfigError);
    for (const [key, value] of Object.entries(minimal)) vi.stubEnv(key, value);
    expect(getConfig().bots).toHaveLength(1);
  });
});

function parseEnvFile(path: string): { pairs: Record<string, string>; lines: string[] } {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const pairs: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    pairs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { pairs, lines };
}

describe('the shipped .env examples', () => {
  it('.env.dev.example is a valid configuration pointing at the mock upstreams', () => {
    const { pairs } = parseEnvFile('.env.dev.example');
    const cfg = parseConfig(pairs);
    expect(cfg.bots.map((b) => b.id)).toEqual(['votemax', 'dca']);
    expect(cfg.bots.every((b) => b.url.startsWith('http://localhost:9999/'))).toBe(true);
    expect(cfg.kraken.enabled).toBe(true);
    expect(cfg.kraken.baseUrl).toBe('http://localhost:9999/kraken');
    expect(cfg.runtime.pollerEnabled).toBe(false);
  });

  it('.env.example lists every variable and validates once the blanks are filled', () => {
    const { pairs } = parseEnvFile('.env.example');
    const cfg = parseConfig({
      ...pairs,
      SESSION_SECRET: 'filled-in-session-secret-0123456789',
      FT_BOT_1_USERNAME: 'u1',
      FT_BOT_1_PASSWORD: 'p1',
      FT_BOT_2_USERNAME: 'u2',
      FT_BOT_2_PASSWORD: 'p2',
    });
    expect(cfg.bots.map((b) => b.id)).toEqual(['bot1', 'bot2']);
    expect(cfg.kraken.enabled).toBe(false);
    expect(cfg.auth.appOrigins).toEqual(['http://localhost:8043']);
    expect(cfg.auth.trustProxy).toBe('none');
    expect(cfg.killswitch.mode).toBe('off');
  });

  it.each(['.env.example', '.env.dev.example'])(
    '%s has no trailing comments (docker --env-file keeps them in the value)',
    (file) => {
      const { lines } = parseEnvFile(file);
      for (const line of lines) {
        if (line.trim() === '' || line.startsWith('#')) continue;
        // A leading # is a value (colors); whitespace followed by # would start an inline comment.
        expect(line).toMatch(/^[A-Z][A-Z0-9_]*=#?[^\s#]*$/);
      }
    },
  );

  it('.env.dev.example holds only dummy values', () => {
    const { pairs } = parseEnvFile('.env.dev.example');
    for (const key of ['SESSION_SECRET', 'KRAKEN_API_KEY', 'FT_BOT_1_PASSWORD', 'FT_BOT_2_PASSWORD']) {
      expect(pairs[key]).toMatch(/dev|mock|DEV|MOCK/);
    }
    expect(Buffer.from(pairs.KRAKEN_API_SECRET ?? '', 'base64').toString()).toContain('not-a-real-key');
  });
});
