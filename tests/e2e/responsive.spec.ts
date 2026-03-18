import { test, expect } from '@playwright/test';

test.describe('responsive layout', () => {
  test('upload page renders at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.locator('#upload-form')).toBeVisible();
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('upload page renders at tablet width', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await expect(page.locator('#upload-form')).toBeVisible();
  });

  test('upload page renders at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('#upload-form')).toBeVisible();
  });
});
