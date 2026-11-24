import { describe, expect, it } from 'vitest';
import type { Severity } from '@/shared/types/domain';
import type { Finding, RawFinding } from '@/shared/types/findings';
import { MIN, SEC, T0 } from '../../../test/fixtures/incident/builders';
import { DEFAULT_CHECK_CONFIG as CFG } from './config';
import { applyLifecycle, type FindingDraft } from './lifecycle';

const FP = 'UNPERSISTED_ORDER:votemax:ETH/USD';
const HOUR_MS = 60 * MIN;

function raw(over: Partial<RawFinding> = {}): RawFinding {
  return {
    rule: 'UNPERSISTED_ORDER',
    fingerprint: FP,
    severity: 'critical',
    title: 'title',
    detail: 'detail',
    subject: { botId: 'votemax' },
    evidence: {},
    ...over,
  };
}

/** A persisted row, by default an active critical one seen at T0. */
function row(over: Partial<Finding> = {}): Finding {
  return {
    id: 1,
    rule: 'UNPERSISTED_ORDER',
    fingerprint: FP,
    severity: 'critical',
    title: 'title',
    detail: 'detail',
    subject: { botId: 'votemax' },
    evidence: {},
    evidenceKeys: [],
    minDurationMs: 0,
    clearAfterMs: 30_000,
    status: 'active',
    maxSeverity: 'critical',
    firstSeenAt: T0,
    episodeStartAt: T0,
    activeSince: T0,
    lastSeenAt: T0,
    clearedAt: null,
    resolvedAt: null,
    occurrences: 1,
    flapCount: 0,
    silenced: null,
    notifiedAt: null,
    notifiedSeverity: null,
    notifiedEvidenceCount: null,
    ...over,
  };
}

const keys = (n: number) => Array.from({ length: n }, (_, i) => `O${i}`);
const only = (drafts: FindingDraft[]): FindingDraft => {
  expect(drafts).toHaveLength(1);
  return drafts[0]!;
};

