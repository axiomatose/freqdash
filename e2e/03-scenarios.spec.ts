import { expect, test } from '@playwright/test';
import { setScenario } from './env';
import { login } from './helpers';

test('incident scenario: critical banner, findings detail and bulk ack', async ({ page }) => {
  await setScenario('normal');
  await setScenario('incident', { speed: 20 });
  await login(page);
  await expect(page.locator('[data-severity="critical"]').first()).toBeVisible({ timeout: 90_000 });
  await page.goto('/findings');
  const row = page.getByRole('row', { name: /Kraken orders on ETH\/USD that no bot knows/ }).first();
  await expect(row).toBeVisible({ timeout: 90_000 });
  await row.click();
  await expect(page.getByRole('table', { name: 'Orders' })).toBeVisible();
  const ack = page.getByRole('button', { name: /Mark \d+ orders manual/ });
  await expect(ack).toBeVisible();
  await ack.click();
  await expect(page.getByText(/Marked \d+ order/)).toBeVisible();
});

test('bot-down scenario shows a Down pill', async ({ page }) => {
  await setScenario('bot-down');
  await login(page);
  await page.goto('/bots/votemax');
  await expect(page.locator('[data-status="down"]').first()).toBeVisible({ timeout: 120_000 });
});

test('no-kraken scenario shows the freqtrade-only banner', async ({ page }) => {
  await setScenario('no-kraken');
  await login(page);
  // Kraken balances are stale after 3x their cadence (90 s), then the mode flips.
  await expect(page.getByText(/freqtrade-only|No Kraken key/i).first()).toBeVisible({ timeout: 150_000 });
});
