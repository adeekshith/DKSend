import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test.describe('delete link flow', () => {
  test('upload, then delete via the confirm page', async ({ page }) => {
    await page.goto('/');

    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'doomed.txt');
    writeFileSync(filePath, 'short-lived content');

    await page.locator('#file').setInputFiles(filePath);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    // Grab the page and delete URLs from the result inputs
    const inputs = page.locator('[data-result] .link-row input');
    const pageUrl = await inputs.nth(0).inputValue();
    const deleteUrl = await inputs.nth(3).inputValue();
    expect(deleteUrl).toContain('/delete/');
    expect(deleteUrl).toContain('token=');

    // The confirm page shows the file and a delete button; nothing is
    // deleted by the GET itself
    await page.goto(deleteUrl);
    await expect(page.locator('body')).toContainText('doomed.txt');
    let response = await page.request.get(pageUrl);
    expect(response.status()).toBe(200);

    // Confirm deletion
    await page.click('button[type="submit"]');
    await expect(page.locator('body')).toContainText('File deleted.');

    // The share link is gone now
    response = await page.request.get(pageUrl);
    expect(response.status()).toBe(404);
  });

  test('delete via the API with curl-style DELETE', async ({ page, request }) => {
    await page.goto('/');

    const upload = await request.put('/?name=api-victim.txt', {
      data: 'delete me via api',
    });
    expect(upload.status()).toBe(201);
    const data = await upload.json();

    // Wrong token is rejected
    let response = await request.delete(`/${data.code}?token=wrong`);
    expect(response.status()).toBe(403);

    // Correct token deletes
    response = await request.delete(`/${data.code}?token=${data.delete_token}`);
    expect(response.status()).toBe(200);

    response = await request.get(data.raw_download_url);
    expect(response.status()).toBe(404);
  });
});
