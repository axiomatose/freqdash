import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AppConfig } from '@/server/config';
import {
  activateSeededUsers,
  cookieHeader,
  NOW,
  request,
  testConfig,
  tokenFor,
  TEST_ORIGIN,
} from '@/server/auth/test-support';
import { closeDb } from '@/server/db/client';
import { addMemory, listMemories } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { resetStoreForTests } from '@/server/state/store';
import { updateSettings } from '@/server/settings';
import * as settingsRoute from '../settings/route';
import * as settingsModels from '../settings/agent/models/route';
import * as settingsTest from '../settings/agent/test/route';
import * as chat from './chat/route';
import * as conversations from './conversations/route';
import * as conversation from './conversations/[id]/route';
import * as memories from './memories/route';
import * as memory from './memories/[id]/route';
import * as status from './status/route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig, reply: 'Hello from the model' }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));
vi.mock('@/server/agent/openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/agent/openai')>()),
  streamChat: async function* () {
    yield { type: 'text', text: state.reply };
    yield { type: 'done', toolCalls: [], finishReason: 'stop' };
  },
  pingModel: async (o: { apiKey: string }) => ({ ok: true, reply: `ready:${o.apiKey.length}` }),
  listModels: async (o: { baseUrl: string; apiKey: string }) => ({
    ok: true,
    models: [o.baseUrl, `key${o.apiKey.length}`],
  }),
}));

const AGENT_TOKEN = 'agent-token-for-tests-0123456789-abcdef';
const agentHeaders = { authorization: `Bearer ${AGENT_TOKEN}` };
let temp: TempDb;
const cookie = () => ({ cookie: cookieHeader(tokenFor()) });
const json = { 'content-type': 'application/json', origin: TEST_ORIGIN, host: 'dash.test:8043' };
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = (h: unknown, req: NextRequest, params: Record<string, string> = {}) =>
  (h as Handler)(req, { params: Promise.resolve(params) as Promise<never> });
const post = (path: string, body: unknown, headers: Record<string, string> = cookie()) =>
  request(path, { method: 'POST', headers: { ...headers, ...json }, body: JSON.stringify(body) });

beforeEach(() => {
  state.cfg = testConfig({ AGENT_API_TOKEN: AGENT_TOKEN });
  temp = installTempDb();
  activateSeededUsers();
  resetStoreForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
  closeDb();
  resetStoreForTests();
  clearRegisteredSecrets();
});

