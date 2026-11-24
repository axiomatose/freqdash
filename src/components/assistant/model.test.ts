import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage, PendingApproval } from '@/shared/types/agent';
import { applyEvent, initialChat, itemsFromMessages, type ChatState } from './model';

const fold = (events: AgentEvent[], from: ChatState = initialChat): ChatState => events.reduce(applyEvent, from);
const msg = (over: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): AgentMessage => ({
  seq: over.id,
  content: null,
  toolCalls: null,
  toolCallId: null,
  name: null,
  createdAt: 1,
  ...over,
});
const ap: PendingApproval = {
  callId: 'c1',
  name: 'silence_finding',
  arguments: '{"id":1}',
  risk: 'write',
  summary: 'Silence finding #1',
};

describe('applyEvent', () => {
  it('streams text into one assistant item and stops streaming on done', () => {
    const s = fold([
      { type: 'status', phase: 'writing', label: 'Writing' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
    const done = applyEvent({ ...s, busy: true }, { type: 'done' });
    expect(done.items[0]).toMatchObject({ streaming: false });
    expect(done).toMatchObject({ busy: false, phase: 'idle' });
  });

  it('a tool call ends the text run; its result updates the same card', () => {
    let s = fold([
      { type: 'delta', text: 'Let me check.' },
      { type: 'tool_call', callId: 'c1', name: 'get_summary', arguments: '{}' },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'tool']);
    expect(s.items[0]).toMatchObject({ streaming: false });
    expect(s.items[1]).toMatchObject({ status: 'running' });
    s = applyEvent(s, { type: 'tool_result', callId: 'c1', name: 'get_summary', ok: true, summary: '{"ok":1}' });
    expect(s.items[1]).toMatchObject({ status: 'ok', summary: '{"ok":1}' });
    s = applyEvent(s, { type: 'delta', text: 'All good.' });
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'All good.', streaming: true });
  });

  it('marks failed and declined tool results differently', () => {
    const base = fold([
      { type: 'tool_call', callId: 'a', name: 'x', arguments: '{}' },
      { type: 'tool_call', callId: 'b', name: 'y', arguments: '{}' },
    ]);
    const s = fold(
      [
        { type: 'tool_result', callId: 'a', name: 'x', ok: false, summary: 'boom' },
        { type: 'tool_result', callId: 'b', name: 'y', ok: false, summary: 'Declined' },
      ],
      base,
    );
    expect(s.items.map((i) => (i.kind === 'tool' ? i.status : null))).toEqual(['error', 'declined']);
  });

  it('approval marks the calls as awaiting and keeps them pending; results clear them', () => {
    let s = fold([
      { type: 'tool_call', callId: 'c1', name: 'silence_finding', arguments: '{"id":1}' },
      { type: 'approval', calls: [ap] },
      { type: 'done' },
    ]);
    expect(s.pending).toEqual([ap]);
    expect(s.items[0]).toMatchObject({ status: 'awaiting', approval: ap, summary: 'Silence finding #1' });
    s = applyEvent(s, { type: 'tool_result', callId: 'c1', name: 'silence_finding', ok: true, summary: 'Done' });
    expect(s.pending).toEqual([]);
    expect(s.items[0]).toMatchObject({ status: 'ok', approval: null });
  });

  it('an error adds a message and frees the composer', () => {
    const s = fold(
      [
        { type: 'delta', text: 'partial' },
        { type: 'error', message: 'The API rejected the key' },
      ],
      { ...initialChat, busy: true },
    );
    expect(s.items.at(-1)).toMatchObject({ kind: 'error', message: 'The API rejected the key' });
    expect(s.items[0]).toMatchObject({ streaming: false });
    expect(s.busy).toBe(false);
  });
});

describe('itemsFromMessages', () => {
  it('rebuilds a stored conversation with tool results matched to their calls', () => {
    const items = itemsFromMessages(
      [
        msg({ id: 1, role: 'user', content: 'hi' }),
        msg({
          id: 2,
          role: 'assistant',
          content: 'Checking',
          toolCalls: [
            { id: 'c1', name: 'get_summary', arguments: '{}' },
            { id: 'c2', name: 'silence_finding', arguments: '{"id":1}' },
          ],
        }),
        msg({ id: 3, role: 'tool', toolCallId: 'c1', name: 'get_summary', content: '{"mode":"kraken"}' }),
        msg({
          id: 4,
          role: 'tool',
          toolCallId: 'c2',
          name: 'silence_finding',
          content: '{"denied":"The owner declined this action."}',
        }),
        msg({ id: 5, role: 'assistant', content: 'Left alone.' }),
      ],
      [],
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(items[2]).toMatchObject({ status: 'ok' });
    expect(items[3]).toMatchObject({ status: 'declined' });
  });

  it('shows an unanswered call that needs a decision as awaiting, and other unanswered calls as failed', () => {
    const messages = [
      msg({ id: 1, role: 'user', content: 'go' }),
      msg({
        id: 2,
        role: 'assistant',
        toolCalls: [
          { id: 'c1', name: 'silence_finding', arguments: '{"id":1}' },
          { id: 'c9', name: 'get_summary', arguments: '{}' },
        ],
      }),
    ];
    const items = itemsFromMessages(messages, [ap]);
    expect(items[1]).toMatchObject({ status: 'awaiting', approval: ap });
    expect(items[2]).toMatchObject({ status: 'error' });
  });

  it('reports a tool error result', () => {
    const items = itemsFromMessages(
      [
        msg({ id: 1, role: 'assistant', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] }),
        msg({ id: 2, role: 'tool', toolCallId: 'c1', content: '{"error":"unknown bot"}' }),
      ],
      [],
    );
    expect(items[0]).toMatchObject({ status: 'error', summary: 'unknown bot' });
  });
});
