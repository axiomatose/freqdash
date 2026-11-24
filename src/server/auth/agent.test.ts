import { describe, expect, it } from 'vitest';
import { agentSession } from './agent';

const TOKEN = 'agent-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const req = (method: string, auth?: string) => ({
  method,
  headers: new Headers(auth === undefined ? {} : { authorization: auth }),
});

describe('agentSession', () => {
  it('accepts the exact bearer token on GET and HEAD under /api/v1/', () => {
    for (const m of ['GET', 'HEAD']) {
      const s = agentSession(req(m, `Bearer ${TOKEN}`), '/api/v1/summary', TOKEN, 1000);
      expect(s).toEqual({ sid: null, uid: null, n: 'agent', pc: false, exp: 61_000 });
    }
  });
  it('rejects wrong, missing, malformed and prefix/suffix variants', () => {
    for (const a of [
      undefined,
      '',
      'Bearer',
      'Bearer wrong',
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      `Basic ${TOKEN}`,
      `Bearer  `,
    ]) {
      expect(agentSession(req('GET', a), '/api/v1/summary', TOKEN, 1)).toBeNull();
    }
  });
  it('never authorizes mutating methods', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(agentSession(req(m, `Bearer ${TOKEN}`), '/api/v1/acks', TOKEN, 1)).toBeNull();
    }
  });
  it('never authorizes pages, auth routes or paths outside /api/v1/', () => {
    for (const p of ['/', '/status', '/api/auth/session', '/api/auth/login', '/api/health', '/api/v10/x', '/api/v1']) {
      expect(agentSession(req('GET', `Bearer ${TOKEN}`), p, TOKEN, 1)).toBeNull();
    }
  });
  it('is off when no token is configured', () => {
    expect(agentSession(req('GET', 'Bearer x'), '/api/v1/summary', null, 1)).toBeNull();
  });
});
