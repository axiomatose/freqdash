import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '@/shared/types/findings';
import { installTempDb, type TempDb } from '../testing';
import {
  getFinding,
  listFindings,
  pruneResolvedFindings,
  RESOLVED_FINDING_RETENTION_MS,
  saveLifecycle,
  silence,
  unsilence,
  type FindingDraft,
} from './findings';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const T = 1_790_568_000_000;

function draft(fingerprint: string, over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    id: null,
    rule: 'ORDER_STORM',
    fingerprint,
    severity: 'warning',
    maxSeverity: 'warning',
    status: 'active',
    title: `Order storm ${fingerprint}`,
    detail: 'detail',
    subject: { pair: 'ETH/USD' },
    evidence: { count: 4 },
    evidenceKeys: ['O1', 'O2', 'O3', 'O4'],
    minDurationMs: 0,
    clearAfterMs: 30_000,
    firstSeenAt: T,
    episodeStartAt: T,
    activeSince: T,
    lastSeenAt: T,
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

/** Save one draft and return the stored finding. */
function save(d: FindingDraft): Finding {
  const { ids } = saveLifecycle([d]);
  return getFinding(ids[0] as number) as Finding;
}

const openCount = (): number =>
  (temp.db.prepare("SELECT COUNT(*) AS n FROM findings WHERE status IN ('pending','active')").get() as { n: number }).n;

describe('saveLifecycle', () => {
  it('inserts new drafts and returns their ids in input order plus a fingerprint index', () => {
    const result = saveLifecycle([draft(':a'), draft(':b', { status: 'pending', activeSince: null })]);

    expect(result.ids).toHaveLength(2);
    expect(new Set(result.ids).size).toBe(2);
    expect(result.newIds).toEqual({ ':a': result.ids[0], ':b': result.ids[1] });
    expect(getFinding(result.ids[1] as number)).toMatchObject({
      fingerprint: ':b',
      status: 'pending',
      activeSince: null,
    });
  });

  it('returns an empty result for no drafts', () => {
    expect(saveLifecycle([])).toEqual({ ids: [], newIds: {} });
  });

  it('round-trips every field of a fully populated draft', () => {
    const full = draft(':full', {
      rule: 'UNPERSISTED_ORDER',
      severity: 'critical',
      maxSeverity: 'critical',
      subject: { botId: 'votemax', pair: 'ETH/USD', asset: 'ETH', orderId: 'OX', tradeId: 3, kind: 'k' },
      evidence: { orders: [{ orderId: 'OX', at: T, price: 2600.5 }], count: 1, nested: { a: [1, 2] } },
      evidenceKeys: ['OX'],
      minDurationMs: 90_000,
      clearAfterMs: 60_000,
      escalateAfterMs: 4_500_000,
      escalateTo: 'critical',
      firstSeenAt: T - 5000,
      episodeStartAt: T - 1000,
      activeSince: T,
      lastSeenAt: T + 10_000,
      clearedAt: T + 5000,
      occurrences: 3,
      flapCount: 2,
      silenced: { at: T + 1, by: 'me', note: 'known', severity: 'warning', evidenceCount: 1 },
      notifiedAt: T + 2,
      notifiedSeverity: 'critical',
      notifiedEvidenceCount: 1,
    });

    const stored = save(full);

    const { id: _draftId, ...expected } = full;
    expect(stored).toEqual({ ...expected, id: stored.id });
  });

  it('applies the schema defaults for the optional RawFinding fields', () => {
    const minimal = draft(':min');
    delete minimal.evidenceKeys;
    delete minimal.minDurationMs;
    delete minimal.clearAfterMs;

    const stored = save(minimal);

    expect(stored).toMatchObject({ evidenceKeys: [], minDurationMs: 0, clearAfterMs: 30_000 });
    expect(stored).not.toHaveProperty('escalateAfterMs');
    expect(stored).not.toHaveProperty('escalateTo');
  });

  it('updates existing rows in place and echoes their ids', () => {
    const first = save(draft(':a'));
    const updated: FindingDraft = {
      ...first,
      severity: 'critical',
      maxSeverity: 'critical',
      title: 'Escalated',
      evidence: { count: 6 },
      evidenceKeys: ['O1', 'O2', 'O3', 'O4', 'O5', 'O6'],
      lastSeenAt: T + 10_000,
      occurrences: 2,
      notifiedAt: T + 10_000,
      notifiedSeverity: 'critical',
      notifiedEvidenceCount: 6,
    };

    const result = saveLifecycle([updated]);

    expect(result).toEqual({ ids: [first.id], newIds: {} });
    expect(getFinding(first.id)).toEqual({ ...updated, id: first.id });
    expect(listFindings()).toHaveLength(1);
  });

  it('resolving a row and later reopening it (flap) keeps the same id', () => {
    const first = save(draft(':a'));
    saveLifecycle([{ ...first, status: 'resolved', clearedAt: T + 1, resolvedAt: T + 31_000 }]);
    expect(getFinding(first.id)).toMatchObject({ status: 'resolved', resolvedAt: T + 31_000 });

    saveLifecycle([
      {
        ...(getFinding(first.id) as Finding),
        status: 'active',
        clearedAt: null,
        resolvedAt: null,
        flapCount: 1,
        occurrences: 2,
        episodeStartAt: T + 60_000,
      },
    ]);
    expect(getFinding(first.id)).toMatchObject({ status: 'active', flapCount: 1, occurrences: 2, resolvedAt: null });
  });

  it('lets a batch resolve a row and open a new row with the same fingerprint, in any order', () => {
    const old = save(draft(':a'));
    const resolved: FindingDraft = { ...old, status: 'resolved', clearedAt: T + 1, resolvedAt: T + 2 };

    const result = saveLifecycle([draft(':a', { firstSeenAt: T + 3 }), resolved]);

    expect(result.ids[1]).toBe(old.id);
    expect(result.ids[0]).not.toBe(old.id);
    expect(result.newIds[':a']).toBe(result.ids[0]);
    expect(getFinding(old.id)?.status).toBe('resolved');
    expect(listFindings({ status: 'active' })).toHaveLength(1);
  });

  it('enforces one open finding per fingerprint', () => {
    save(draft(':a'));
    expect(() => saveLifecycle([draft(':a')])).toThrow(/UNIQUE/);
    expect(() => saveLifecycle([draft(':a', { status: 'pending', activeSince: null })])).toThrow(/UNIQUE/);
    expect(openCount()).toBe(1);
  });

  it('allows many resolved rows with one fingerprint', () => {
    saveLifecycle([
      draft(':a', { status: 'resolved', resolvedAt: T }),
      draft(':a', { status: 'resolved', resolvedAt: T + 1 }),
    ]);
    expect(listFindings({ fingerprint: ':a' })).toHaveLength(2);
  });

  it('is atomic: a failure part-way leaves no partial write (constraint violation)', () => {
    const existing = save(draft(':existing'));
    const before = listFindings();

    // update (valid) + insert (valid) + insert that violates ux_findings_open
    expect(() =>
      saveLifecycle([{ ...existing, title: 'changed', severity: 'critical' }, draft(':new'), draft(':new')]),
    ).toThrow(/UNIQUE/);

    expect(listFindings()).toEqual(before);
    expect(getFinding(existing.id)?.title).toBe(existing.title);
    expect(listFindings({ fingerprint: ':new' })).toEqual([]);
  });

  it('is atomic when a later draft references a row that does not exist', () => {
    const existing = save(draft(':existing'));
    expect(() =>
      saveLifecycle([draft(':new'), { ...existing, title: 'changed' }, draft(':ghost', { id: 9999 })]),
    ).toThrow(/9999 does not exist/);
    expect(listFindings().map((f) => f.fingerprint)).toEqual([':existing']);
    expect(getFinding(existing.id)?.title).toBe(existing.title);
  });

  it('is atomic when a draft cannot be serialized or violates a CHECK', () => {
    save(draft(':existing'));
    const unserializable = draft(':big', { evidence: { n: 10n as unknown as number } });
    expect(() => saveLifecycle([draft(':ok'), unserializable])).toThrow();
    expect(() => saveLifecycle([draft(':ok2'), draft(':bad', { status: 'weird' as never })])).toThrow(/CHECK/);
    expect(listFindings().map((f) => f.fingerprint)).toEqual([':existing']);
  });

  it('leaves rows that the drafts do not mention untouched', () => {
    const a = save(draft(':a'));
    save(draft(':b'));
    saveLifecycle([{ ...a, title: 'only a' }]);
    expect(
      listFindings()
        .map((f) => f.title)
        .sort(),
    ).toEqual(['Order storm :b', 'only a']);
  });
});

describe('listFindings / getFinding', () => {
  beforeEach(() => {
    saveLifecycle([
      draft(':info', { severity: 'info', maxSeverity: 'info', lastSeenAt: T + 1 }),
      draft(':warn-old', { lastSeenAt: T + 2 }),
      draft(':warn-new', { lastSeenAt: T + 9 }),
      draft(':crit', { severity: 'critical', maxSeverity: 'critical', lastSeenAt: T }),
      draft(':pending', { status: 'pending', activeSince: null }),
      draft(':res-old', { status: 'resolved', resolvedAt: T + 100, lastSeenAt: T }),
      draft(':res-new', { status: 'resolved', resolvedAt: T + 500, lastSeenAt: T }),
      draft(':silenced', {
        silenced: { at: T, by: null, note: null, severity: 'warning', evidenceCount: 4 },
        lastSeenAt: T + 3,
      }),
    ]);
  });

  const fps = (findings: Finding[]): string[] => findings.map((f) => f.fingerprint);

  it('orders open findings by severity then recency, with resolved ones last', () => {
    expect(fps(listFindings())).toEqual([
      ':crit',
      ':warn-new',
      ':silenced',
      ':warn-old',
      ':pending',
      ':info',
      ':res-new',
      ':res-old',
    ]);
  });

  it('a resolved-only list is newest-resolved first', () => {
    expect(fps(listFindings({ status: 'resolved' }))).toEqual([':res-new', ':res-old']);
  });

  it('filters by status (single or several) and severity', () => {
    expect(fps(listFindings({ status: 'pending' }))).toEqual([':pending']);
    expect(fps(listFindings({ status: ['pending', 'active'], severity: 'critical' }))).toEqual([':crit']);
    expect(fps(listFindings({ status: 'active', severity: ['info', 'critical'] }))).toEqual([':crit', ':info']);
    expect(listFindings({ status: [] })).toEqual([]);
    expect(listFindings({ severity: [] })).toEqual([]);
  });

  it('filters silenced / not silenced', () => {
    expect(fps(listFindings({ status: 'active', silenced: true }))).toEqual([':silenced']);
    expect(fps(listFindings({ status: 'active', silenced: false }))).toEqual([
      ':crit',
      ':warn-new',
      ':warn-old',
      ':info',
    ]);
  });

  it('filters by fingerprint and resolvedSince (inclusive, resolved rows only)', () => {
    expect(fps(listFindings({ fingerprint: ':crit' }))).toEqual([':crit']);
    expect(fps(listFindings({ resolvedSince: T + 500 }))).toEqual([':res-new']);
    expect(fps(listFindings({ resolvedSince: T }))).toEqual([':res-new', ':res-old']);
  });

  it('applies limit after ordering', () => {
    expect(fps(listFindings({ limit: 2 }))).toEqual([':crit', ':warn-new']);
  });

  it('getFinding returns null for an unknown id', () => {
    expect(getFinding(123456)).toBeNull();
  });

  it('tolerates corrupt JSON cells', () => {
    temp.db
      .prepare("UPDATE findings SET subject_json = '{bad', evidence_json = 'nope', evidence_keys_json = '['")
      .run();
    const [first] = listFindings({ limit: 1 });
    expect(first).toMatchObject({ subject: {}, evidence: {}, evidenceKeys: [] });
  });
});

describe('silence / unsilence', () => {
  it('records the severity and evidence count at the moment of silencing', () => {
    const f = save(draft(':a', { severity: 'critical', evidenceKeys: ['a', 'b', 'c'] }));

    const silenced = silence(f.id, { by: 'owner', note: 'known issue' }, T + 5000);

    expect(silenced?.silenced).toEqual({
      at: T + 5000,
      by: 'owner',
      note: 'known issue',
      severity: 'critical',
      evidenceCount: 3,
    });
    expect(getFinding(f.id)?.silenced).toEqual(silenced?.silenced);
  });

  it('defaults by/note to null and refreshes the baseline when silenced again', () => {
    const f = save(draft(':a', { evidenceKeys: ['a'] }));
    silence(f.id, {}, T + 1);
    expect(getFinding(f.id)?.silenced).toEqual({
      at: T + 1,
      by: null,
      note: null,
      severity: 'warning',
      evidenceCount: 1,
    });

    saveLifecycle([{ ...(getFinding(f.id) as Finding), severity: 'critical', evidenceKeys: ['a', 'b'] }]);
    silence(f.id, { by: 'x' }, T + 2);
    expect(getFinding(f.id)?.silenced).toMatchObject({ at: T + 2, severity: 'critical', evidenceCount: 2 });
  });

  it('unsilence clears the silence and returns the finding', () => {
    const f = save(draft(':a'));
    silence(f.id, { by: 'x', note: 'n' }, T);
    expect(unsilence(f.id)).toMatchObject({ id: f.id, silenced: null });
    expect(getFinding(f.id)?.silenced).toBeNull();
    expect(unsilence(f.id)?.silenced).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(silence(4242, {}, T)).toBeNull();
    expect(unsilence(4242)).toBeNull();
  });

  it('does not silence a resolved finding', () => {
    const f = save(draft(':a', { status: 'resolved', resolvedAt: T }));
    expect(silence(f.id, {}, T)).toMatchObject({ id: f.id, silenced: null });
    expect(getFinding(f.id)?.silenced).toBeNull();
  });

  it('a lifecycle draft with silenced: null lifts a silence (auto-lift on escalation)', () => {
    const f = save(draft(':a'));
    silence(f.id, {}, T);
    saveLifecycle([{ ...(getFinding(f.id) as Finding), severity: 'critical', silenced: null }]);
    expect(getFinding(f.id)).toMatchObject({ severity: 'critical', silenced: null });
  });
});

describe('pruneResolvedFindings', () => {
  it('deletes resolved findings older than 90 days and nothing else', () => {
    const NOW = T + 200 * 24 * 60 * 60 * 1000;
    saveLifecycle([
      draft(':old-resolved', { status: 'resolved', resolvedAt: NOW - RESOLVED_FINDING_RETENTION_MS - 1 }),
      draft(':edge-resolved', { status: 'resolved', resolvedAt: NOW - RESOLVED_FINDING_RETENTION_MS }),
      draft(':recent-resolved', { status: 'resolved', resolvedAt: NOW - 1000 }),
      draft(':open-but-ancient', { firstSeenAt: T, lastSeenAt: T, activeSince: T }),
      draft(':pending-ancient', { status: 'pending', activeSince: null, firstSeenAt: T, lastSeenAt: T }),
    ]);

    expect(pruneResolvedFindings(NOW)).toBe(1);
    expect(
      listFindings()
        .map((f) => f.fingerprint)
        .sort(),
    ).toEqual([':edge-resolved', ':open-but-ancient', ':pending-ancient', ':recent-resolved'].sort());
  });
});
