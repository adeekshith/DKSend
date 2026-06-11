import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('paste and multi-file upload', () => {
  test('uploads two files and shows a card for each', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const first = join(dir, 'first.txt');
    const second = join(dir, 'second.txt');
    writeFileSync(first, 'contents of the first file');
    writeFileSync(second, 'second file says hi');

    await page.locator('#file').setInputFiles([first, second]);
    await expect(page.locator('#drop-zone span')).toHaveText('2 files selected');
    await expect(page.locator('#filename')).toBeDisabled();

    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expect(page.locator('[data-result] .file-card')).toHaveCount(2);
    await expect(page.locator('[data-result]')).toContainText('first.txt');
    await expect(page.locator('[data-result]')).toContainText('second.txt');

    // Every raw link downloads its own file's content
    const inputs = page.locator('[data-result] .link-row input');
    const values: string[] = [];
    for (let i = 0; i < (await inputs.count()); i++) {
      values.push(await inputs.nth(i).inputValue());
    }
    const rawUrls = values.filter((value) => value.includes('/raw/'));
    expect(rawUrls).toHaveLength(2);
    const bodies = [];
    for (const url of rawUrls) {
      const response = await page.request.get(url);
      expect(response.status()).toBe(200);
      bodies.push(await response.text());
    }
    expect(bodies.sort()).toEqual(['contents of the first file', 'second file says hi']);
  });

  test('pasting an image selects it with a generated filename', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['fake png bytes'], 'clipboard.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true });
      document.dispatchEvent(event);
    });

    await expect(page.locator('#drop-zone span')).toHaveText(/^pasted-.*\.png$/);

    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expect(page.locator('[data-result]')).toContainText(/pasted-.*\.png/);
  });
});
