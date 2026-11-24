import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '../client';
import { installTempDb, type TempDb } from '../testing';
import { createAcks, listAcks, revokeAck } from './acks';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const NOW = 1_790_568_000_000;
const subjects = (acks: { subject: string }[]): string[] => acks.map((a) => a.subject);

describe('createAcks', () => {
  it('creates one ack per subject in a single call and returns them in subject order', () => {
    const created = createAcks(
      {
        kind: 'kraken_order',
        subjects: ['OAAAAA', 'OBBBBB', 'OCCCCC'],
        label: 'manual',
        note: 'placed by hand',
        qtyBaseline: null,
        expiresAt: null,
        createdBy: 'owner',
      },
      NOW,
    );

    expect(subjects(created)).toEqual(['OAAAAA', 'OBBBBB', 'OCCCCC']);
    expect(created[0]).toEqual({
      id: created[0]?.id,
      kind: 'kraken_order',
      subject: 'OAAAAA',
      label: 'manual',
      note: 'placed by hand',
      qtyBaseline: null,
      createdAt: NOW,
      createdBy: 'owner',
      expiresAt: null,
      revokedAt: null,
    });
    expect(new Set(created.map((a) => a.id)).size).toBe(3);
  });

  it('stores the baseline and expiry, and defaults optional fields to null', () => {
    const [ack] = createAcks(
      { kind: 'asset', subjects: ['SHIB'], label: 'ignored', qtyBaseline: 1234.5, expiresAt: NOW + 1000 },
      NOW,
    );
    expect(ack).toMatchObject({ qtyBaseline: 1234.5, expiresAt: NOW + 1000, note: null, createdBy: null });
  });

  it('dedupes and trims subjects, and rejects empty ones', () => {
    expect(subjects(createAcks({ kind: 'asset', subjects: ['ETH', ' ETH ', 'BTC'], label: 'manual' }, NOW))).toEqual([
      'ETH',
      'BTC',
    ]);
    expect(() => createAcks({ kind: 'asset', subjects: ['XRP', '  '], label: 'manual' }, NOW)).toThrow(/empty/);
    expect(subjects(listAcks(NOW))).not.toContain('XRP');
    expect(createAcks({ kind: 'asset', subjects: [], label: 'manual' }, NOW)).toEqual([]);
  });

  it('clips very long notes', () => {
    const [ack] = createAcks(
      { kind: 'asset', subjects: ['ETH'], label: 'manual', note: 'n'.repeat(MAX_TEXT_LENGTH + 5) },
      NOW,
    );
    expect(ack?.note).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('replaces the existing active ack of the same subject in the same transaction', () => {
    const [first] = createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual', qtyBaseline: 0.1 }, NOW);
    const [second] = createAcks(
      { kind: 'asset', subjects: ['ETH', 'BTC'], label: 'ignored', qtyBaseline: 0.2, createdBy: 'me' },
      NOW + 1000,
    );

    const active = listAcks(NOW + 1000);
    expect(subjects(active).sort()).toEqual(['BTC', 'ETH']);
    expect(active.find((a) => a.subject === 'ETH')).toMatchObject({
      id: second?.id,
      qtyBaseline: 0.2,
      label: 'ignored',
    });

    const old = temp.db.prepare('SELECT revoked_at, revoked_by FROM acknowledgements WHERE id = ?').get(first?.id) as {
      revoked_at: number;
      revoked_by: string | null;
    };
    expect(old).toEqual({ revoked_at: NOW + 1000, revoked_by: 'me' });
  });

  it('keeps kinds separate: the same subject can be acked as an asset and as an order', () => {
    createAcks({ kind: 'asset', subjects: ['X1'], label: 'manual' }, NOW);
    createAcks({ kind: 'kraken_order', subjects: ['X1'], label: 'manual' }, NOW);
    expect(listAcks(NOW)).toHaveLength(2);
  });

  it('replaces an expired-but-unrevoked ack (it still occupies the unique slot)', () => {
    createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual', expiresAt: NOW + 10 }, NOW);
    expect(listAcks(NOW + 100)).toEqual([]);

    expect(() => createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW + 100)).not.toThrow();
    expect(listAcks(NOW + 100)).toHaveLength(1);
  });

  it('is atomic: a bad ack in the batch rolls back the revocation of an existing one', () => {
    createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);
    // Second subject is fine, the label is invalid so the INSERT of the first subject fails after its revoke ran.
    expect(() => createAcks({ kind: 'asset', subjects: ['ETH', 'BTC'], label: 'bogus' as never }, NOW + 1)).toThrow(
      /CHECK/,
    );
    const active = listAcks(NOW + 1);
    expect(subjects(active)).toEqual(['ETH']);
    expect(active[0]?.revokedAt).toBeNull();
  });
});

describe('listAcks', () => {
  beforeEach(() => {
    createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);
    createAcks({ kind: 'kraken_order', subjects: ['OAAAAA'], label: 'manual', expiresAt: NOW + 500 }, NOW + 1);
    createAcks({ kind: 'asset', subjects: ['SHIB'], label: 'ignored' }, NOW + 2);
    const [revoked] = createAcks({ kind: 'asset', subjects: ['DOGE'], label: 'manual' }, NOW + 3);
    revokeAck(revoked?.id as number, null, NOW + 4);
  });

  it('lists active acks only by default, newest first', () => {
    expect(subjects(listAcks(NOW + 10))).toEqual(['SHIB', 'OAAAAA', 'ETH']);
  });

  it('drops an ack once it has expired', () => {
    expect(subjects(listAcks(NOW + 499))).toContain('OAAAAA');
    expect(subjects(listAcks(NOW + 500))).not.toContain('OAAAAA');
  });

  it('includeInactive adds revoked and expired acks', () => {
    expect(subjects(listAcks(NOW + 1000, { includeInactive: true }))).toEqual(['DOGE', 'SHIB', 'OAAAAA', 'ETH']);
    const doge = listAcks(NOW + 1000, { includeInactive: true }).find((a) => a.subject === 'DOGE');
    expect(doge?.revokedAt).toBe(NOW + 4);
  });

  it('filters by kind', () => {
    expect(subjects(listAcks(NOW + 10, { kind: 'kraken_order' }))).toEqual(['OAAAAA']);
    expect(subjects(listAcks(NOW + 10, { kind: 'asset' }))).toEqual(['SHIB', 'ETH']);
  });
});

describe('revokeAck', () => {
  it('revokes an active ack, records who and when, and frees the subject', () => {
    const [ack] = createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);

    expect(revokeAck(ack?.id as number, 'owner', NOW + 5)).toBe(true);

    expect(listAcks(NOW + 6)).toEqual([]);
    expect(temp.db.prepare('SELECT revoked_at, revoked_by FROM acknowledgements').get()).toEqual({
      revoked_at: NOW + 5,
      revoked_by: 'owner',
    });
    expect(() => createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW + 6)).not.toThrow();
  });

  it('returns false for an unknown or already revoked ack and keeps the first revocation', () => {
    const [ack] = createAcks({ kind: 'asset', subjects: ['ETH'], label: 'manual' }, NOW);
    expect(revokeAck(999, null, NOW)).toBe(false);
    expect(revokeAck(ack?.id as number, 'a', NOW + 1)).toBe(true);
    expect(revokeAck(ack?.id as number, 'b', NOW + 2)).toBe(false);
    expect(temp.db.prepare('SELECT revoked_at, revoked_by FROM acknowledgements').get()).toEqual({
      revoked_at: NOW + 1,
      revoked_by: 'a',
    });
  });
});
