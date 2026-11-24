import { expect, test } from '@playwright/test';
import { MOCK_FOR_APP, setScenario } from './env';
import { login, watchErrors } from './helpers';

// The built-in assistant against the mock's scripted OpenAI endpoint (test/mock-upstreams/openai.mjs).

test.beforeAll(async () => {
  await setScenario('normal');
});

test('configure the assistant in Settings, chat, approve an action and see the memory', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // The assistant is a collapsible pane on the right, closed until asked for.
  const pane = page.getByTestId('assistant-pane');
  await expect(pane).toBeHidden();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('assistant-setup')).toBeVisible();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByLabel('Enable the assistant').click();
  await page.getByLabel('API base URL').fill(`${MOCK_FOR_APP}/openai/v1`);
  await page.getByLabel('API key').fill('sk-mock-key-123456789');
  // The model comes from the provider's own list, and there is no model until one is chosen.
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'mock-large' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Key saved')).toBeVisible();
  await page.keyboard.press('Escape');

  // The key must never come back to the browser.
  const settings = await page.request.get('/api/v1/settings');
  expect(await settings.text()).not.toContain('sk-mock-key');

  await expect(page.getByTestId('assistant-setup')).toBeHidden();
  await expect(pane.getByText('mock-large')).toBeVisible();
  const box = page.getByLabel('Message the assistant');
  // Enter is ignored while the assistant is still answering, so wait for it to go idle first.
  const ask = async (text: string) => {
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout: 30_000 });
    await box.fill(text);
    await box.press('Enter');
  };

  await ask('How are the bots doing?');
  await expect(
    page.getByRole('status').filter({ hasText: /Thinking|Pondering|Connecting|Weighing|Checking/ }),
  ).toBeVisible();
  const answer = page.getByTestId('assistant-message').last();
  await expect(answer).toContainText('Here is where things stand', { timeout: 30_000 });
  await expect(answer.getByRole('table')).toBeVisible();

  // A state-changing action waits for approval, and nothing runs before it.
  await ask('Please silence that finding');
  const approve = page.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="tool-card"][data-status="awaiting"]')).toHaveCount(1);
  await approve.click();
  await expect(page.locator('[data-testid="tool-card"][data-status="awaiting"]')).toHaveCount(0);

  // The killswitch reset is a danger action: it asks even though it is the same flow.
  await ask('reset the killswitch');
  await expect(page.getByText('Needs your approval')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText('Okay, I left it alone.')).toBeVisible({ timeout: 30_000 });

  // Memories are saved without asking, and show up in Settings.
  await ask('Remember my setup');
  await expect(page.locator('[data-testid="tool-card"]', { hasText: 'Save memory' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Assistant settings' }).click();
  await page.getByRole('tab', { name: 'Memories' }).click();
  await expect(page.getByText('The owner asked me to remember this setup detail.', { exact: true })).toBeVisible();

  // The pane belongs to the shell: it keeps the conversation across pages and can be collapsed.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Trades' }).first().click();
  await expect(page).toHaveURL(/\/trades/);
  await expect(page.getByTestId('assistant-pane')).toBeVisible();
  await expect(page.getByTestId('user-message').last()).toHaveText('Remember my setup');
  await page.getByRole('button', { name: 'Collapse assistant' }).first().click();
  await expect(page.getByTestId('assistant-pane')).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('assistant-pane')).toBeHidden();

  expect(errors).toEqual([]);
});

test('the read-only agent token cannot read the assistant routes, and a missing session gets 401', async ({
  request,
}) => {
  for (const path of [
    '/api/v1/settings',
    '/api/v1/agent/status',
    '/api/v1/agent/conversations',
    '/api/v1/agent/memories',
  ]) {
    expect((await request.get(path)).status(), path).toBe(401);
  }
  const chat = await request.post('/api/v1/agent/chat', {
    data: { message: 'hi' },
    headers: { Origin: 'http://localhost:3100' },
  });
  expect(chat.status()).toBe(401);
});
