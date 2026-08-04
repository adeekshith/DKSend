import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A bare <svg> and a silently-mutating progress bar are both invisible to a
// screen reader: no name on the one, no announcement on the other.

test('the QR code is announced', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dksend-a11y-'));
  const file = join(dir, 'qr.txt');
  writeFileSync(file, 'qr target');
  await page.goto('/');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

  const block = page.locator('[data-result] .qr-block');
  await expect(block).toHaveAttribute('role', 'img');
  await expect(block).toHaveAttribute('aria-label', /QR code/i);

  // The download page renders its QR server-side, so it needs the same name.
  const href = await page.locator('[data-result] a').first().getAttribute('href');
  await page.goto(href!);
  await expect(page.locator('.qr-block')).toHaveAttribute('role', 'img');
  await expect(page.locator('.qr-block')).toHaveAttribute('aria-label', /QR code/i);
});

test('upload progress is announced', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dksend-a11y-'));
  const file = join(dir, 'progress.bin');
  writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 3));
  await page.goto('/');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();

  const live = page.locator('[data-result] .upload-progress');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded', { timeout: 30_000 });
});
