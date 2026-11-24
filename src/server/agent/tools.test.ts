import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../db/client';
import { addMemory, listAcks, saveLifecycle } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { NOW, seededContext } from '../views/testing';
import { MAX_RESULT_CHARS, TOOLS, TOOL_BY_NAME, serializeResult, toolSpecs, type ToolContext } from './tools';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => {
  temp.cleanup();
  closeDb();
});

const ctx = (): ToolContext => ({ view: () => seededContext(), now: () => NOW, conversationId: null, by: 'Ada' });
const run = async (name: string, args: unknown = {}) => {
  const tool = TOOL_BY_NAME.get(name)!;
  const parsed = (tool.params as import('zod').ZodType).parse(args);
  return tool.run(parsed as never, ctx());
};

describe('tool registry', () => {
  it('has unique names and valid JSON-schema parameters for every tool', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const spec of toolSpecs()) {
      expect(spec.function.name).toMatch(/^[a-z_]+$/);
      expect(spec.function.description.length).toBeGreaterThan(10);
      expect(spec.function.parameters).toMatchObject({ type: 'object' });
      expect(spec.function.parameters).not.toHaveProperty('$schema');
    }
  });

  it('classifies risk: reads are free, actions ask, only memories are always allowed, the killswitch is danger', () => {
    const risk = Object.fromEntries(TOOLS.map((t) => [t.name, t.risk]));
    expect(risk.reset_killswitch).toBe('danger');
    for (const n of ['silence_finding', 'unsilence_finding', 'create_acks', 'revoke_ack', 'send_test_notification'])
      expect(risk[n]).toBe('write');
    for (const n of [
      'get_summary',
      'get_overview',
      'get_bot',
      'list_trades',
      'list_findings',
      'get_strategies',
      'get_chart',
      'recall_memories',
    ])
      expect(risk[n]).toBe('read');
    expect(
      TOOLS.filter((t) => t.alwaysAllowed)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['delete_memory', 'save_memory']);
    expect(
      TOOLS.filter((t) => t.risk !== 'read').every(
        (t) => t.summarize !== undefined || t.name === 'send_test_notification',
      ),
    ).toBe(true);
  });

  it('validates arguments strictly (bad ids, oversized limits)', () => {
    const bot = TOOL_BY_NAME.get('get_bot')!.params;
    expect(bot.safeParse({ botId: '../etc' }).success).toBe(false);
    expect(TOOL_BY_NAME.get('list_trades')!.params.safeParse({ limit: 5000 }).success).toBe(false);
    expect(
      TOOL_BY_NAME.get('create_acks')!.params.safeParse({ kind: 'asset', subjects: [], label: 'manual' }).success,
    ).toBe(false);
  });
});

describe('read tools over real views', () => {
  it('answer from the seeded state', async () => {
    expect(await run('get_summary')).toMatchObject({ mode: 'freqtrade-only' });
    expect(await run('get_overview')).toHaveProperty('bots');
    expect(await run('get_bot', { botId: 'votemax' })).toHaveProperty('openTrades');
    expect(await run('get_bot', { botId: 'nope' })).toEqual({ error: 'unknown bot' });
    const trades = (await run('list_trades', { status: 'open', limit: 5 })) as {
      trades: { orders: number; krakenMatch: Record<string, number> }[];
    };
    expect(trades.trades.length).toBeGreaterThan(0);
    expect(typeof trades.trades[0]?.orders).toBe('number');
    expect(await run('get_status')).toHaveProperty('db');
    expect(await run('get_killswitch')).toMatchObject({ mode: 'off', tripped: null });
    expect(await run('list_acks')).toEqual({ acks: [] });
    expect(await run('get_equity', { range: '24h' })).toMatchObject({ count: 0 });
    expect(await run('list_events', {})).toEqual([]);
  });

  it('get_finding includes the runbook', async () => {
    saveLifecycle([
      {
        id: null,
        fingerprint: 'BOT_RESTARTED:votemax',
        rule: 'BOT_RESTARTED',
        severity: 'info',
        maxSeverity: 'info',
        status: 'active',
        title: 't',
        detail: 'd',
        subject: {},
        evidence: {},
        evidenceKeys: [],
        firstSeenAt: 1,
        episodeStartAt: 1,
        activeSince: 1,
        lastSeenAt: 1,
        clearedAt: null,
        resolvedAt: null,
        occurrences: 1,
        flapCount: 0,
        silenced: null,
        notifiedAt: null,
        notifiedSeverity: null,
        notifiedEvidenceCount: null,
      },
    ]);
    const r = (await run('get_finding', { id: 1 })) as { finding: { rule: string }; runbook: { steps: string[] } };
    expect(r.finding.rule).toBe('BOT_RESTARTED');
    expect(r.runbook.steps.length).toBeGreaterThan(0);
    expect(await run('get_finding', { id: 99 })).toEqual({ error: 'unknown finding' });
  });
});

describe('actions and memories', () => {
  it('saves, recalls and deletes memories', async () => {
    const saved = (await run('save_memory', { content: 'Owner wants killswitch alerts on ntfy', tags: ['prefs'] })) as {
      id: number;
    };
    expect(await run('recall_memories', { query: 'ntfy' })).toHaveLength(1);
    expect(await run('delete_memory', { id: saved.id })).toEqual({ deleted: true });
    expect(await run('recall_memories', {})).toEqual([]);
    addMemory({ content: 'x' }, 1);
  });

  it('acknowledges orders attributed to the assistant and the person', async () => {
    const r = await run('create_acks', {
      kind: 'kraken_order',
      subjects: ['OORUYZ-2BWGK-SAYX6T'],
      label: 'manual',
      note: 'mine',
    });
    expect(r).toEqual({ created: 1 });
    expect(listAcks(NOW)[0]).toMatchObject({ subject: 'OORUYZ-2BWGK-SAYX6T', createdBy: 'assistant (Ada)' });
    expect(await run('revoke_ack', { id: listAcks(NOW)[0]!.id })).toEqual({ revoked: true });
  });
});

describe('serializeResult', () => {
  it('caps large results with a note', () => {
    const big = serializeResult({ x: 'a'.repeat(MAX_RESULT_CHARS * 2) });
    expect(big.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(big).toContain('truncated');
    expect(serializeResult({ ok: 1 })).toBe('{"ok":1}');
    expect(serializeResult(undefined)).toBe('null');
  });
});
