import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '../client';
import { installTempDb, type TempDb } from '../testing';
import { listNotifications, logNotification, NOTIFICATION_RETENTION_MS, pruneNotifications } from './notifications';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const NOW = 1_790_568_000_000;

describe('notifications log', () => {
  it('records a successful and a failed attempt', () => {
    const okId = logNotification({
      at: NOW,
      channel: 'discord',
      fingerprint: 'UNPERSISTED_ORDER:votemax:ETH/USD',
      kind: 'opened',
      severity: 'critical',
      ok: true,
    });
    const failId = logNotification({
      at: NOW + 1,
      channel: 'push',
      fingerprint: null,
      kind: 'test',
      severity: 'info',
      ok: false,
      error: 'HTTP 503',
    });

    expect(okId).not.toBe(failId);
    expect(listNotifications()).toEqual([
      {
        id: failId,
        at: NOW + 1,
        channel: 'push',
        fingerprint: null,
        kind: 'test',
        severity: 'info',
        ok: false,
        error: 'HTTP 503',
      },
      {
        id: okId,
        at: NOW,
        channel: 'discord',
        fingerprint: 'UNPERSISTED_ORDER:votemax:ETH/USD',
        kind: 'opened',
        severity: 'critical',
        ok: true,
        error: null,
      },
    ]);
  });

  it('clips very long error text', () => {
    logNotification({
      at: NOW,
      channel: 'discord',
      fingerprint: null,
      kind: 'opened',
      severity: 'warning',
      ok: false,
      error: 'e'.repeat(MAX_TEXT_LENGTH + 20),
    });
    expect(listNotifications()[0]?.error).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('filters by since, channel and limit', () => {
    for (let i = 0; i < 4; i += 1) {
      logNotification({
        at: NOW + i,
        channel: i % 2 === 0 ? 'discord' : 'push',
        fingerprint: null,
        kind: 'opened',
        severity: 'warning',
        ok: true,
      });
    }
    expect(listNotifications({ since: NOW + 2 }).map((n) => n.at)).toEqual([NOW + 3, NOW + 2]);
    expect(listNotifications({ channel: 'push' }).map((n) => n.at)).toEqual([NOW + 3, NOW + 1]);
    expect(listNotifications({ limit: 1 }).map((n) => n.at)).toEqual([NOW + 3]);
  });
});

describe('pruneNotifications', () => {
  it('deletes entries older than 30 days', () => {
    const entry = (at: number) => ({
      at,
      channel: 'discord',
      fingerprint: null,
      kind: 'opened',
      severity: 'warning' as const,
      ok: true,
    });
    logNotification(entry(NOW - NOTIFICATION_RETENTION_MS - 1));
    logNotification(entry(NOW - NOTIFICATION_RETENTION_MS));
    logNotification(entry(NOW - 1000));

    expect(pruneNotifications(NOW)).toBe(1);
    expect(listNotifications().map((n) => n.at)).toEqual([NOW - 1000, NOW - NOTIFICATION_RETENTION_MS]);
  });
});
