import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOG_LINE_RE, parseApiLogs, parseLogChunk } from './parser';

function logFixture(name: string): string {
  const url = new URL(`../../../test/fixtures/raw/logs/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/FAKE_tok-en_abc123';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

describe('parseLogChunk', () => {
  it('parses the header fields and stamps UTC epoch ms', () => {
    const { records, carry, lastRecordStart } = parseLogChunk(
      '2026-09-28 04:00:07,965 - freqtrade.freqtradebot - INFO - Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.\n',
    );
    expect(carry).toBe('');
    expect(lastRecordStart).toBe(0);
    expect(records).toEqual([
      {
        at: Date.UTC(2026, 8, 28, 4, 0, 7, 965),
        logger: 'freqtrade.freqtradebot',
        level: 'INFO',
        message: 'Order OX2D7A-ROVIF-A3YVZW was created for ETH/USD and status is open.',
        continuation: [],
      },
    ]);
    expect(records[0]!.at).toBe(1790568007965);
  });

  it('attaches non-matching lines to the previous record as continuation lines', () => {
    const text = [
      '2026-09-28 04:00:08,776 - freqtrade - ERROR - Fatal exception!',
      'Traceback (most recent call last):',
      '  File "/freqtrade/freqtrade/main.py", line 52, in main',
      "ValueError: invalid literal for int() with base 10: ''",
      '2026-09-28 04:00:14,723 - freqtrade.loggers - INFO - Enabling colorized output.',
      '',
    ].join('\n');
    const { records } = parseLogChunk(text);
    expect(records).toHaveLength(2);
    expect(records[0]!.continuation).toEqual([
      'Traceback (most recent call last):',
      '  File "/freqtrade/freqtrade/main.py", line 52, in main',
      "ValueError: invalid literal for int() with base 10: ''",
    ]);
    expect(records[1]!.continuation).toEqual([]);
  });

  it('drops continuation lines that have no record before them (chunk started mid-traceback)', () => {
    const { records, lastRecordStart } = parseLogChunk(
      '  File "x.py", line 1\nValueError: x\n2026-09-28 04:00:14,723 - a - INFO - hi\n',
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe('hi');
    expect(lastRecordStart).toBe('  File "x.py", line 1\nValueError: x\n'.length);
  });

  it('keeps a partial trailing line as carry and completes it with the next chunk', () => {
    const first = parseLogChunk('2026-09-28 04:00:01,000 - a - INFO - one\n2026-09-28 04:00:02,000 - a - INFO - tw');
    expect(first.records.map((r) => r.message)).toEqual(['one']);
    expect(first.carry).toBe('2026-09-28 04:00:02,000 - a - INFO - tw');

    const second = parseLogChunk('o\n2026-09-28 04:00:03,000 - a - INFO - three\n', first.carry);
    expect(second.records.map((r) => r.message)).toEqual(['two', 'three']);
    expect(second.carry).toBe('');
  });

  it('returns no records and the whole text as carry when there is no newline yet', () => {
    expect(parseLogChunk('2026-09-28 04:00:01,000 - a - INFO - partial')).toEqual({
      records: [],
      carry: '2026-09-28 04:00:01,000 - a - INFO - partial',
      lastRecordStart: -1,
    });
  });

  it('handles CRLF line endings', () => {
    const { records } = parseLogChunk('2026-09-28 04:00:01,000 - a - WARNING - w\r\ntrace\r\n');
    expect(records[0]).toMatchObject({ level: 'WARNING', message: 'w', continuation: ['trace'] });
  });

  it('does not assume time ordered lines (F11)', () => {
    const { records } = parseLogChunk(
      '2026-09-28 04:04:00,810 - freqtrade.wallets - INFO - Wallets synced.\n2026-09-28 04:03:59,960 - freqtrade.freqtradebot - INFO - Long signal found\n',
    );
    expect(records.map((r) => r.at)).toEqual([
      Date.UTC(2026, 8, 28, 4, 4, 0, 810),
      Date.UTC(2026, 8, 28, 4, 3, 59, 960),
    ]);
  });

  it('redacts secrets in messages and continuation lines, and in DEBUG records too', () => {
    const text = [
      `2026-09-28 22:20:30,000 - urllib3.connectionpool - DEBUG - https://discord.com:443 "POST ${new URL(FAKE_WEBHOOK).pathname} HTTP/1.1" 204 0`,
      `2026-09-28 22:20:31,000 - uvicorn.error - INFO - ('172.18.0.4', 5) - "WebSocket /api/v1/message/ws?token=${FAKE_JWT}" [accepted]`,
      `2026-09-28 22:20:32,000 - freqtrade.rpc.webhook - ERROR - Could not post to ${FAKE_WEBHOOK}: boom`,
      `RuntimeError: ${FAKE_JWT}`,
      '',
    ].join('\n');
    const { records } = parseLogChunk(text);
    const flat = JSON.stringify(records);
    expect(records).toHaveLength(3);
    expect(flat).not.toContain('FAKE_tok-en_abc123');
    expect(flat).not.toContain(FAKE_JWT);
    expect(flat).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(records[1]!.message).toContain('token=[REDACTED]');
    expect(records[2]!.message).toContain('/api/webhooks/[REDACTED]');
    expect(records[2]!.continuation[0]).toBe('RuntimeError: [REDACTED_JWT]');
  });
});

