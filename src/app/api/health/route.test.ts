import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@/shared/constants';
import { GET } from './route';

describe('GET /api/health', () => {
  it('is a public liveness probe that reports the version and is never cached', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, version: APP_VERSION });
  });
});
