import { test, expect, Page } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// There was no danger colour in the palette at all, so the irreversible
// "Delete file" button rendered in exactly the same friendly blue as "Upload",
// and its Cancel escape hatch was the more visually distinct of the two.

async function bg(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)!).backgroundColor,
    selector,
  );
}

async function deleteUrlFor(page: Page, name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dksend-del-'));
  const file = join(dir, name);
  writeFileSync(file, 'delete me');
  await page.goto('/');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
  // Rows are Page, Raw, SHA-256, Delete — the delete URL is the last input.
  const inputs = page.locator('[data-result] .link-row input');
  return (await inputs.last().inputValue()).trim();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('the delete button is visually distinct from cancel and from upload', async ({ page }) => {
      const uploadBg = await (async () => {
        await page.goto('/');
        return bg(page, 'button[type="submit"]');
      })();

      const url = await deleteUrlFor(page, 'doomed.txt');
      await page.goto(url);
      await expect(page.locator('body')).toContainText('doomed.txt');

      const deleteBg = await bg(page, 'button[type="submit"]');
      const cancelBg = await bg(page, 'a.btn');

      expect(deleteBg, 'a destructive action must not look like Upload').not.toBe(uploadBg);
      expect(deleteBg, 'the destructive action must not match its own escape hatch').not.toBe(
        cancelBg,
      );

      // Red, not blue: the red channel has to dominate.
      const [r, g, b] = deleteBg.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      expect(r, `expected a red fill, got ${deleteBg}`).toBeGreaterThan(g + 40);
      expect(r, `expected a red fill, got ${deleteBg}`).toBeGreaterThan(b + 40);
    });

    test('the irreversible-action notice is not styled as an expiry', async ({ page }) => {
      const url = await deleteUrlFor(page, 'notice.txt');
      await page.goto(url);
      const notice = page.locator('.notice-danger');
      await expect(notice).toContainText('cannot be undone');
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector('.notice-danger')!).color,
      );
      const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      expect(r, `warning text should read red, got ${color}`).toBeGreaterThan(g);
      expect(r, `warning text should read red, got ${color}`).toBeGreaterThan(b);
    });

    test('an upload failure is reported as an error, not as a tip', async ({ page }) => {
      await page.goto('/');
      // Force a server-side rejection by exceeding the configured size limit
      // client-side check: use a name-only failure instead by stubbing the PUT.
      await page.route('**/?*', (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, error: { message: 'Nope' } }),
            })
          : route.continue(),
      );
      const dir = mkdtempSync(join(tmpdir(), 'dksend-fail-'));
      const file = join(dir, 'fails.txt');
      writeFileSync(file, 'will fail');
      await page.locator('#file').setInputFiles(file);
      await page.locator('button[type="submit"]').click();

      const err = page.locator('.notice-danger');
      await expect(err).toContainText('Nope');
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector('.notice-danger')!).color,
      );
      const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      expect(r, `error text should read red, got ${color}`).toBeGreaterThan(g);
      expect(r, `error text should read red, got ${color}`).toBeGreaterThan(b);
    });
  });
}
