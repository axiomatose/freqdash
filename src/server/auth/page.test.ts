import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { getDb } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { clearRegisteredSecrets } from '../log';
import { PATH_HEADER } from './gate';
import { pageSession, requirePageSession } from './page';
import { activateSeededUsers, NOW, testConfig, tokenFor } from './test-support';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig, headers: new Headers() }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(state.headers) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

let temp: TempDb;
beforeEach(() => {
  state.cfg = testConfig();
  temp = installTempDb();
  activateSeededUsers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  temp.cleanup();
  clearRegisteredSecrets();
});

const as = (token: string | null, path = '/bots/votemax?tab=trades') => {
  state.headers = new Headers({ [PATH_HEADER]: path, ...(token === null ? {} : { cookie: `fd_session=${token}` }) });
};

describe('pages behind the login (app layout)', () => {
  it('render for a live session', async () => {
    as(tokenFor());
    await expect(requirePageSession()).resolves.toMatchObject({ uid: 1, n: 'admin' });
  });

  it('send a visitor without a live session to the login page, keeping where they were going', async () => {
    as(null);
    await expect(requirePageSession()).rejects.toThrow(
      `NEXT_REDIRECT /login?next=${encodeURIComponent('/bots/votemax?tab=trades')}`,
    );
    as('x'.repeat(43), '/');
    await expect(requirePageSession()).rejects.toThrow(/^NEXT_REDIRECT \/login$/);
  });

  it('send a temporary password to the change-password page', async () => {
    getDb().prepare('UPDATE users SET must_change_password = 1').run();
    as(tokenFor(), '/findings');
    await expect(requirePageSession()).rejects.toThrow('NEXT_REDIRECT /change-password?next=%2Ffindings');
  });

  it('never redirect to a forged or absolute path', async () => {
    as(null, '//evil.example/x');
    await expect(requirePageSession()).rejects.toThrow(/^NEXT_REDIRECT \/login$/);
  });

  it('pageSession never throws, even with an unusable configuration', async () => {
    as(tokenFor());
    state.cfg = undefined as unknown as AppConfig;
    await expect(pageSession()).resolves.toBeNull();
  });
});
