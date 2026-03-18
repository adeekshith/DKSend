import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('drag and drop upload', () => {
  test('drag-and-drop uploads a file', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'dragged.txt');
    writeFileSync(filePath, 'dragged content');

    // Create a DataTransfer with the file and dispatch drop event
    const dataTransfer = await page.evaluateHandle(async (content) => {
      const dt = new DataTransfer();
      const file = new File([content], 'dragged.txt', { type: 'text/plain' });
      dt.items.add(file);
      return dt;
    }, 'dragged content');

    const dropZone = page.locator('#drop-zone');
    await dropZone.dispatchEvent('drop', { dataTransfer });

    // Verify label updated
    await expect(page.locator('#drop-zone span')).toHaveText('dragged.txt');

    // Submit and verify upload works
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expect(page.locator('[data-result]')).toContainText('dragged.txt');
  });

  test('drop zone shows dragging state', async ({ page }) => {
    await page.goto('/');

    const dropZone = page.locator('#drop-zone');

    // Simulate dragenter
    await dropZone.dispatchEvent('dragenter');
    await expect(dropZone).toHaveClass(/dragging/);

    // Simulate dragleave
    await dropZone.dispatchEvent('dragleave');
    await expect(dropZone).not.toHaveClass(/dragging/);
  });
});
