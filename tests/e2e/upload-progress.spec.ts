import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('upload progress', () => {
  test('shows a progress bar while uploading', async ({ page }) => {
    // Hold the PUT before letting it through so the progress UI stays on
    // screen long enough to assert on (localhost uploads complete
    // near-instantly otherwise). Note: route.fetch() would drop the binary
    // body, so the delay must come before route.continue().
    await page.route('**/*', async (route) => {
      if (route.request().method() !== 'PUT') {
        return route.continue();
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'progress.bin');
    writeFileSync(filePath, Buffer.alloc(256 * 1024, 7));

    await page.locator('#file').setInputFiles(filePath);
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result] progress')).toBeVisible();
    await expect(page.locator('[data-result]')).toContainText('progress.bin');

    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
  });
});
