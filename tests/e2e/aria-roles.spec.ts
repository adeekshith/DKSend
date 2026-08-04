import { test, expect } from '@playwright/test';

test.describe('accessible names and roles', () => {
  test('the mode toggle is a pair of toggle buttons, not a tablist', async ({ page }) => {
    await page.goto('/');
    expect(await page.locator('[role="tablist"]').count(), 'no tabpanels exist to justify tabs')
      .toBe(0);
    expect(await page.locator('[aria-selected]').count(), 'aria-selected is invalid on a button')
      .toBe(0);

    const file = page.locator('[data-mode-set="file"]');
    const text = page.locator('[data-mode-set="text"]');
    await expect(file).toHaveAttribute('aria-pressed', 'true');
    await expect(text).toHaveAttribute('aria-pressed', 'false');

    await text.click();
    await expect(file).toHaveAttribute('aria-pressed', 'false');
    await expect(text).toHaveAttribute('aria-pressed', 'true');
  });
});