describe('creating and updating findings', () => {
  it('creates an active row for a raw finding without minimum duration', () => {
    const { next, notifications, discardIds } = applyLifecycle([], [raw({ severity: 'warning' })], T0, CFG);
    const d = only(next);
    expect(d).toMatchObject({
      id: null,
      status: 'active',
      severity: 'warning',
      maxSeverity: 'warning',
      firstSeenAt: T0,
      episodeStartAt: T0,
      activeSince: T0,
      lastSeenAt: T0,
      clearedAt: null,
      resolvedAt: null,
      occurrences: 1,
      flapCount: 0,
      silenced: null,
      notifiedAt: null,
      minDurationMs: 0,
      clearAfterMs: CFG.defaultClearAfterMs,
      evidenceKeys: [],
    });
    expect(notifications).toEqual([]);
    expect(discardIds).toEqual([]);
  });

  it('creates a pending row when a minimum duration is required, and promotes it exactly when it has elapsed', () => {
    const r = raw({ minDurationMs: 90_000 });
    const created = only(applyLifecycle([], [r], T0, CFG).next);
    expect(created).toMatchObject({ status: 'pending', activeSince: null, minDurationMs: 90_000 });
    const early = only(applyLifecycle([row({ ...created, id: 1 } as Finding)], [r], T0 + 90_000 - 1, CFG).next);
    expect(early.status).toBe('pending');
    const promoted = only(applyLifecycle([row({ ...created, id: 1 } as Finding)], [r], T0 + 90_000, CFG).next);
    expect(promoted).toMatchObject({ status: 'active', activeSince: T0 + 90_000, id: 1 });
  });

  it('never announces a pending row', () => {
    const { notifications } = applyLifecycle([], [raw({ minDurationMs: 90_000, severity: 'critical' })], T0, CFG);
    expect(notifications).toEqual([]);
  });

  it('refreshes an existing row from the raw finding and keeps the highest severity seen', () => {
    const prev = row({
      severity: 'warning',
      maxSeverity: 'critical',
      lastSeenAt: T0 - 10_000,
      title: 'old',
      clearedAt: T0 - 5000,
    });
    const d = only(
      applyLifecycle(
        [prev],
        [raw({ severity: 'warning', title: 'new', evidence: { n: 2 }, evidenceKeys: ['a'] })],
        T0,
        CFG,
      ).next,
    );
    expect(d).toMatchObject({
      id: 1,
      title: 'new',
      evidence: { n: 2 },
      evidenceKeys: ['a'],
      lastSeenAt: T0,
      clearedAt: null,
      maxSeverity: 'critical',
      severity: 'warning',
    });
  });

  it('takes timing parameters from the latest raw finding, including escalation settings', () => {
    const d = only(
      applyLifecycle(
        [row()],
        [
          raw({
            clearAfterMs: 5000,
            minDurationMs: 0,
            escalateAfterMs: 1_000_000,
            escalateTo: 'critical',
            severity: 'info',
          }),
        ],
        T0,
        CFG,
      ).next,
    );
    expect(d).toMatchObject({ clearAfterMs: 5000, escalateAfterMs: 1_000_000, escalateTo: 'critical' });
    const none = only(applyLifecycle([d as Finding], [raw()], T0, CFG).next);
    expect('escalateAfterMs' in none).toBe(false);
    expect('escalateTo' in none).toBe(false);
  });

  it('treats two raw findings with one fingerprint as one, keeping the more severe', () => {
    const d = only(
      applyLifecycle(
        [],
        [
          raw({ severity: 'info', title: 'a' }),
          raw({ severity: 'critical', title: 'b' }),
          raw({ severity: 'warning', title: 'c' }),
        ],
        T0,
        CFG,
      ).next,
    );
    expect(d).toMatchObject({ severity: 'critical', title: 'b' });
  });

  it('escalates the severity after escalateAfterMs of being active (boundary)', () => {
    const r = raw({
      severity: 'info',
      escalateAfterMs: 75 * MIN,
      escalateTo: 'warning',
      rule: 'USD_VIEW_DRIFT',
      fingerprint: 'USD_VIEW_DRIFT:dca',
    });
    const prev = row({
      rule: 'USD_VIEW_DRIFT',
      fingerprint: 'USD_VIEW_DRIFT:dca',
      severity: 'info',
      maxSeverity: 'info',
      activeSince: T0,
    });
    expect(only(applyLifecycle([prev], [r], T0 + 75 * MIN - 1, CFG).next).severity).toBe('info');
    const d = only(applyLifecycle([prev], [r], T0 + 75 * MIN, CFG).next);
    expect(d).toMatchObject({ severity: 'warning', maxSeverity: 'warning' });
    const stays = only(
      applyLifecycle([{ ...prev, severity: 'critical' }], [raw({ ...r, severity: 'critical' })], T0 + 80 * MIN, CFG)
        .next,
    );
    expect(stays.severity).toBe('critical');
  });
});

