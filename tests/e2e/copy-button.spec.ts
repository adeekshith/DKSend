import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('copy button', () => {
  test('copy button shows feedback', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/');

    // Upload a file first
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'copy-test.txt');
    writeFileSync(filePath, 'copy me');

    await page.locator('#file').setInputFiles(filePath);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    // Click the first copy button
    const copyButton = page.locator('[data-copy]').first();
    await expect(copyButton).toBeVisible();

    const url = await copyButton.getAttribute('data-copy');
    expect(url).toBeTruthy();

    await copyButton.click();
    await expect(copyButton).toHaveText('Copied!');

    // Verify clipboard contents
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(url);

    // Button text should revert
    await expect(copyButton).toHaveText('Copy', { timeout: 3000 });
  });
});
