import { expect, test } from '@playwright/test';
import { setScenario } from './env';
import { login, watchErrors } from './helpers';

test.beforeAll(async () => {
  await setScenario('normal');
});

test('overview renders with freshness dots and no console errors (desktop)', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await expect(page.getByTestId('account-card')).toContainText('$');
  await expect(page.locator('[data-slot="metric"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="metric"][data-freshness="fresh"]').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('bot-card-votemax')).toBeVisible();
  await expect(page.getByTestId('bot-card-dca')).toBeVisible();
  expect(errors).toEqual([]);
});

test('overview renders on a phone without horizontal scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await expect(page.getByTestId('account-card')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the chart renders a canvas with fills', async ({ page }) => {
  await login(page);
  await page.goto('/chart?bot=votemax&pair=BTC/USD&tf=4h');
  const chart = page.getByTestId('price-chart');
  await expect(chart.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(chart).toHaveAttribute('data-candles', /^[1-9]\d*$/);
  await expect(chart).toHaveAttribute('data-fills', /^[1-9]\d*$/);
});
