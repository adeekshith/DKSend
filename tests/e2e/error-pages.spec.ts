import { test, expect } from '@playwright/test';

test.describe('error pages', () => {
  test('nonexistent code shows error', async ({ page }) => {
    const response = await page.goto('/zzz999');
    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('does not exist');
  });

  test('empty upload rejected via API', async ({ page }) => {
    const response = await page.request.put('http://localhost:3000/?name=empty.txt', {
      headers: { 'content-length': '0' },
      data: '',
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('FILE_EMPTY');
  });
});
