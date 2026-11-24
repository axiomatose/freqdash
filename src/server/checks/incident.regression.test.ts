// Flagship regression (docs/PLAN.md section 8.3): replays the 2026-09-28 votemax incident (a crash loop that placed 26
// ETH/USD buys the bot forgot) through evaluate + applyLifecycle and asserts that freqdash would have caught it, how
// fast, and without spamming or flapping. The scenario (poller model, data sources) is documented in
// test/fixtures/incident/scenario.ts.
import { describe, expect, it } from 'vitest';
import type { Finding } from '@/shared/types/findings';
import { runChecks, type Run } from '../../../test/fixtures/incident/harness';
import {
  LOG_TIMELINE,
  SYNTHETIC_ORPHAN_TXID,
  flappingInputs,
  incidentInputs,
} from '../../../test/fixtures/incident/scenario';

const at = (h: number, m: number, s = 0, ms = 0): number => Date.UTC(2026, 8, 28, h, m, s, ms);
const ACK_AT = at(6, 17, 0);

const FATAL = 'BOT_FATAL_LOG:votemax';
const LOOP = 'BOT_RESTART_LOOP:votemax';
const UNPERSISTED = 'UNPERSISTED_ORDER:votemax:ETH/USD';
const ORPHAN = 'ORPHAN_KRAKEN_ORDER:ETH/USD';
const STORM = 'ORDER_STORM:ETH/USD';
const UNTRACKED = 'UNTRACKED_HOLDING:ETH';

function finalRow(run: Run, fp: string): Finding {
  const rows = run.rowsFor(fp);
  expect(rows, fp).toHaveLength(1);
  return rows[0]!;
}

const ordersOf = (row: Finding) =>
  (row.evidence as { orders: { createdByBot?: string | null; orderId?: string; txid?: string }[] }).orders;