describe('clearing and resolving', () => {
  it('marks an absent row as cleared and keeps it active until the clear timer has run (boundary)', () => {
    const prev = row({ clearAfterMs: 30_000 });
    const first = only(applyLifecycle([prev], [], T0, CFG).next);
    expect(first).toMatchObject({ status: 'active', clearedAt: T0, resolvedAt: null });
    const before = only(applyLifecycle([first as Finding], [], T0 + 30_000 - 1, CFG).next);
    expect(before).toMatchObject({ status: 'active', clearedAt: T0 });
    const at = only(applyLifecycle([first as Finding], [], T0 + 30_000, CFG).next);
    expect(at).toMatchObject({ status: 'resolved', resolvedAt: T0 + 30_000, clearedAt: T0 });
  });

  it('a cleared row whose finding reappears before resolving simply continues (no flap)', () => {
    const cleared = row({ clearedAt: T0 - 10_000 });
    const d = only(applyLifecycle([cleared], [raw()], T0, CFG).next);
    expect(d).toMatchObject({ status: 'active', clearedAt: null, flapCount: 0, occurrences: 1 });
  });

  it('a pending row that vanishes is discarded, never shown or announced', () => {
    const pending = row({ id: 7, status: 'pending', activeSince: null, minDurationMs: 90_000 });
    const { next, notifications, discardIds } = applyLifecycle([pending], [], T0 + 10_000, CFG);
    expect(next).toEqual([]);
    expect(notifications).toEqual([]);
    expect(discardIds).toEqual([7]);
  });

  it('clearNow resolves an absent row in the same pass, without waiting out the hold', () => {
    const prev = row({ clearAfterMs: 90_000 });
    const held = only(applyLifecycle([prev], [], T0, CFG).next);
    expect(held.status).toBe('active');
    const now = only(applyLifecycle([prev], [], T0, CFG, { clearNow: () => true }).next);
    expect(now).toMatchObject({ status: 'resolved', resolvedAt: T0 });
  });

  it('clearNow does not affect rows that are still raised, and false keeps the normal hold', () => {
    const still = only(applyLifecycle([row()], [raw()], T0, CFG, { clearNow: () => true }).next);
    expect(still.status).toBe('active');
    const held = only(applyLifecycle([row({ clearAfterMs: 90_000 })], [], T0, CFG, { clearNow: () => false }).next);
    expect(held.status).toBe('active');
  });

  it('a zero clear timer resolves immediately', () => {
    const d = only(applyLifecycle([row({ clearAfterMs: 0 })], [], T0, CFG).next);
    expect(d.status).toBe('resolved');
  });

  it('repairs a second open row with the same fingerprint by resolving it quietly', () => {
    const a = row({ id: 1, notifiedSeverity: 'critical', notifiedAt: T0 });
    const b = row({ id: 2, notifiedSeverity: 'critical', notifiedAt: T0 });
    const { next, notifications } = applyLifecycle([a, b], [raw()], T0, CFG);
    expect(next.map((d) => [d.id, d.status])).toEqual([
      [1, 'active'],
      [2, 'resolved'],
    ]);
    expect(notifications).toEqual([]);
  });

  it('resolves absent rows of several fingerprints independently', () => {
    const a = row({ id: 1, fingerprint: 'A', clearAfterMs: 0 });
    const b = row({ id: 2, fingerprint: 'B', clearAfterMs: 60_000 });
    const { next } = applyLifecycle([a, b], [], T0, CFG);
    expect(next.map((d) => [d.fingerprint, d.status])).toEqual([
      ['A', 'resolved'],
      ['B', 'active'],
    ]);
  });
});

describe('flapping', () => {
  const resolvedAt = T0 - 10 * MIN;
  const resolved = (over: Partial<Finding> = {}) =>
    row({
      status: 'resolved',
      resolvedAt,
      clearedAt: resolvedAt - 30_000,
      notifiedSeverity: 'warning',
      notifiedAt: T0 - 40 * MIN,
      occurrences: 2,
      flapCount: 1,
      ...over,
    });

  it('reopens the resolved row when the finding returns within 30 minutes', () => {
    const d = only(applyLifecycle([resolved()], [raw({ severity: 'warning' })], T0, CFG).next);
    expect(d).toMatchObject({
      id: 1,
      status: 'active',
      flapCount: 2,
      occurrences: 3,
      episodeStartAt: T0,
      activeSince: T0,
      resolvedAt: null,
      clearedAt: null,
      firstSeenAt: T0,
    });
  });

  it('reopens at exactly 30 minutes and starts a new row a millisecond later (boundary)', () => {
    const edge = only(applyLifecycle([resolved({ resolvedAt: T0 - 30 * MIN })], [raw()], T0, CFG).next);
    expect(edge.id).toBe(1);
    const late = only(applyLifecycle([resolved({ resolvedAt: T0 - 30 * MIN - 1 })], [raw()], T0, CFG).next);
    expect(late).toMatchObject({ id: null, flapCount: 0, occurrences: 1 });
  });

  it('a reopened row honours the minimum duration again', () => {
    const d = only(applyLifecycle([resolved()], [raw({ minDurationMs: 90_000 })], T0, CFG).next);
    expect(d).toMatchObject({ id: 1, status: 'pending', activeSince: null, flapCount: 2 });
  });

  it('picks the most recently resolved row when there are several', () => {
    const older = resolved({ id: 3, resolvedAt: T0 - 20 * MIN });
    const newer = resolved({ id: 4, resolvedAt: T0 - 5 * MIN });
    expect(only(applyLifecycle([older, newer], [raw()], T0, CFG).next).id).toBe(4);
  });

  it('does not repeat announcements for a finding that was announced and never announced as resolved', () => {
    const wasAnnounced = resolved({ severity: 'critical', notifiedSeverity: 'critical', notifiedAt: T0 - 20 * MIN });
    const { notifications, next } = applyLifecycle([wasAnnounced], [raw()], T0, CFG);
    expect(notifications).toEqual([]);
    expect(only(next).notifiedSeverity).toBe('critical');
  });

  it('announces a reopen again once the resolved notice has gone out', () => {
    const announcedResolved = resolved({ severity: 'critical', notifiedSeverity: null, notifiedAt: T0 - 2 * MIN });
    const { notifications } = applyLifecycle([announcedResolved], [raw()], T0, CFG);
    expect(notifications).toMatchObject([{ kind: 'opened', severity: 'critical' }]);
  });

  it('keeps a silence across a reopen', () => {
    const silenced = { at: T0 - HOUR_MS, by: 'me', note: null, severity: 'critical' as Severity, evidenceCount: 0 };
    const d = only(applyLifecycle([resolved({ silenced })], [raw()], T0, CFG).next);
    expect(d.silenced).toEqual(silenced);
  });
});

