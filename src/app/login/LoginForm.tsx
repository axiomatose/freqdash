'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiErrorBody, CaptchaChallenge } from '@/shared/types/api';

// Sign-in form. Plain Tailwind classes only (the UI kit is built in parallel); dark theme colors from docs/PLAN.md
// section 9. Inputs are 16 px (text-base) so iOS Safari does not zoom on focus; every control is at least 44 px tall.

const FIELD =
  'block h-12 w-full rounded-lg border border-[#232838] bg-[#0B0D12] px-3 text-base text-[#E6E8EE] placeholder:text-[#8A93A6] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4F8CFF] read-only:opacity-60';
const DEFAULT_LOCK_SEC = 15 * 60;

interface Props {
  /** Where to go after signing in. Already sanitized on the server; re-checked here as a second line of defense. */
  next: string;
  /** Test seam: defaults to `window.location.replace` (a full navigation, so the new cookie is used everywhere). */
  navigate?: (url: string) => void;
}

interface Lock {
  until: number;
  totalSec: number;
}

function relativeOrRoot(target: string): string {
  return target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/';
}

/** "14 min 32 s", "45 s". */
export function formatWait(totalSeconds: number): string {
  const sec = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

async function errorBody(res: Response): Promise<Partial<ApiErrorBody>> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Partial<ApiErrorBody>) : {};
  } catch {
    return {};
  }
}

function retryAfterSeconds(res: Response, body: Partial<ApiErrorBody>): number {
  if (typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0) return body.retryAfterSec;
  const header = Number(res.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header : DEFAULT_LOCK_SEC;
}

export function LoginForm({ next, navigate }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLock] = useState<Lock | null>(null);
  const [now, setNow] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);
  const captchaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (lock === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lock.until) setLock(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lock]);

  const remainingSec = lock === null ? 0 : Math.max(0, Math.ceil((lock.until - now) / 1000));
  const locked = lock !== null && remainingSec > 0;

  async function newImage() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/auth/captcha', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        setCaptcha((await res.json()) as CaptchaChallenge);
        setCaptchaAnswer('');
        captchaRef.current?.focus();
      }
    } catch {
      // keep the current image
    }
    setRefreshing(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || locked) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(captcha !== null ? { captchaId: captcha.id, captchaAnswer } : {}),
        }),
      });
      if (res.ok) {
        let mustChange = false;
        try {
          mustChange = ((await res.json()) as { mustChangePassword?: boolean }).mustChangePassword === true;
        } catch {
          // the proxy redirects a temporary password anyway
        }
        const target = relativeOrRoot(next);
        const url = mustChange
          ? `/change-password${target === '/' ? '' : `?next=${encodeURIComponent(target)}`}`
          : target;
        // Stay in the pending state while the browser navigates.
        (navigate ?? ((u: string) => window.location.replace(u)))(url);
        return;
      }
      const body = await errorBody(res);
      if (res.status === 401) {
        const challenge = body.captcha ?? null;
        setCaptcha(challenge);
        setCaptchaAnswer('');
        setError(body.message ?? 'Incorrect username or password.');
        if (challenge !== null && body.message?.startsWith('Incorrect') !== true) {
          captchaRef.current?.focus();
        } else {
          passwordRef.current?.focus();
          passwordRef.current?.select();
        }
      } else if (res.status === 429) {
        const totalSec = retryAfterSeconds(res, body);
        const t = Date.now();
        setNow(t);
        setLock({ until: t + totalSec * 1000, totalSec });
      } else if (res.status === 403) {
        setError('The request was rejected as cross-origin. Open the dashboard from its usual address and try again.');
      } else {
        setError(`Sign-in failed (HTTP ${res.status}). Try again in a moment.`);
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setPending(false);
  }

  const message = locked ? null : error;

  return (
    // method/action keep the password out of the URL should the form ever be submitted before this component hydrates.
    <form method="post" action="/api/auth/login" onSubmit={onSubmit} className="space-y-5" aria-busy={pending}>
      <div className="space-y-2">
        <label htmlFor="username" className="block text-sm font-medium text-[#E6E8EE]">
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          required
          maxLength={32}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          readOnly={pending}
          className={FIELD}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm font-medium text-[#E6E8EE]">
          Password
        </label>
        <div className="relative">
          <input
            ref={passwordRef}
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            maxLength={1024}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            readOnly={pending}
            aria-invalid={message !== null}
            aria-describedby={message !== null ? 'login-error' : undefined}
            className={`${FIELD} pr-20`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            aria-controls="password"
            className="absolute inset-y-1 right-1 min-w-16 rounded-md px-3 text-sm font-medium text-[#8A93A6] hover:text-[#E6E8EE] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4F8CFF]"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {captcha !== null && (
        <div className="space-y-2">
          <label htmlFor="captcha" className="block text-sm font-medium text-[#E6E8EE]">
            Type the characters in the image
          </label>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a one-off data: URL, nothing for next/image to optimize */}
            <img
              src={captcha.image}
              alt="Security check: five distorted characters"
              width={220}
              height={80}
              className="h-20 w-[220px] max-w-full rounded-lg border border-[#232838]"
            />
            <button
              type="button"
              onClick={() => void newImage()}
              disabled={refreshing || pending}
              className="h-12 rounded-lg px-3 text-sm font-medium text-[#8A93A6] hover:text-[#E6E8EE] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4F8CFF] disabled:opacity-60"
            >
              New image
            </button>
          </div>
          <input
            ref={captchaRef}
            id="captcha"
            name="captcha"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            maxLength={16}
            value={captchaAnswer}
            onChange={(e) => setCaptchaAnswer(e.target.value)}
            readOnly={pending}
            className={`${FIELD} uppercase tracking-widest`}
          />
          <p className="text-sm text-[#8A93A6]">Shown after two wrong passwords. Letters are not case-sensitive.</p>
        </div>
      )}

      {message !== null && (
        <p
          id="login-error"
          role="alert"
          className="rounded-lg border border-[#E5484D] bg-[#E5484D]/10 px-3 py-2 text-sm text-[#E6E8EE]"
        >
          {message}
        </p>
      )}

      {locked && lock !== null && (
        <div
          role="alert"
          className="rounded-lg border border-[#F5A524] bg-[#F5A524]/10 px-3 py-2 text-sm text-[#E6E8EE]"
        >
          <span className="sr-only">
            Too many failed attempts. Sign-in is locked for about {formatWait(lock.totalSec)}.
          </span>
          <span aria-hidden="true">
            Too many failed attempts. Try again in{' '}
            <span className="font-semibold tabular-nums">{formatWait(remainingSec)}</span>.
          </span>
        </div>
      )}

      <button
        type="submit"
        disabled={pending || locked}
        className="h-12 w-full rounded-lg bg-[#4F8CFF] text-base font-semibold text-[#0B0D12] hover:bg-[#6B9DFF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E6E8EE] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Signing in…' : locked ? 'Locked' : 'Sign in'}
      </button>
    </form>
  );
}