describe('Variant A: Kraken + logs + health', () => {
  const run = runChecks(incidentInputs({ withKraken: true, withLogs: true, ackAt: ACK_AT }));

  it('1. raises nothing at warning or critical before the first order (04:00:07.965)', () => {
    expect(run.activeBefore(at(4, 0, 7, 965), 'warning')).toEqual([]);
    // the real sample state is quiet at info level too, apart from the historical fee finding
    expect(run.activeBefore(at(4, 0, 7, 965), 'info').map((e) => e.fingerprint)).toEqual([
      'FEE_ANOMALY:votemax:3:sell',
    ]);
  });

  it('2. BOT_FATAL_LOG is critical by 04:00:15', () => {
    const t = run.firstActive(FATAL, 'critical');
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(at(4, 0, 8, 776) - 1000);
    expect(t!).toBeLessThanOrEqual(at(4, 0, 15));
  });

  it('3. BOT_RESTART_LOOP is critical by 04:00:50', () => {
    expect(run.firstActive(LOOP, 'critical')!).toBeLessThanOrEqual(at(4, 0, 50));
  });

  it('4. UNPERSISTED_ORDER is critical by 04:01:10, ends with 25 orders, and lives in exactly one row', () => {
    expect(run.firstActive(UNPERSISTED, 'critical')!).toBeLessThanOrEqual(at(4, 1, 10));
    const row = finalRow(run, UNPERSISTED);
    expect(row.evidenceKeys).toHaveLength(25);
    expect(new Set(row.evidenceKeys)).toEqual(
      new Set(LOG_TIMELINE.filter((e) => e.type === 'order_created').map((e) => e.orderId)),
    );
    expect(row.subject).toEqual({ botId: 'votemax', pair: 'ETH/USD' });
    expect(row.flapCount).toBe(0);
  });

  it('5. ORPHAN_KRAKEN_ORDER is critical by 04:01:15 and ends with 26 orders, 25 of them created by votemax', () => {
    expect(run.firstActive(ORPHAN, 'critical')!).toBeLessThanOrEqual(at(4, 1, 15));
    const row = finalRow(run, ORPHAN);
    expect(row.evidenceKeys).toHaveLength(26);
    expect(row.evidenceKeys).toContain(SYNTHETIC_ORPHAN_TXID);
    const orders = ordersOf(row);
    expect(orders).toHaveLength(26);
    expect(orders.filter((o) => o.createdByBot === 'votemax')).toHaveLength(25);
    expect(orders.find((o) => o.txid === SYNTHETIC_ORPHAN_TXID)!.createdByBot).toBeNull();
  });

  it('6. ORDER_STORM is critical by 04:01:45', () => {
    expect(run.firstActive(STORM, 'critical')!).toBeLessThanOrEqual(at(4, 1, 45));
  });

  it('7. UNTRACKED_HOLDING:ETH is critical by 04:03:30 (Kraken source)', () => {
    expect(run.firstActive(UNTRACKED, 'critical')!).toBeLessThanOrEqual(at(4, 3, 30));
    expect(finalRow(run, UNTRACKED).evidence).toMatchObject({ source: 'kraken', tradedByBot: true });
  });

  it('only the incident findings reach warning or critical: no false positives on SHIB, BABY, ETH dust, fees or wallets', () => {
    const loud = new Set(run.log.filter((e) => e.severity !== 'info').map((e) => e.fingerprint));
    const expected = [FATAL, LOOP, UNPERSISTED, ORPHAN, STORM, UNTRACKED];
    for (const fp of expected) expect(loud.has(fp), fp).toBe(true);
    const extras = [...loud].filter((fp) => !expected.includes(fp));
    expect(extras.map((fp) => fp.replace(/:[0-9a-f]{8}$/, ':<sig>'))).toEqual(['BOT_ERROR_LOG:votemax:<sig>']);
  });

  it('8. sends at most 12 notifications, at most 3 per fingerprint, none at info level', () => {
    const n = run.notifications;
    expect(n.length).toBeLessThanOrEqual(12);
    expect(n.length).toBeGreaterThanOrEqual(7);
    const per = new Map<string, number>();
    for (const x of n) per.set(x.fingerprint, (per.get(x.fingerprint) ?? 0) + 1);
    for (const [fp, count] of per) expect(count, fp).toBeLessThanOrEqual(3);
    expect(n.filter((x) => x.severity === 'info')).toEqual([]);
    // every critical finding was announced when it first turned critical
    for (const fp of [FATAL, LOOP, UNPERSISTED, ORPHAN, STORM, UNTRACKED]) {
      const opened = n.find((x) => x.fingerprint === fp && x.kind === 'opened');
      expect(opened, fp).toBeDefined();
      expect(opened!.at).toBe(run.firstActive(fp, 'critical'));
    }
  });

  it('9. clears what stops and keeps what does not: sticky findings stay until the operator acknowledges them', () => {
    expect(run.stateAt(LOOP, at(5, 31))!.status).toBe('resolved');
    expect(run.stateAt(FATAL, at(6, 16))!.status).toBe('resolved');
    for (const fp of [UNPERSISTED, ORPHAN, UNTRACKED]) {
      expect(run.stateAt(fp, at(6, 16))!.status, fp).toBe('active');
      expect(run.stateAt(fp, ACK_AT - 5000)!.status, fp).toBe('active');
    }
  });

  it('9. after acknowledging all 26 txids and the ETH holding, all three resolve within 90 s', () => {
    for (const fp of [UNPERSISTED, ORPHAN, UNTRACKED]) {
      expect(run.stateAt(fp, ACK_AT + 90_000)!.status, fp).toBe('resolved');
      expect(finalRow(run, fp).resolvedAt!, fp).toBeGreaterThan(ACK_AT);
      expect(finalRow(run, fp).resolvedAt!, fp).toBeLessThanOrEqual(ACK_AT + 90_000);
    }
  });

  it('does not flap: the crash-loop findings reopen at most once and the sticky ones never', () => {
    expect(finalRow(run, LOOP).flapCount).toBe(0);
    expect(finalRow(run, STORM).flapCount).toBe(0);
    expect(finalRow(run, FATAL).flapCount).toBeLessThanOrEqual(1);
    for (const fp of [UNPERSISTED, ORPHAN, UNTRACKED]) expect(finalRow(run, fp).flapCount).toBe(0);
  });

  it('the late crash at 05:14 reopens the fatal finding silently instead of announcing a resolve-and-reopen', () => {
    const fatalNotices = run.notifications.filter((x) => x.fingerprint === FATAL);
    expect(fatalNotices.map((x) => x.kind)).toEqual(['opened']);
    expect(run.stateAt(FATAL, at(5, 14, 20))).toMatchObject({ status: 'active', flapCount: 1 });
  });

  it('announces growth once, when the first announcement undercounted (1 order -> 24)', () => {
    const grew = run.notifications.filter((x) => x.kind === 'grew');
    expect(grew.map((x) => x.fingerprint).sort()).toEqual([ORPHAN, UNPERSISTED]);
    expect(grew[0]!.detail).toMatch(/\d+ affected \(was 1\)/);
  });

  it('the delayed all-clear notices go out 10 minutes after resolution', () => {
    const extended = runChecks(incidentInputs({ withKraken: true, withLogs: true, ackAt: ACK_AT, endAt: at(6, 40) }));
    const resolved = extended.notifications.filter((x) => x.kind === 'resolved');
    const fps = resolved.map((x) => x.fingerprint);
    for (const fp of [LOOP, FATAL, UNPERSISTED, ORPHAN, UNTRACKED]) expect(fps, fp).toContain(fp);
    for (const x of resolved) {
      const row = extended.rowsFor(x.fingerprint)[0]!;
      expect(x.at, x.fingerprint).toBeGreaterThanOrEqual(row.resolvedAt! + 10 * 60_000);
    }
    expect(fps.filter((f) => f === FATAL)).toHaveLength(1);
  });
});

