import { expect, request, type Page } from '@playwright/test';
import { PASSWORD, SEED_PASSWORD, USERNAME } from './env';

/**
 * Signs in as the first account through the form. On a fresh database its password is temporary, so the first
 * sign-in goes through the change-password page and sets PASSWORD; later ones (same database) use PASSWORD directly.
 * Which case applies is probed from a throwaway request context, so the page never sees a failed attempt (a console
 * error) and never reuses a keep-alive socket the server may already have closed.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  const origin = new URL(page.url()).origin;
  const probe = await request.newContext();
  const permanent = (
    await probe.post(`${origin}/api/auth/login`, {
      data: { username: USERNAME, password: PASSWORD },
      headers: { Origin: origin },
    })
  ).ok();
  await probe.dispose();

  await page.locator('#username').fill(USERNAME);
  await page.locator('#password').fill(permanent ? PASSWORD : SEED_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  if (!permanent) {
    await expect(page).toHaveURL(/\/change-password/);
    await page.locator('#current-password').fill(SEED_PASSWORD);
    await page.locator('#new-password').fill(PASSWORD);
    await page.locator('#confirm-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
  }
  await expect(page).toHaveURL(/\/$/);
}

/** Console errors and uncaught exceptions of a page; the tests assert the list is empty. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
