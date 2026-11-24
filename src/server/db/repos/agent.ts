import 'server-only';
import type { AgentConversation, AgentMemory, AgentMessage, AgentToolCall } from '@/shared/types/agent';
import type { Ms } from '@/shared/types/domain';
import { clipText, getDb, parseJson } from '../client';

// Persistence of the built-in assistant: conversations with their messages, and long-lived memories.

export const MAX_MEMORIES = 200;
export const MEMORY_MAX_CHARS = 1_500;
const TITLE_MAX = 80;

interface ConvRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}
interface MsgRow {
  id: number;
  seq: number;
  role: string;
  content: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  name: string | null;
  created_at: number;
}
interface MemRow {
  id: number;
  content: string;
  tags: string | null;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

const toConv = (r: ConvRow): AgentConversation => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMsg = (r: MsgRow): AgentMessage => ({
  id: r.id,
  seq: r.seq,
  role: r.role as AgentMessage['role'],
  content: r.content,
  toolCalls: r.tool_calls_json === null ? null : parseJson<AgentToolCall[]>(r.tool_calls_json, []),
  toolCallId: r.tool_call_id,
  name: r.name,
  createdAt: r.created_at,
});

const toMem = (r: MemRow): AgentMemory => ({
  id: r.id,
  content: r.content,
  tags: r.tags === null || r.tags === '' ? [] : r.tags.split(',').filter((t) => t !== ''),
  conversationId: r.conversation_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// --- conversations ------------------------------------------------------------------------------------------------

export function createConversation(id: string, title: string, now: Ms): AgentConversation {
  const t = clipText(title.replace(/\s+/g, ' ').trim(), TITLE_MAX) || 'New chat';
  getDb()
    .prepare('INSERT INTO agent_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, t, now, now);
  return { id, title: t, createdAt: now, updatedAt: now };
}

export function getConversation(id: string): AgentConversation | null {
  const r = getDb().prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id) as ConvRow | undefined;
  return r === undefined ? null : toConv(r);
}

export function listConversations(limit = 50): AgentConversation[] {
  return (
    getDb()
      .prepare('SELECT * FROM agent_conversations ORDER BY updated_at DESC, id LIMIT ?')
      .all(Math.max(1, limit)) as ConvRow[]
  ).map(toConv);
}

export function deleteConversation(id: string): boolean {
  return getDb().prepare('DELETE FROM agent_conversations WHERE id = ?').run(id).changes > 0;
}

export interface NewMessage {
  role: AgentMessage['role'];
  content?: string | null;
  toolCalls?: AgentToolCall[] | null;
  toolCallId?: string | null;
  name?: string | null;
}

export function appendMessage(conversationId: string, m: NewMessage, now: Ms): AgentMessage {
  const db = getDb();
  return db
    .transaction((): AgentMessage => {
      const next = (
        db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM agent_messages WHERE conversation_id = ?')
          .get(conversationId) as {
          n: number;
        }
      ).n;
      const info = db
        .prepare(
          `INSERT INTO agent_messages (conversation_id, seq, role, content, tool_calls_json, tool_call_id, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          next,
          m.role,
          m.content ?? null,
          m.toolCalls && m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null,
          m.name ?? null,
          now,
        );
      db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      return {
        id: Number(info.lastInsertRowid),
        seq: next,
        role: m.role,
        content: m.content ?? null,
        toolCalls: m.toolCalls && m.toolCalls.length > 0 ? m.toolCalls : null,
        toolCallId: m.toolCallId ?? null,
        name: m.name ?? null,
        createdAt: now,
      };
    })
    .immediate();
}

export function listMessages(conversationId: string): AgentMessage[] {
  return (
    getDb()
      .prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as MsgRow[]
  ).map(toMsg);
}

// --- memories -----------------------------------------------------------------------------------------------------

export class MemoryLimitError extends Error {}

export function addMemory(
  input: { content: string; tags?: string[]; conversationId?: string | null },
  now: Ms,
): AgentMemory {
  const content = clipText(input.content.trim(), MEMORY_MAX_CHARS) ?? '';
  if (content === '') throw new RangeError('memory must not be empty');
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM agent_memories').get() as { n: number }).n;
  if (count >= MAX_MEMORIES) throw new MemoryLimitError(`at most ${MAX_MEMORIES} memories; delete some first`);
  const tags = (input.tags ?? [])
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, ''),
    )
    .filter((t) => t !== '')
    .slice(0, 8);
  const info = db
    .prepare(
      'INSERT INTO agent_memories (content, tags, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(content, tags.join(','), input.conversationId ?? null, now, now);
  return toMem(db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(Number(info.lastInsertRowid)) as MemRow);
}

export function listMemories(opts: { query?: string; limit?: number } = {}): AgentMemory[] {
  const limit = Math.max(1, opts.limit ?? MAX_MEMORIES);
  const q = opts.query?.trim();
  const rows =
    q === undefined || q === ''
      ? (getDb()
          .prepare('SELECT * FROM agent_memories ORDER BY updated_at DESC, id DESC LIMIT ?')
          .all(limit) as MemRow[])
      : (getDb()
          .prepare(
            "SELECT * FROM agent_memories WHERE content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id DESC LIMIT ?",
          )
          .all(
            `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
            `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
            limit,
          ) as MemRow[]);
  return rows.map(toMem);
}

export function deleteMemory(id: number): boolean {
  return getDb().prepare('DELETE FROM agent_memories WHERE id = ?').run(id).changes > 0;
}
