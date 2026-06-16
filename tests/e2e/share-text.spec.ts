import { test, expect } from '@playwright/test';

test.describe('share text', () => {
  test('type text, share it, read it inline on the download page', async ({ page }) => {
    await page.goto('/');

    // Switch to Text mode; the drop zone hides, the textarea shows
    await page.click('[data-mode-set="text"]');
    await expect(page.locator('#text-input')).toBeVisible();
    await expect(page.locator('#drop-zone')).toBeHidden();

    const note = 'shared via text mode\nsecond line with <b>markup</b>';
    await page.fill('#text-input', note);
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    // Open the download page from the result link
    const href = await page.locator('[data-result] a').first().getAttribute('href');
    await page.goto(href!);

    // The text renders inline, with markup shown literally (escaped), not parsed
    const pre = page.locator('#file-contents');
    await expect(pre).toBeVisible();
    await expect(pre).toContainText('shared via text mode');
    await expect(pre).toContainText('<b>markup</b>');

    // The inline copy control is present
    await expect(page.locator('[data-copy-from="#file-contents"]')).toBeVisible();
  });

  test('text mode upload is fetchable as a plain file too', async ({ page }) => {
    await page.goto('/');
    await page.click('[data-mode-set="text"]');
    await page.fill('#text-input', 'plain body check');
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    const inputs = page.locator('[data-result] .link-row input');
    const rawUrl = await inputs.nth(1).inputValue();
    const response = await page.request.get(rawUrl);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('plain body check');
  });
});