describe('access control', () => {
  const gets: [string, unknown][] = [
    ['/api/v1/settings', settingsRoute.GET],
    ['/api/v1/agent/status', status.GET],
    ['/api/v1/agent/conversations', conversations.GET],
    ['/api/v1/agent/memories', memories.GET],
  ];
  it.each(gets)('%s: 401 without a session, 403 for the read-only agent token, 200 for a user', async (path, h) => {
    expect((await call(h, request(path))).status).toBe(401);
    expect((await call(h, request(path, { headers: agentHeaders }))).status).toBe(403);
    expect((await call(h, request(path, { headers: cookie() }))).status).toBe(200);
  });

  it('mutating routes need JSON and a same-origin request', async () => {
    for (const [h, path] of [
      [settingsRoute.PUT, '/api/v1/settings'],
      [chat.POST, '/api/v1/agent/chat'],
      [memories.POST, '/api/v1/agent/memories'],
    ] as const) {
      const noJson = request(path, {
        method: h === settingsRoute.PUT ? 'PUT' : 'POST',
        headers: { ...cookie(), origin: TEST_ORIGIN, host: 'dash.test:8043' },
      });
      expect((await call(h, noJson)).status, path).toBe(415);
      const cross = request(path, {
        method: h === settingsRoute.PUT ? 'PUT' : 'POST',
        headers: { ...cookie(), 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      });
      expect((await call(h, cross)).status, path).toBe(403);
    }
  });
});

describe('settings', () => {
  it('saves settings, encrypts the key and never returns it', async () => {
    const put = request('/api/v1/settings', {
      method: 'PUT',
      headers: { ...cookie(), ...json },
      body: JSON.stringify({
        'agent.enabled': true,
        'agent.model': 'gpt-4.1-mini',
        'agent.apiKey': 'sk-live-abcdef123456',
      }),
    });
    const res = await call(settingsRoute.PUT, put);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('sk-live');
    expect(JSON.parse(text)).toMatchObject({
      secretsSet: { 'agent.apiKey': true },
      values: { 'agent.enabled': true, 'agent.model': 'gpt-4.1-mini' },
    });
    const got = await (await call(settingsRoute.GET, request('/api/v1/settings', { headers: cookie() }))).text();
    expect(got).not.toContain('sk-live');
  });

  it('rejects unknown keys and invalid values with a 400', async () => {
    for (const body of [{ 'agent.nope': 1 }, { 'agent.baseUrl': 'ftp://x' }, { 'agent.maxSteps': 99 }]) {
      const res = await call(
        settingsRoute.PUT,
        request('/api/v1/settings', { method: 'PUT', headers: { ...cookie(), ...json }, body: JSON.stringify(body) }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('tests the connection with the entered key, or the saved one, or reports none', async () => {
    expect((await call(settingsTest.POST, post('/api/v1/settings/agent/test', {}))).status).toBe(400);
    // A key but no model: there is nothing to test yet.
    expect(
      (await call(settingsTest.POST, post('/api/v1/settings/agent/test', { apiKey: 'sk-entered-key-1' }))).status,
    ).toBe(400);
    expect(
      await (
        await call(settingsTest.POST, post('/api/v1/settings/agent/test', { apiKey: 'sk-entered-key-1', model: 'm1' }))
      ).json(),
    ).toEqual({ ok: true, reply: 'ready:16' });
    updateSettings({ 'agent.apiKey': 'sk-live-abcdef123456', 'agent.model': 'm1' }, null, 1);
    expect(await (await call(settingsTest.POST, post('/api/v1/settings/agent/test', {}))).json()).toEqual({
      ok: true,
      reply: 'ready:20',
    });
  });
});

describe('model list', () => {
  it('needs a key, then lists the models of the endpoint in the form using the entered or saved key', async () => {
    const url = '/api/v1/settings/agent/models';
    expect((await call(settingsModels.POST, post(url, {}))).status).toBe(400);
    expect(
      await (
        await call(settingsModels.POST, post(url, { baseUrl: 'https://other.example/v1', apiKey: 'sk-entered-key-1' }))
      ).json(),
    ).toEqual({ ok: true, models: ['https://other.example/v1', 'key16'] });
    updateSettings({ 'agent.apiKey': 'sk-live-abcdef123456' }, null, 1);
    expect(await (await call(settingsModels.POST, post(url, {}))).json()).toEqual({
      ok: true,
      models: ['https://api.openai.com/v1', 'key20'],
    });
  });

  it('is closed to the read-only agent token (it never works on a POST)', async () => {
    expect((await call(settingsModels.POST, post('/api/v1/settings/agent/models', {}, agentHeaders))).status).toBe(401);
  });
});

describe('chat', () => {
  it('refuses while the assistant is off or has no key', async () => {
    const off = await call(chat.POST, post('/api/v1/agent/chat', { message: 'hi' }));
    expect(off.status).toBe(409);
    updateSettings({ 'agent.enabled': true }, null, 1);
    const noKey = await call(chat.POST, post('/api/v1/agent/chat', { message: 'hi' }));
    expect(noKey.status).toBe(409);
    expect(((await noKey.json()) as { message: string }).message).toMatch(/API key/);
    updateSettings({ 'agent.apiKey': 'sk-live-abcdef123456' }, null, 2);
    const noModel = await call(chat.POST, post('/api/v1/agent/chat', { message: 'hi' }));
    expect(noModel.status).toBe(409);
    expect(((await noModel.json()) as { message: string }).message).toMatch(/model/);
  });

  it('streams events as server-sent events and stores the conversation', async () => {
    updateSettings({ 'agent.enabled': true, 'agent.apiKey': 'sk-live-abcdef123456', 'agent.model': 'm1' }, null, 1);
    const res = await call(chat.POST, post('/api/v1/agent/chat', { message: 'How are the bots?' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const events = (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((b) => JSON.parse(b.replace(/^data: /, '')) as { type: string; text?: string; id?: string });
    expect(events.map((e) => e.type)).toEqual(['conversation', 'status', 'status', 'delta', 'done']);
    expect(events.find((e) => e.type === 'delta')?.text).toBe('Hello from the model');

    const list = (await (
      await call(conversations.GET, request('/api/v1/agent/conversations', { headers: cookie() }))
    ).json()) as { conversations: { id: string; title: string }[] };
    expect(list.conversations[0]?.title).toBe('How are the bots?');
    const id = events[0]!.id!;
    const full = (await (
      await call(conversation.GET, request(`/api/v1/agent/conversations/${id}`, { headers: cookie() }), { id })
    ).json()) as { messages: unknown[]; pending: unknown[] };
    expect(full.messages).toHaveLength(2);
    expect(full.pending).toEqual([]);
    const del = await call(
      conversation.DELETE,
      request(`/api/v1/agent/conversations/${id}`, { method: 'DELETE', headers: { ...cookie(), ...json } }),
      { id },
    );
    expect(del.status).toBe(204);
    expect(
      (await call(conversation.GET, request(`/api/v1/agent/conversations/${id}`, { headers: cookie() }), { id }))
        .status,
    ).toBe(404);
  });

  it('validates the body', async () => {
    for (const body of [
      { message: '' },
      { conversationId: 'not-a-uuid', message: 'x' },
      { approvals: { a: 'maybe' } },
    ]) {
      expect((await call(chat.POST, post('/api/v1/agent/chat', body))).status).toBe(400);
    }
  });
});

describe('memories', () => {
  it('lists, adds and deletes', async () => {
    const created = await call(
      memories.POST,
      post('/api/v1/agent/memories', { content: 'Owner prefers short answers', tags: ['style'] }),
    );
    expect(created.status).toBe(200);
    expect(listMemories()).toHaveLength(1);
    const m = addMemory({ content: 'second' }, 5);
    const del = await call(
      memory.DELETE,
      request(`/api/v1/agent/memories/${m.id}`, { method: 'DELETE', headers: { ...cookie(), ...json } }),
      { id: String(m.id) },
    );
    expect(del.status).toBe(204);
    expect(
      (
        await call(
          memory.DELETE,
          request('/api/v1/agent/memories/999', { method: 'DELETE', headers: { ...cookie(), ...json } }),
          { id: '999' },
        )
      ).status,
    ).toBe(404);
    expect((await call(memories.POST, post('/api/v1/agent/memories', { content: '' }))).status).toBe(400);
  });
});
