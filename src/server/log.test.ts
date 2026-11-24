import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRegisteredSecrets,
  createLogger,
  describeError,
  redactSecrets,
  registerSecrets,
  type LogLevel,
} from './log';

afterEach(() => {
  clearRegisteredSecrets();
  vi.restoreAllMocks();
});

describe('redactSecrets patterns', () => {
  it('masks Discord webhook id and token but keeps the rest of the line', () => {
    const line = 'POST https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL123 HTTP/1.1 204';
    const out = redactSecrets(line);
    expect(out).toBe('POST https://discord.com/api/webhooks/[REDACTED] HTTP/1.1 204');
    expect(out).not.toContain('123456789012345678');
    expect(out).not.toContain('abcDEF_ghi-JKL123');
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXBhcnQ';
    const out = redactSecrets(`connection open "GET /api/v1/message/ws?x=1&y=${jwt}"`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('[REDACTED_JWT]');
  });

  it('masks token= values up to the next delimiter', () => {
    expect(redactSecrets('GET /ws?token=abc.def-ghi&channel=x HTTP/1.1')).toBe(
      'GET /ws?token=[REDACTED]&channel=x HTTP/1.1',
    );
    expect(redactSecrets('url=http://h/p?access_token=zzz123 done')).toBe(
      'url=http://h/p?access_token=[REDACTED] done',
    );
    expect(redactSecrets("params='token=s3cr3t' next")).toBe("params='token=[REDACTED]' next");
    expect(redactSecrets('TOKEN=UPPER end')).toBe('token=[REDACTED] end');
  });

  it.each([
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: [REDACTED]'],
    ['authorization: Bearer abc.def.ghi', 'authorization: [REDACTED]'],
    [
      'API-Sign: 4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
      'API-Sign: [REDACTED]',
    ],
    ['API-Key: ABCDEFGHIJKLMNOP done', 'API-Key: [REDACTED] done'],
    ['{"Authorization": "Basic dXNlcjpwYXNzd29yZA==", "x": 1}', '{"Authorization": "[REDACTED]", "x": 1}'],
    ["headers={'Authorization': 'Basic dXNlcjpwYXNzd29yZA=='}", "headers={'Authorization': '[REDACTED]'}"],
    ['Authorization=Bearer topsecretvalue', 'Authorization=[REDACTED]'],
  ])('masks header-style credential %#', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('masks bare Basic and Bearer credentials that lost their header name', () => {
    expect(redactSecrets('sent Basic dXNlcjpwYXNzd29yZA== to host')).toBe('sent Basic [REDACTED] to host');
    expect(redactSecrets('sent Bearer abcdef123456 to host')).toBe('sent Bearer [REDACTED] to host');
  });

  it('leaves ordinary log lines untouched', () => {
    const lines = [
      '2026-09-28 04:00:07,965 - freqtrade.freqtradebot - INFO - Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.',
      "Bot heartbeat. PID=1, version='2026.8', state='RUNNING'",
      'The token bucket refilled; authorization succeeded',
    ];
    for (const line of lines) expect(redactSecrets(line)).toBe(line);
  });

  it('is idempotent', () => {
    const line = 'Authorization: Basic dXNlcjpwYXNzd29yZA== ?token=abc https://x/api/webhooks/1/tok';
    const once = redactSecrets(line);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('redactSecrets exact values', () => {
  it('masks every registered value wherever it appears', () => {
    registerSecrets(['hunter2-hunter2', 'another-secret-value']);
    const out = redactSecrets('login with hunter2-hunter2 failed; retry another-secret-value; hunter2-hunter2');
    expect(out).toBe('login with [REDACTED] failed; retry [REDACTED]; [REDACTED]');
  });

  it('also masks the URL-encoded and JSON-escaped forms', () => {
    registerSecrets(['p@ss w0rd/"x"']);
    expect(redactSecrets('form=p%40ss%20w0rd%2F%22x%22')).toBe('form=[REDACTED]');
    expect(redactSecrets('{"pw":"p@ss w0rd/\\"x\\""}')).toBe('{"pw":"[REDACTED]"}');
    expect(redactSecrets('raw p@ss w0rd/"x"')).toBe('raw [REDACTED]');
  });

  it('masks a longer secret as a whole when it contains a shorter one', () => {
    registerSecrets(['abcdef', 'abcdef-and-more']);
    expect(redactSecrets('x abcdef-and-more y')).toBe('x [REDACTED] y');
  });

  it('ignores empty and very short values so ordinary text is not garbled', () => {
    registerSecrets(['', null, undefined, 'abc', 'true']);
    expect(redactSecrets('abc true 123')).toBe('abc true 123');
  });

  it('keeps working after the module is loaded a second time (registry lives on globalThis)', async () => {
    registerSecrets(['cross-instance-secret']);
    vi.resetModules();
    const second = await import('./log');
    expect(second.redactSecrets('value cross-instance-secret here')).toBe('value [REDACTED] here');
  });
});

describe('describeError', () => {
  it('returns a redacted message without a stack', () => {
    registerSecrets(['s3cr3t-value']);
    const text = describeError(new Error('request failed for s3cr3t-value'));
    expect(text).toBe('request failed for [REDACTED]');
  });

  it('includes and redacts the cause message', () => {
    registerSecrets(['s3cr3t-value']);
    const text = describeError(new Error('outer', { cause: new Error('inner s3cr3t-value') }));
    expect(text).toBe('outer (cause: inner [REDACTED])');
  });

  it('handles strings and unknown values', () => {
    expect(describeError('plain ?token=abc')).toBe('plain ?token=[REDACTED]');
    expect(describeError({ weird: true })).toBe('unknown error');
  });
});

describe('createLogger', () => {
  function capture(level?: LogLevel) {
    const lines: { line: string; level: LogLevel }[] = [];
    const logger = createLogger({
      level,
      now: () => Date.UTC(2026, 8, 28, 4, 0, 7, 965),
      sink: (line, lvl) => lines.push({ line, level: lvl }),
    });
    return { lines, logger };
  }

  it('writes one JSON object per line with an ISO timestamp', () => {
    const { lines, logger } = capture();
    logger.info('started', { botId: 'votemax', n: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.line)).toEqual({
      ts: '2026-09-28T04:00:07.965Z',
      level: 'info',
      msg: 'started',
      botId: 'votemax',
      n: 2,
    });
    expect(lines[0]!.line).not.toContain('\n');
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('reads LOG_LEVEL from the environment when no level is given', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const { lines, logger } = capture();
    logger.debug('visible');
    expect(lines).toHaveLength(1);
    vi.stubEnv('LOG_LEVEL', 'error');
    logger.warn('hidden');
    expect(lines).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it('redacts secrets in the message and in context values', () => {
    registerSecrets(['hunter2-hunter2']);
    const { lines, logger } = capture();
    logger.error('discord: https://discord.com/api/webhooks/123456/tokentoken', {
      password: 'hunter2-hunter2',
      nested: { header: 'Authorization: Basic dXNlcjpwYXNz' },
      err: new Error('boom hunter2-hunter2'),
    });
    const line = lines[0]!.line;
    expect(line).not.toContain('hunter2-hunter2');
    expect(line).not.toContain('tokentoken');
    expect(line).not.toContain('dXNlcjpwYXNz');
    expect(line).toContain('boom [REDACTED]');
  });

  it('redacts a registered secret that needs JSON escaping', () => {
    registerSecrets(['pa"ss\\word-long']);
    const { lines, logger } = capture();
    logger.info('x', { v: 'pa"ss\\word-long' });
    expect(lines[0]!.line).not.toContain('word-long');
  });

  it('never lets context overwrite the envelope fields', () => {
    const { lines, logger } = capture();
    logger.info('real', { msg: 'fake', level: 'error', ts: 'yesterday' });
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ msg: 'real', level: 'info', ts: '2026-09-28T04:00:07.965Z' });
  });

  it('adds a scope for child loggers', () => {
    const { lines, logger } = capture();
    logger.child('poller').child('kraken').info('hi');
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ scope: 'poller.kraken' });
  });

  it('survives a context that cannot be serialized', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.info('loop', { circular });
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ msg: 'loop', note: 'context not serializable' });
  });

  it('writes warnings and errors to stderr and the rest to stdout by default', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createLogger({ level: 'debug' });
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
  });
});
