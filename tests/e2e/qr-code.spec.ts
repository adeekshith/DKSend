import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('QR codes', () => {
  test('shows a QR code on the upload result and the download page', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'qr-test.txt');
    writeFileSync(filePath, 'scan me');

    await page.locator('#file').setInputFiles(filePath);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    await expect(page.locator('[data-result] .qr-block svg')).toBeVisible();

    const href = await page.locator('[data-result] a').first().getAttribute('href');
    await page.goto(href!);
    await expect(page.locator('.qr-block svg')).toBeVisible();
  });
});
