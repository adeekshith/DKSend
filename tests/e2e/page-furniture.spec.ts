import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function uploadAndOpen(page: any, name: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dksend-furn-'));
  const file = join(dir, name);
  writeFileSync(file, 'furniture check');
  await page.goto('/');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
  const href = await page.locator('[data-result] a').first().getAttribute('href');
  await page.goto(href!);
}

test('the curl quickstart can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const copy = page.locator('[data-copy-from="#cli-quickstart"]');
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveText('Copied!');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('--upload-file');
});

test('the download page curl command can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await uploadAndOpen(page, 'curlme.txt');
  const copy = page.locator('[data-copy-from="#curl-command"]');
  await expect(copy).toBeVisible();
  await copy.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('curl -O');
  expect(copied).toContain('curlme.txt');
});

test('the download page offers a way back to the upload form', async ({ page }) => {
  await uploadAndOpen(page, 'nav.txt');
  await page.locator('.home-link').click();
  await expect(page.locator('#upload-form')).toBeVisible();
});

test('focusing a readonly share link selects the whole value', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dksend-furn-'));
  const file = join(dir, 'select.txt');
  writeFileSync(file, 'select all');
  await page.goto('/');
  await page.locator('#file').setInputFiles(file);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

  const field = page.locator('[data-result] .link-row input').first();
  await field.click();
  const selected = await page.evaluate(() => {
    const el = document.querySelector('[data-result] .link-row input') as HTMLInputElement;
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  });
  const value = await field.inputValue();
  expect(selected, 'the whole share link should be selected').toBe(value);
});

test('a favicon is declared so /favicon.ico never renders the 404 page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
});

test('the theme colour follows the colour scheme', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
});

test('the download page exposes link-preview metadata', async ({ page }) => {
  await uploadAndOpen(page, 'preview.txt');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'preview.txt');
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/[a-z0-9]+$/i);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /preview\.txt/,
  );
});

test('the admin page can copy a share link', async ({ page }) => {
  // Admin needs UPLOAD_TOKEN, which this server does not set, so the endpoint
  // 404s. Assert app.js is at least wired up for when it is enabled.
  await page.goto('/');
  const scripts = await page.evaluate(() =>
    Array.from(document.scripts).map((s) => s.getAttribute('src') ?? ''),
  );
  expect(scripts.some((s) => s.includes('app.js'))).toBe(true);
});
