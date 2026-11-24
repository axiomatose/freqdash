'use client';

import { useState, type FormEvent } from 'react';
import type { ApiErrorBody } from '@/shared/types/api';

// Same plain styling as the sign-in form (this page lives outside the app shell).
const FIELD =
  'block h-12 w-full rounded-lg border border-[#232838] bg-[#0B0D12] px-3 text-base text-[#E6E8EE] placeholder:text-[#8A93A6] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4F8CFF] read-only:opacity-60';
const MIN_LENGTH = 12;

interface Props {
  next: string;
  username: string;
  /** The current password is temporary: there is no way back into the app without changing it. */
  forced: boolean;
  /** Test seam: defaults to `window.location.replace`. */
  navigate?: (url: string) => void;
}

/** Client-side mirror of the server rule (the server decides). */
export function newPasswordProblem(value: string, confirm: string, current: string, username: string): string | null {
  if ([...value].length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (value === current) return 'The new password must be different from the current one.';
  if (username !== '' && value.toLowerCase().includes(username.toLowerCase())) return 'Do not include your username.';
  if (value !== confirm) return 'The two new passwords do not match.';
  return null;
}

export function ChangePasswordForm({ next, username, forced, navigate }: Props) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = navigate ?? ((url: string) => window.location.replace(url));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const problem = newPasswordProblem(password, confirm, current, username);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ currentPassword: current, newPassword: password }),
      });
      if (res.status === 204) {
        go(next.startsWith('/') && !next.startsWith('//') ? next : '/');
        return;
      }
      if (res.status === 401) {
        go('/login');
        return;
      }
      let body: Partial<ApiErrorBody> = {};
      try {
        body = (await res.json()) as Partial<ApiErrorBody>;
      } catch {
        // generic message below
      }
      setError(
        res.status === 429
          ? `Too many failed attempts. Try again in ${Math.ceil((body.retryAfterSec ?? 900) / 60)} min.`
          : (body.message ?? `Could not change the password (HTTP ${res.status}).`),
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setPending(false);
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
    } finally {
      go('/login');
    }
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    autoComplete: 'current-password' | 'new-password',
    hint?: string,
  ) => (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-[#E6E8EE]">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        maxLength={1024}
        value={value}
        onChange={(e) => set(e.target.value)}
        readOnly={pending}
        className={FIELD}
      />
      {hint ? <p className="text-sm text-[#8A93A6]">{hint}</p> : null}
    </div>
  );

  return (
    <form method="post" action="/api/auth/password" onSubmit={onSubmit} className="space-y-5" aria-busy={pending}>
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      {field(
        'current-password',
        forced ? 'Temporary password' : 'Current password',
        current,
        setCurrent,
        'current-password',
      )}
      {field(
        'new-password',
        'New password',
        password,
        setPassword,
        'new-password',
        `At least ${MIN_LENGTH} characters. A few unrelated words make a strong one.`,
      )}
      {field('confirm-password', 'Repeat the new password', confirm, setConfirm, 'new-password')}

      <label className="flex min-h-11 items-center gap-2 text-sm text-[#8A93A6]">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="size-4" />
        Show passwords
      </label>

      {error !== null && (
        <p role="alert" className="rounded-lg border border-[#E5484D] bg-[#E5484D]/10 px-3 py-2 text-sm text-[#E6E8EE]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="h-12 w-full rounded-lg bg-[#4F8CFF] text-base font-semibold text-[#0B0D12] hover:bg-[#6B9DFF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E6E8EE] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Change password'}
      </button>
      {forced ? (
        <button
          type="button"
          onClick={() => void logout()}
          className="h-11 w-full rounded-lg text-sm font-medium text-[#8A93A6] hover:text-[#E6E8EE]"
        >
          Sign out
        </button>
      ) : (
        <a
          href={next}
          className="flex h-11 w-full items-center justify-center rounded-lg text-sm font-medium text-[#8A93A6] hover:text-[#E6E8EE]"
        >
          Cancel
        </a>
      )}
    </form>
  );
}
