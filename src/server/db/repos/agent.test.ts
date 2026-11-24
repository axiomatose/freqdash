import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTempDb, type TempDb } from '../testing';
import {
  MAX_MEMORIES,
  MemoryLimitError,
  addMemory,
  appendMessage,
  createConversation,
  deleteConversation,
  deleteMemory,
  getConversation,
  listConversations,
  listMemories,
  listMessages,
} from './agent';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

describe('conversations', () => {
  it('creates, orders by recent activity, appends in sequence and deletes with cascade', () => {
    createConversation('a', '  How is   VoteMax?  ', 100);
    createConversation('b', '', 200);
    expect(getConversation('a')?.title).toBe('How is VoteMax?');
    expect(getConversation('b')?.title).toBe('New chat');
    expect(listConversations().map((c) => c.id)).toEqual(['b', 'a']);

    appendMessage('a', { role: 'user', content: 'hi' }, 300);
    const m2 = appendMessage(
      'a',
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'get_summary', arguments: '{}' }] },
      301,
    );
    appendMessage('a', { role: 'tool', content: '{"ok":true}', toolCallId: 'c1', name: 'get_summary' }, 302);
    expect(m2.seq).toBe(2);
    expect(listConversations().map((c) => c.id)).toEqual(['a', 'b']);
    const msgs = listMessages('a');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(msgs[1]?.toolCalls).toEqual([{ id: 'c1', name: 'get_summary', arguments: '{}' }]);
    expect(msgs[2]).toMatchObject({ toolCallId: 'c1', name: 'get_summary' });

    expect(deleteConversation('a')).toBe(true);
    expect(listMessages('a')).toEqual([]);
    expect(deleteConversation('a')).toBe(false);
  });

  it('refuses a message for an unknown conversation', () => {
    expect(() => appendMessage('nope', { role: 'user', content: 'x' }, 1)).toThrow();
  });
});

describe('memories', () => {
  it('adds with cleaned tags, searches content and tags, and deletes', () => {
    const m = addMemory(
      { content: '  VoteMax exit_profit_only matters at 0.8% fees ', tags: ['Fees', ' strategy! ', ''] },
      10,
    );
    expect(m.tags).toEqual(['fees', 'strategy']);
    expect(m.content).toBe('VoteMax exit_profit_only matters at 0.8% fees');
    addMemory({ content: 'Owner prefers short answers' }, 20);
    expect(listMemories().map((x) => x.content)[0]).toBe('Owner prefers short answers');
    expect(listMemories({ query: 'exit_profit' })).toHaveLength(1);
    expect(listMemories({ query: 'strategy' })).toHaveLength(1);
    expect(listMemories({ query: '100%' })).toHaveLength(0);
    expect(deleteMemory(m.id)).toBe(true);
    expect(deleteMemory(m.id)).toBe(false);
  });

  it('rejects empty content and enforces the cap', () => {
    expect(() => addMemory({ content: '   ' }, 1)).toThrow(RangeError);
    for (let i = 0; i < MAX_MEMORIES; i++) addMemory({ content: `m${i}` }, i);
    expect(() => addMemory({ content: 'one too many' }, 999)).toThrow(MemoryLimitError);
  });
});
