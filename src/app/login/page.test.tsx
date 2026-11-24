// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { getDb } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { activateSeededUsers, DAY, NOW, testConfig, tokenFor } from '@/server/auth/test-support';
import LoginPage, { metadata } from './page';

const state = vi.hoisted(() => ({
  cfg: undefined as unknown as AppConfig,
  fail: false,
  cookie: undefined as string | undefined,
}));

vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => {
    if (state.fail) throw new Error('SESSION_SECRET: is required');
    return state.cfg;
  },
}));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers(state.cookie === undefined ? {} : { cookie: `fd_session=${state.cookie}` })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock('./LoginForm', () => ({
  LoginForm: ({ next }: { next: string }) => <div data-testid="login-form" data-next={next} />,
}));

const page = (next?: string | string[]) =>
  LoginPage({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });

let temp: TempDb;

beforeEach(() => {
  temp = installTempDb();
  activateSeededUsers();
  state.cfg = testConfig();
  state.fail = false;
  state.cookie = undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearRegisteredSecrets();
  temp.cleanup();
});

describe('login page', () => {
  it('renders the form with a title, and next defaults to the root', async () => {
    render(await page());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('freqdash');
    expect(screen.getByTestId('login-form').getAttribute('data-next')).toBe('/');
    expect(metadata.title).toBe('Sign in - freqdash');
  });

  it('passes a relative next through to the form', async () => {
    render(await page('/bots/votemax?tab=trades'));
    expect(screen.getByTestId('login-form').getAttribute('data-next')).toBe('/bots/votemax?tab=trades');
  });

  it.each([['https://evil.example/x'], ['//evil.example'], ['/\\evil.example'], ['/login'], ['/api/v1/summary']])(
    'sanitizes next=%j to the root',
    async (next) => {
      render(await page(next));
      expect(screen.getByTestId('login-form').getAttribute('data-next')).toBe('/');
    },
  );

  it('uses the first value when next is repeated', async () => {
    render(await page(['/findings', 'https://evil.example']));
    expect(screen.getByTestId('login-form').getAttribute('data-next')).toBe('/findings');
  });

  it('redirects a signed-in visitor to the sanitized next', async () => {
    state.cookie = tokenFor();
    await expect(page('/findings')).rejects.toThrow('NEXT_REDIRECT /findings');
    await expect(page('https://evil.example')).rejects.toThrow('NEXT_REDIRECT /');
  });

  it('shows the form (no redirect loop) for a session that was ended elsewhere', async () => {
    state.cookie = tokenFor();
    getDb().prepare('DELETE FROM sessions').run();
    render(await page('/findings'));
    expect(screen.getByTestId('login-form')).toBeTruthy();
  });

  it('shows the form for an expired or forged session cookie', async () => {
    for (const cookie of [tokenFor({ createdAt: NOW - 31 * DAY }), 'A'.repeat(43), 'garbage']) {
      state.cookie = cookie;
      render(await page());
      expect(screen.getByTestId('login-form')).toBeTruthy();
      cleanup();
    }
  });

  it('still shows the form when the configuration is unusable', async () => {
    state.fail = true;
    state.cookie = tokenFor();
    render(await page());
    expect(screen.getByTestId('login-form')).toBeTruthy();
  });
});
