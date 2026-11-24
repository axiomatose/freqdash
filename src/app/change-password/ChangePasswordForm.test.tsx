// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangePasswordForm, newPasswordProblem } from './ChangePasswordForm';

const fetchMock = vi.fn<typeof fetch>();
const navigate = vi.fn<(url: string) => void>();

beforeEach(() => {
  fetchMock.mockReset();
  navigate.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('newPasswordProblem', () => {
  it('mirrors the server rules', () => {
    expect(newPasswordProblem('short', 'short', 'cur', 'partner')).toMatch(/12/);
    expect(newPasswordProblem('current-password', 'current-password', 'current-password', 'partner')).toMatch(
      /different/,
    );
    expect(newPasswordProblem('hello-partner-hello', 'hello-partner-hello', 'cur', 'partner')).toMatch(/username/);
    expect(newPasswordProblem('orange river lantern', 'orange river lanter', 'cur', 'partner')).toMatch(/match/);
    expect(newPasswordProblem('orange river lantern', 'orange river lantern', 'cur', 'partner')).toBeNull();
  });
});

describe('ChangePasswordForm', () => {
  it('posts the current and new password and continues to next', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<ChangePasswordForm next="/findings" username="partner" forced navigate={navigate} />);
    expect(screen.getByLabelText('Temporary password')).toBeTruthy();
    fill('Temporary password', 'test-temporary-password');
    fill('New password', 'orange river lantern');
    fill('Repeat the new password', 'orange river lantern');
    fireEvent.submit(screen.getByRole('button', { name: 'Change password' }).closest('form')!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/findings'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/password');
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: 'test-temporary-password',
      newPassword: 'orange river lantern',
    });
  });

  it('checks locally first and shows the server message otherwise', async () => {
    render(<ChangePasswordForm next="/" username="partner" forced={false} navigate={navigate} />);
    fill('Current password', 'old-password-1');
    fill('New password', 'short');
    fill('Repeat the new password', 'short');
    fireEvent.submit(screen.getByRole('button', { name: 'Change password' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/12 characters/);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'bad_request', message: 'The current password is not correct.' }, { status: 400 }),
    );
    fill('New password', 'orange river lantern');
    fill('Repeat the new password', 'orange river lantern');
    fireEvent.submit(screen.getByRole('button', { name: 'Change password' }).closest('form')!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The current password is not correct.'));
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/');
  });
});