describe('silence', () => {
  const silenced = (severity: Severity, evidenceCount: number) => ({
    at: T0 - MIN,
    by: 'me',
    note: 'known',
    severity,
    evidenceCount,
  });

  it('a silenced finding is updated but never announced', () => {
    const { next, notifications } = applyLifecycle([row({ silenced: silenced('critical', 0) })], [raw()], T0, CFG);
    expect(only(next).silenced).not.toBeNull();
    expect(notifications).toEqual([]);
  });

  it('is lifted when the severity rises above the silenced severity, and the finding is announced', () => {
    const prev = row({
      severity: 'warning',
      silenced: silenced('warning', 0),
      notifiedSeverity: 'warning',
      notifiedAt: T0 - 20 * MIN,
    });
    const { next, notifications } = applyLifecycle([prev], [raw({ severity: 'critical' })], T0, CFG);
    expect(only(next).silenced).toBeNull();
    expect(notifications).toMatchObject([{ kind: 'escalated', severity: 'critical' }]);
  });

  it('is lifted when the evidence grows beyond the silenced count', () => {
    const prev = row({ silenced: silenced('critical', 2), evidenceKeys: keys(2) });
    expect(only(applyLifecycle([prev], [raw({ evidenceKeys: keys(2) })], T0, CFG).next).silenced).not.toBeNull();
    expect(only(applyLifecycle([prev], [raw({ evidenceKeys: keys(3) })], T0, CFG).next).silenced).toBeNull();
  });

  it('is not lifted by a lower severity', () => {
    const prev = row({ silenced: silenced('critical', 0) });
    expect(only(applyLifecycle([prev], [raw({ severity: 'warning' })], T0, CFG).next).silenced).not.toBeNull();
  });
});