describe('Variant B: freqtrade-only (logs + health, no Kraken)', () => {
  const run = runChecks(incidentInputs({ withKraken: false, withLogs: true, ackAt: ACK_AT }));

  it('2. BOT_FATAL_LOG is critical by 04:00:15', () => {
    expect(run.firstActive(FATAL, 'critical')!).toBeLessThanOrEqual(at(4, 0, 15));
  });

  it('3. BOT_RESTART_LOOP is critical by 04:00:50', () => {
    expect(run.firstActive(LOOP, 'critical')!).toBeLessThanOrEqual(at(4, 0, 50));
  });

  it('4. UNPERSISTED_ORDER is critical by 04:01:10, ends with 25 orders, in one row', () => {
    expect(run.firstActive(UNPERSISTED, 'critical')!).toBeLessThanOrEqual(at(4, 1, 10));
    expect(finalRow(run, UNPERSISTED).evidenceKeys).toHaveLength(25);
  });

  it('6. ORDER_STORM is critical by 04:01:45', () => {
    expect(run.firstActive(STORM, 'critical')!).toBeLessThanOrEqual(at(4, 1, 45));
  });

  it('no Kraken rule fires', () => {
    for (const rule of [
      'ORPHAN_KRAKEN_ORDER',
      'BOT_ORDER_MISSING_ON_KRAKEN',
      'ORDER_MISMATCH',
      'KRAKEN_ERROR',
      'BOT_OVERCLAIMS_HOLDING',
    ]) {
      expect(
        [...run.rawFingerprints].filter((fp) => fp.startsWith(rule)),
        rule,
      ).toEqual([]);
    }
  });

  it('UNTRACKED_HOLDING:ETH comes from a bot wallet and never rises above warning', () => {
    const row = finalRow(run, UNTRACKED);
    expect(row.evidence).toMatchObject({ source: 'bot-wallet' });
    const severities = new Set(run.log.filter((e) => e.fingerprint === UNTRACKED).map((e) => e.severity));
    expect(severities).toEqual(new Set(['warning']));
    expect(run.firstActive(UNTRACKED, 'warning')!).toBeLessThanOrEqual(at(4, 5));
  });

  it('the logged orders are all the bot-side evidence there is, and acknowledging them resolves the findings', () => {
    for (const fp of [UNPERSISTED, UNTRACKED]) expect(run.stateAt(fp, ACK_AT + 90_000)!.status, fp).toBe('resolved');
  });

  it('is quiet before the first order', () => {
    expect(run.activeBefore(at(4, 0, 7, 965), 'warning')).toEqual([]);
  });
});

