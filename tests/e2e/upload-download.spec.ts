import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('upload and download flow', () => {
  test('upload via file input and download', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#upload-form')).toBeVisible();

    // Create a temp file to upload
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'hello.txt');
    writeFileSync(filePath, 'hello from playwright');

    // Upload via file input
    const fileInput = page.locator('#file');
    await fileInput.setInputFiles(filePath);

    // Verify label updated
    await expect(page.locator('#drop-zone span')).toHaveText('hello.txt');

    // Submit
    await page.click('button[type="submit"]');

    // Wait for result
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expect(page.locator('[data-result]')).toContainText('hello.txt');

    // Get the download page link
    const downloadLink = page.locator('[data-result] a').first();
    const href = await downloadLink.getAttribute('href');
    expect(href).toBeTruthy();
    // Page URL should be the short /<code> form (no filename)
    expect(href!).not.toContain('hello.txt');

    // Get the raw URL directly from the second copy input in the result block
    const inputs = page.locator('[data-result] .link-row input');
    const rawLink = await inputs.nth(1).inputValue();
    expect(rawLink).toContain('/raw/');
    expect(rawLink.endsWith('/hello.txt')).toBe(true);

    // Visit download page
    await page.goto(href!);
    await expect(page.locator('body')).toContainText('hello.txt');

    // Download raw file and verify contents
    const response = await page.request.get(rawLink);
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toBe('hello from playwright');
  });

  test('upload with custom filename', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'original.txt');
    writeFileSync(filePath, 'content');

    await page.locator('#file').setInputFiles(filePath);
    await page.fill('#filename', 'renamed.txt');
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
    await expect(page.locator('[data-result]')).toContainText('renamed.txt');
  });

  test('upload with expiry', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'expiry.txt');
    writeFileSync(filePath, 'expires soon');

    await page.locator('#file').setInputFiles(filePath);
    await page.selectOption('#expiry', '30m');
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');
  });
});