describe('notifications', () => {
  it('announces a critical finding immediately, once, with the finding id', () => {
    const first = applyLifecycle([], [raw()], T0, CFG);
    expect(first.notifications).toEqual([
      { fingerprint: FP, findingId: null, kind: 'opened', severity: 'critical', title: 'title', detail: 'detail' },
    ]);
    const stored = { ...first.next[0]!, id: 9 } as Finding;
    expect(stored).toMatchObject({ notifiedSeverity: 'critical', notifiedAt: T0, notifiedEvidenceCount: 0 });
    expect(applyLifecycle([stored], [raw()], T0 + 10_000, CFG).notifications).toEqual([]);
  });

  it('announces a warning only once it has been active for 5 minutes (boundary)', () => {
    const prev = row({ severity: 'warning', maxSeverity: 'warning', activeSince: T0 });
    expect(applyLifecycle([prev], [raw({ severity: 'warning' })], T0 + 5 * MIN - 1, CFG).notifications).toEqual([]);
    expect(applyLifecycle([prev], [raw({ severity: 'warning' })], T0 + 5 * MIN, CFG).notifications).toMatchObject([
      { kind: 'opened', severity: 'warning', findingId: 1 },
    ]);
  });

  it('respects the minimum announced severity', () => {
    const prev = row({ severity: 'warning', maxSeverity: 'warning', activeSince: T0 });
    const later = T0 + 10 * MIN;
    expect(
      applyLifecycle([prev], [raw({ severity: 'warning' })], later, CFG, { notifyMinSeverity: 'critical' })
        .notifications,
    ).toEqual([]);
    expect(
      applyLifecycle([prev], [raw({ severity: 'warning' })], later, CFG, { notifyMinSeverity: 'warning' })
        .notifications,
    ).toHaveLength(1);
    const info = row({ severity: 'info', maxSeverity: 'info', activeSince: T0 });
    expect(applyLifecycle([info], [raw({ severity: 'info' })], later, CFG).notifications).toEqual([]);
    expect(
      applyLifecycle([info], [raw({ severity: 'info' })], later, CFG, { notifyMinSeverity: 'info' }).notifications,
    ).toHaveLength(1);
  });

  it('announces an escalation over the severity that was announced last', () => {
    const prev = row({
      severity: 'warning',
      notifiedSeverity: 'warning',
      notifiedAt: T0 - MIN,
      notifiedEvidenceCount: 0,
    });
    const { notifications, next } = applyLifecycle([prev], [raw({ severity: 'critical' })], T0, CFG);
    expect(notifications).toMatchObject([{ kind: 'escalated', severity: 'critical' }]);
    expect(only(next).notifiedSeverity).toBe('critical');
    const again = applyLifecycle(
      [{ ...only(next), id: 1 } as Finding],
      [raw({ severity: 'critical' })],
      T0 + 10 * SEC,
      CFG,
    );
    expect(again.notifications).toEqual([]);
  });

  it('does not announce a drop in severity, nor the return to the announced severity', () => {
    const prev = row({ severity: 'critical', notifiedSeverity: 'critical', notifiedAt: T0 - MIN });
    expect(applyLifecycle([prev], [raw({ severity: 'warning' })], T0, CFG).notifications).toEqual([]);
  });

  describe('grew', () => {
    const announced = (count: number, at = T0 - 11 * MIN) =>
      row({ evidenceKeys: keys(count), notifiedSeverity: 'critical', notifiedAt: at, notifiedEvidenceCount: count });

    it('announces growth of the evidence, coalesced: only after 10 minutes (boundary) since the last notice', () => {
      const grown = raw({ evidenceKeys: keys(24) });
      const inside = applyLifecycle([announced(1, T0 - 10 * MIN)], [grown], T0, CFG);
      expect(inside.notifications).toEqual([]);
      const out = applyLifecycle([announced(1, T0 - 10 * MIN - 1)], [grown], T0, CFG);
      expect(out.notifications).toMatchObject([{ kind: 'grew', severity: 'critical' }]);
      expect(out.notifications[0]!.detail).toContain('24 affected (was 1)');
      expect(only(out.next)).toMatchObject({ notifiedEvidenceCount: 24, notifiedAt: T0 });
    });

    it('needs the count to reach 1.5 times the announced count (boundary)', () => {
      expect(applyLifecycle([announced(24)], [raw({ evidenceKeys: keys(25) })], T0, CFG).notifications).toEqual([]);
      expect(applyLifecycle([announced(24)], [raw({ evidenceKeys: keys(35) })], T0, CFG).notifications).toEqual([]);
      expect(applyLifecycle([announced(24)], [raw({ evidenceKeys: keys(36) })], T0, CFG).notifications).toHaveLength(1);
      expect(applyLifecycle([announced(1)], [raw({ evidenceKeys: keys(2) })], T0, CFG).notifications).toHaveLength(1);
    });

    it('announces first evidence on a finding that was announced without any', () => {
      expect(applyLifecycle([announced(0)], [raw({ evidenceKeys: keys(1) })], T0, CFG).notifications).toHaveLength(1);
    });

    it('does not announce when the evidence shrinks or stays', () => {
      expect(applyLifecycle([announced(10)], [raw({ evidenceKeys: keys(10) })], T0, CFG).notifications).toEqual([]);
      expect(applyLifecycle([announced(10)], [raw({ evidenceKeys: keys(3) })], T0, CFG).notifications).toEqual([]);
    });

    it('a row that was announced before growth tracking existed is treated as announced with 0 keys', () => {
      const legacy = row({ notifiedSeverity: 'critical', notifiedAt: T0 - 20 * MIN, notifiedEvidenceCount: null });
      expect(applyLifecycle([legacy], [raw({ evidenceKeys: keys(1) })], T0, CFG).notifications).toHaveLength(1);
    });

    it('treats a missing previous notice time as settled', () => {
      const noTime = row({
        notifiedSeverity: 'critical',
        notifiedAt: null,
        notifiedEvidenceCount: 1,
        evidenceKeys: keys(1),
      });
      expect(applyLifecycle([noTime], [raw({ evidenceKeys: keys(2) })], T0, CFG).notifications).toHaveLength(1);
    });
  });

  describe('resolved', () => {
    const resolved = (over: Partial<Finding> = {}) =>
      row({
        status: 'resolved',
        resolvedAt: T0 - 11 * MIN,
        clearedAt: T0 - 12 * MIN,
        notifiedSeverity: 'critical',
        notifiedAt: T0 - 60 * MIN,
        notifiedEvidenceCount: 0,
        ...over,
      });

    it('is not sent at the moment of resolution but 10 minutes after (boundary), exactly once', () => {
      const cleared = row({ clearedAt: T0 - 30_000, notifiedSeverity: 'critical', notifiedAt: T0 - 60 * MIN });
      const at = applyLifecycle([cleared], [], T0, CFG);
      expect(only(at.next).status).toBe('resolved');
      expect(at.notifications).toEqual([]);

      const stored = { ...only(at.next), id: 1 } as Finding;
      expect(applyLifecycle([stored], [], T0 + 10 * MIN - 1, CFG)).toMatchObject({ next: [], notifications: [] });
      const due = applyLifecycle([stored], [], T0 + 10 * MIN, CFG);
      expect(due.notifications).toMatchObject([
        { kind: 'resolved', findingId: 1, title: 'title', detail: 'title has cleared.' },
      ]);
      expect(only(due.next)).toMatchObject({
        status: 'resolved',
        notifiedSeverity: null,
        notifiedEvidenceCount: null,
        notifiedAt: T0 + 10 * MIN,
      });
      const after = applyLifecycle([{ ...only(due.next), id: 1 } as Finding], [], T0 + 11 * MIN, CFG);
      expect(after).toMatchObject({ next: [], notifications: [] });
    });

    it('is sent in the same pass when the delay is configured to 0', () => {
      const cfg = { ...CFG, resolvedNotifyDelayMs: 0 };
      const cleared = row({ clearedAt: T0 - 30_000, notifiedSeverity: 'critical', notifiedAt: T0 - 60 * MIN });
      expect(applyLifecycle([cleared], [], T0, cfg).notifications).toMatchObject([{ kind: 'resolved' }]);
    });

    it('is only for findings that were announced as critical', () => {
      expect(applyLifecycle([resolved({ notifiedSeverity: 'warning' })], [], T0, CFG).notifications).toEqual([]);
      expect(applyLifecycle([resolved({ notifiedSeverity: null })], [], T0, CFG).notifications).toEqual([]);
    });

    it('is not sent for silenced findings or for the notifier finding itself', () => {
      const silenced = { at: T0 - HOUR_MS, by: null, note: null, severity: 'critical' as Severity, evidenceCount: 0 };
      expect(applyLifecycle([resolved({ silenced })], [], T0, CFG).notifications).toEqual([]);
      expect(
        applyLifecycle([resolved({ rule: 'NOTIFIER_FAILING', fingerprint: 'NOTIFIER_FAILING' })], [], T0, CFG)
          .notifications,
      ).toEqual([]);
    });

    it('is not sent for an old resolved row when the finding is back as a new row', () => {
      const old = resolved({ resolvedAt: T0 - 40 * MIN });
      const { notifications, next } = applyLifecycle([old], [raw()], T0, CFG);
      expect(next.map((d) => d.id)).toEqual([null]);
      expect(notifications).toMatchObject([{ kind: 'opened' }]);
    });

    it('is cancelled by a reopen before it is due, which then stays silent', () => {
      const soon = resolved({ resolvedAt: T0 - 5 * MIN });
      const { notifications, next } = applyLifecycle([soon], [raw()], T0, CFG);
      expect(notifications).toEqual([]);
      expect(only(next)).toMatchObject({ status: 'active', flapCount: 1 });
    });
  });

  it('never announces the notifier failing finding', () => {
    const r = raw({ rule: 'NOTIFIER_FAILING', fingerprint: 'NOTIFIER_FAILING', severity: 'critical' });
    expect(applyLifecycle([], [r], T0, CFG).notifications).toEqual([]);
  });

  it('announces several findings in one pass in raw order', () => {
    const { notifications } = applyLifecycle([], [raw({ fingerprint: 'A' }), raw({ fingerprint: 'B' })], T0, CFG);
    expect(notifications.map((n) => n.fingerprint)).toEqual(['A', 'B']);
  });
});
