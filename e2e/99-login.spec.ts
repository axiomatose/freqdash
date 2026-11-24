import { expect, test } from '@playwright/test';
import { USERNAME } from './env';
import { login } from './helpers';

// Last on purpose: it leaves failed attempts behind for this client.
test('login, logout, and the captcha after two wrong passwords', async ({ page, request }) => {
  await login(page);

  await page.goto('/status');
  await page.getByRole('button', { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await request.get('/api/v1/summary')).status()).toBe(401);

  // Two wrong passwords in the form: the second answer brings the captcha.
  for (let i = 0; i < 2; i++) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(`wrong-password-${i}`);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.locator('#login-error')).toContainText(/incorrect username or password/i);
  }
  await expect(page.getByAltText(/security check/i)).toBeVisible();
  await expect(page.locator('#captcha')).toBeVisible();

  // Without solving it, even more guesses are refused before the password is looked at (and never lock anyone out).
  const origin = new URL(page.url()).origin;
  for (let i = 0; i < 3; i++) {
    const res = await request.post('/api/auth/login', {
      data: { username: USERNAME, password: `wrong-${i}` },
      headers: { Origin: origin },
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ message: 'Type the characters in the image.' });
  }
});