describe('Variant C: health only (no logs, no Kraken)', () => {
  const run = runChecks(incidentInputs({ withKraken: false, withLogs: false }));

  it('BOT_RESTART_LOOP is critical by 04:01:10 from health-detected restarts', () => {
    expect(run.firstActive(LOOP, 'critical')!).toBeLessThanOrEqual(at(4, 1, 10));
  });

  it('BOT_UNREACHABLE never fires: every outage is shorter than 30 s', () => {
    expect([...run.rawFingerprints].filter((fp) => fp.startsWith('BOT_UNREACHABLE'))).toEqual([]);
  });

  it('log-based rules stay silent without logs', () => {
    for (const rule of ['BOT_FATAL_LOG', 'UNPERSISTED_ORDER', 'BOT_ERROR_LOG']) {
      expect(
        [...run.rawFingerprints].filter((fp) => fp.startsWith(rule)),
        rule,
      ).toEqual([]);
    }
  });
});

describe('Variant D: flapping health', () => {
  it('health alternating every 10 s for 10 minutes produces no BOT_UNREACHABLE', () => {
    const run = runChecks(flappingInputs('alternating'));
    expect([...run.rawFingerprints].filter((fp) => fp.startsWith('BOT_UNREACHABLE'))).toEqual([]);
    expect(run.log).toEqual([]);
  });

  it('six 45 s outages five minutes apart produce one row with flapCount >= 2 and at most 2 notifications', () => {
    const run = runChecks(flappingInputs('outages'));
    const rows = run.rowsFor('BOT_UNREACHABLE:votemax');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flapCount).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.flapCount).toBe(5);
    expect(rows[0]!.occurrences).toBe(6);
    expect(run.notifications.length).toBeLessThanOrEqual(2);
    expect([...run.rawFingerprints]).toEqual(['BOT_UNREACHABLE:votemax']);
  });
});

describe('Variant E: Kraken without logs (what the incident looks like with no log mount)', () => {
  const run = runChecks(incidentInputs({ withKraken: true, withLogs: false, ackAt: ACK_AT }));

  it('still catches all 26 orders as orphans, none attributed to a bot, and the untracked ETH', () => {
    expect(run.firstActive(ORPHAN, 'critical')!).toBeLessThanOrEqual(at(4, 1, 15));
    const row = finalRow(run, ORPHAN);
    expect(row.evidenceKeys).toHaveLength(26);
    expect(ordersOf(row).filter((o) => o.createdByBot !== null)).toEqual([]);
    expect(run.firstActive(UNTRACKED, 'critical')!).toBeLessThanOrEqual(at(4, 3, 30));
    // Kraken only sees an order once the 15 s / 30 s polls have, so the storm is 15 s slower than with the logs
    expect(run.firstActive(STORM, 'critical')!).toBeLessThanOrEqual(at(4, 2, 30));
  });

  it('does not raise the log-based findings and resolves after the acknowledgements', () => {
    expect([...run.rawFingerprints].some((fp) => fp.startsWith('UNPERSISTED_ORDER'))).toBe(false);
    expect(run.stateAt(ORPHAN, ACK_AT + 90_000)!.status).toBe('resolved');
  });
});
