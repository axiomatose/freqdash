// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatWait, LoginForm } from './LoginForm';

const fetchMock = vi.fn<typeof fetch>();
const navigate = vi.fn<(url: string) => void>();

function reply(status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const init = { status, headers: { 'Content-Type': 'application/json', ...headers } };
  fetchMock.mockResolvedValueOnce(new Response(body === undefined ? null : JSON.stringify(body), init));
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
}

function submit(): void {
  fireEvent.submit(screen.getByRole('button', { name: /sign in|locked|signing in/i }).closest('form')!);
}

beforeEach(() => {
  fetchMock.mockReset();
  navigate.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LoginForm markup', () => {
  it('has labelled, autofill-friendly, 16 px inputs and a large submit button', () => {
    render(<LoginForm next="/" />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect(password.required).toBe(true);
    expect(password.className).toMatch(/\btext-base\b/); // 16 px: iOS Safari does not zoom
    expect(password.className).toMatch(/\bh-12\b/); // 48 px tap target
    expect(password.className).toMatch(/focus-visible:outline/);

    const username = screen.getByLabelText('Username') as HTMLInputElement;
    expect(username.autocomplete).toBe('username');
    expect(username.getAttribute('autocapitalize')).toBe('none');
    expect(username.maxLength).toBe(32);
    expect(username.required).toBe(true);
    expect(username.className).toMatch(/\btext-base\b/);
    expect(screen.queryByLabelText(/characters in the image/)).toBeNull();

    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button.className).toMatch(/\bh-12\b/);
    expect(button.className).toMatch(/focus-visible:outline/);
  });

  it('never submits as a GET with the password in the URL if it is used before hydration', () => {
    render(<LoginForm next="/" />);
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('/api/auth/login');
  });

  it('toggles password visibility', () => {
    render(<LoginForm next="/" />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(password.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(password.type).toBe('password');
  });
});

describe('LoginForm submission', () => {
  it('posts JSON with the trimmed username and the password, then navigates to next', async () => {
    reply(200, { mustChangePassword: false });
    render(<LoginForm next="/chart?bot=votemax" navigate={navigate} />);
    fill('Username', '  partner ');
    fill('Password', 'hunter2-hunter2');
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/chart?bot=votemax'));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'partner', password: 'hunter2-hunter2' });
    expect((screen.getByRole('button', { name: /signing in/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes to the change-password page first when the password is temporary, keeping next', async () => {
    reply(200, { mustChangePassword: true });
    render(<LoginForm next="/chart?bot=votemax" navigate={navigate} />);
    fill('Username', 'partner');
    fill('Password', 'hunter2-hunter2');
    submit();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/change-password?next=${encodeURIComponent('/chart?bot=votemax')}`),
    );
  });

  it.each([['//evil.example/x'], ['https://evil.example'], ['/\\evil.example'], ['relative']])(
    'refuses to navigate to %j and goes to the root instead',
    async (next) => {
      reply(204);
      render(<LoginForm next={next} navigate={navigate} />);
      fill('Password', 'hunter2-hunter2');
      submit();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    },
  );

  it('shows the server message on 401, keeps the field, refocuses it and re-enables the button', async () => {
    reply(401, { error: 'unauthorized', message: 'Incorrect username or password.' });
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Username', 'partner');
    fill('Password', 'wrong-password-value');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Incorrect username or password.');
    expect(navigate).not.toHaveBeenCalled();
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.value).toBe('wrong-password-value');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(password);
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the captcha the server hands out, sends the answer, and can fetch a new image', async () => {
    const challenge = { id: 'c1', image: 'data:image/png;base64,AAAA', expiresAt: 1 };
    reply(401, { error: 'unauthorized', message: 'Incorrect username or password.', captcha: challenge });
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Username', 'partner');
    fill('Password', 'wrong-password-value');
    submit();
    const image = (await screen.findByAltText(/security check/i)) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe(challenge.image);
    const answer = screen.getByLabelText(/characters in the image/) as HTMLInputElement;
    expect(answer.required).toBe(true);
    expect(answer.autocomplete).toBe('off');

    reply(200, { id: 'c2', image: 'data:image/png;base64,BBBB', expiresAt: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'New image' }));
    await waitFor(() =>
      expect(screen.getByAltText(/security check/i).getAttribute('src')).toBe('data:image/png;base64,BBBB'),
    );
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/captcha');

    reply(200, { mustChangePassword: false });
    fill('Password', 'right-password-value');
    fill('characters in the image', 'acd34');
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({
      username: 'partner',
      password: 'right-password-value',
      captchaId: 'c2',
      captchaAnswer: 'acd34',
    });
  });

  it('explains a rejected origin on 403', async () => {
    reply(403, { error: 'forbidden' });
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/cross-origin/i);
  });

  it('reports other statuses and network failures without crashing', async () => {
    reply(500, { error: 'internal' });
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/HTTP 500/);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    submit();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not reach the server/i));
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not send a second request while one is pending', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    submit();
    submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => resolve(new Response(null, { status: 401 })));
  });
});

describe('LoginForm rate-limit message', () => {
  it('shows the retry time, counts down, disables the button, and unlocks afterwards', async () => {
    vi.useFakeTimers();
    reply(429, { error: 'rate_limited', retryAfterSec: 90 }, { 'Retry-After': '90' });
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    await act(async () => {
      submit();
      await vi.advanceTimersByTimeAsync(0);
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Try again in 1 min 30 s');
    expect(alert.textContent).toContain('locked for about 1 min 30 s'); // screen reader text, static
    const button = screen.getByRole('button', { name: 'Locked' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Try again in 59 s');

    submit(); // ignored while locked
    expect(fetchMock).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to the Retry-After header, then to 15 minutes', async () => {
    vi.useFakeTimers();
    reply(429, undefined, { 'Retry-After': '600' });
    const { unmount } = render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    await act(async () => {
      submit();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('Try again in 10 min');
    unmount();

    reply(429, 'not json at all');
    render(<LoginForm next="/" navigate={navigate} />);
    fill('Password', 'x');
    await act(async () => {
      submit();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('Try again in 15 min');
  });
});

describe('formatWait', () => {
  it.each([
    [0, '0 s'],
    [45, '45 s'],
    [60, '1 min'],
    [90, '1 min 30 s'],
    [900, '15 min'],
    [899.2, '15 min'],
    [-5, '0 s'],
  ])('%s -> %s', (input, expected) => {
    expect(formatWait(input)).toBe(expected);
  });
});
