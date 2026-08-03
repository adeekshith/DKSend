import { test, expect, Page } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before the .btn refactor these states did not exist. Disabled was the worst
// of them: app.js disables submit for the whole upload, but a button with a
// custom background gets no dimming from the UA, so it still looked clickable.

async function prop(page: Page, selector: string, name: string): Promise<string> {
  return page.evaluate(
    ([sel, p]) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(p),
    [selector, name] as const,
  );
}

test('the submit button looks disabled while uploading', async ({ page }) => {
  // A body large enough that the disabled state is observable mid-flight.
  const dir = mkdtempSync(join(tmpdir(), 'dksend-btn-'));
  const file = join(dir, 'slow.bin');
  writeFileSync(file, Buffer.alloc(6 * 1024 * 1024, 7));

  await page.goto('/');
  const submit = page.locator('button[type="submit"]');
  const idleOpacity = parseFloat(await prop(page, 'button[type="submit"]', 'opacity'));
  expect(idleOpacity).toBe(1);

  await page.locator('#file').setInputFiles(file);
  await submit.click();

  await expect(submit).toBeDisabled();
  const busyOpacity = parseFloat(await prop(page, 'button[type="submit"]', 'opacity'));
  const cursor = await prop(page, 'button[type="submit"]', 'cursor');
  expect(busyOpacity, 'a disabled button must not look clickable').toBeLessThan(1);
  expect(cursor).toBe('not-allowed');

  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded', { timeout: 30_000 });
});

test('every button shows a focus ring', async ({ page }) => {
  await page.goto('/');
  for (const selector of ['button[type="submit"]', '.mode-tab']) {
    await page.locator(selector).first().focus();
    const style = await prop(page, selector, 'outline-style');
    const width = parseFloat(await prop(page, selector, 'outline-width'));
    expect(style, `${selector} needs a focus ring`).not.toBe('none');
    expect(width, `${selector} focus ring must have width`).toBeGreaterThan(0);
  }
});

test('secondary buttons change background on hover, not just their border', async ({ page }) => {
  await page.goto('/');
  const dir = mkdtempSync(join(tmpdir(), 'dksend-btn-'));
  const file = join(dir, 'hoverme.txt');
  writeFileSync(file, 'hover target');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

  const copy = page.locator('[data-copy]').first();
  const rest = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-copy]')!).backgroundColor,
  );
  await copy.hover();
  const hovered = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-copy]')!).backgroundColor,
  );
  expect(hovered, 'hover must be more than a border tint').not.toBe(rest);
});

// The point of dropping the blanket `button { margin-top: 18px }`: spacing is
// the container's job, so buttons sitting in a row no longer need overrides to
// line up with their neighbours.
test('buttons in a row share one baseline', async ({ page }) => {
  await page.goto('/');
  const dir = mkdtempSync(join(tmpdir(), 'dksend-btn-'));
  const file = join(dir, 'baseline.txt');
  writeFileSync(file, 'baseline check');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

  const tops = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.link-row')).map((row) => {
      const input = row.querySelector('input')!.getBoundingClientRect();
      const button = row.querySelector('button')!.getBoundingClientRect();
      return Math.abs(input.top - button.top);
    }),
  );
  expect(tops.length).toBeGreaterThan(0);
  for (const delta of tops) {
    expect(delta, 'input and its copy button must align').toBeLessThanOrEqual(1);
  }
});