describe('LOG_LINE_RE', () => {
  it('rejects lines that only look similar', () => {
    expect(LOG_LINE_RE.test('2026-09-28 04:00:07,965 - freqtrade - TRACE - x')).toBe(false);
    expect(LOG_LINE_RE.test('2026-09-28 04:00:07 - freqtrade - INFO - x')).toBe(false);
    expect(LOG_LINE_RE.test('Traceback (most recent call last):')).toBe(false);
  });
});

describe('incident excerpt', () => {
  const text = logFixture('votemax-incident-2026-09-28.log');
  const { records, carry } = parseLogChunk(text);

  it('parses every header line and leaves nothing behind', () => {
    const headerLines = text.split('\n').filter((l) => LOG_LINE_RE.test(l)).length;
    expect(records).toHaveLength(headerLines);
    expect(headerLines).toBe(2229);
    expect(carry).toBe('');
    expect(records.every((r) => Number.isFinite(r.at))).toBe(true);
    expect(records.every((r) => r.level !== 'DEBUG')).toBe(true);
  });

  it('spans both windows and is not monotonic', () => {
    const times = records.map((r) => r.at);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 28, 3, 59, 0));
    expect(Math.max(...times)).toBeLessThan(Date.UTC(2026, 8, 28, 5, 16, 0));
    expect(times.some((t, i) => i > 0 && t < (times[i - 1] as number))).toBe(true);
  });

  it('gives each fatal record its traceback, ending in the exception', () => {
    const fatals = records.filter((r) => r.logger === 'freqtrade' && r.level === 'ERROR');
    expect(fatals).toHaveLength(25);
    for (const f of fatals) {
      expect(f.message).toBe('Fatal exception!');
      expect(f.continuation[0]).toBe('Traceback (most recent call last):');
      expect(f.continuation[f.continuation.length - 1]).toBe("ValueError: invalid literal for int() with base 10: ''");
    }
  });
});

describe('normal -vv excerpt', () => {
  it('parses the DEBUG records (they are only skipped by the event extraction)', () => {
    const { records } = parseLogChunk(logFixture('votemax-normal-vv.log'));
    expect(records).toHaveLength(482);
    expect(records.filter((r) => r.level === 'DEBUG')).toHaveLength(480);
    expect(records.filter((r) => r.level === 'INFO')).toHaveLength(2);
  });
});

describe('parseApiLogs', () => {
  it('reads [asctime, created_ms, logger, level, message] rows using the ms timestamp', () => {
    const records = parseApiLogs({
      log_count: 2,
      logs: [
        ['2026-09-28 21:29:48', 1790630988187.5369, 'freqtrade.wallets', 'INFO', 'Wallets synced.'],
        [
          '2026-09-28 21:29:49',
          1790630989000,
          'freqtrade.rpc.webhook',
          'ERROR',
          `Could not post to ${FAKE_WEBHOOK}\nTraceback (most recent call last):\nOSError: boom`,
        ],
      ],
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      at: 1790630988187,
      logger: 'freqtrade.wallets',
      level: 'INFO',
      message: 'Wallets synced.',
      continuation: [],
    });
    expect(records[1]!.continuation).toEqual(['Traceback (most recent call last):', 'OSError: boom']);
    expect(records[1]!.message).toContain('/api/webhooks/[REDACTED]');
    expect(JSON.stringify(records)).not.toContain('FAKE_tok-en_abc123');
  });

  it('skips malformed rows and the truncated 3-item sample rows, and never throws', () => {
    expect(parseApiLogs(JSON.parse(logFixture('../freqtrade/votemax_logs.json')))).toEqual([]);
    expect(
      parseApiLogs({ logs: [[1], ['t', 'nan', 'a', 'INFO', 'm'], ['t', 5, 'a', 'LOUD', 'm'], ['t', 5, 'a', 'INFO']] }),
    ).toEqual([{ at: 5, logger: 'a', level: 'INFO', message: '', continuation: [] }]);
    expect(parseApiLogs(null)).toEqual([]);
    expect(parseApiLogs({ logs: 'nope' })).toEqual([]);
  });
});
