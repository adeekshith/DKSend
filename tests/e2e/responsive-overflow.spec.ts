import { test, expect, Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A page that scrolls sideways on a phone is a layout bug, not a style
// preference: the content is genuinely unreachable without panning. The cause
// here was a grid track that could not shrink below its item's min-content,
// where the item held an unwrapped curl command.

const NARROW = { width: 375, height: 720 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Names the widest offenders so a regression says *what* overflowed.
async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().right > vw + 0.5)
      .map((el) => {
        const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).join('.');
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
      });
  });
}

async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await horizontalOverflow(page);
  expect(overflow, `${where} overflows by ${overflow}px: ${(await offenders(page)).join(', ')}`)
    .toBeLessThanOrEqual(0);
}

test.describe('narrow viewport', () => {
  test.use({ viewport: NARROW });

  test('the upload page does not scroll sideways', async ({ page }) => {
    await page.goto('/');
    await expectNoSidewaysScroll(page, 'upload page');
  });

  test('the upload result panel does not scroll sideways', async ({ page }) => {
    await page.goto('/');
    const dir = mkdtempSync(join(tmpdir(), 'dksend-narrow-'));
    const file = join(dir, 'narrow.txt');
    writeFileSync(file, 'narrow viewport upload');
    await page.locator('#file').setInputFiles(file);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expectNoSidewaysScroll(page, 'upload result');
  });

  // The download page carries the long links, the SHA-256 hash, and its own
  // curl block, so it has more chances to overflow than the upload page.
  test('the download page does not scroll sideways', async ({ page }) => {
    await page.goto('/');
    const dir = mkdtempSync(join(tmpdir(), 'dksend-narrow-'));
    const file = join(dir, 'a-fairly-long-download-filename.txt');
    writeFileSync(file, 'hello from a narrow viewport');
    await page.locator('#file').setInputFiles(file);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    const href = await page.locator('[data-result] a').first().getAttribute('href');
    await page.goto(href!);
    await expectNoSidewaysScroll(page, 'download page');
  });

  test('the 404 page does not scroll sideways', async ({ page }) => {
    await page.goto('/definitely-not-a-code');
    await expectNoSidewaysScroll(page, '404 page');
  });
});
