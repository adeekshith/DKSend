import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('keyboard access', () => {
  // The file input was display:none, which removes an element from the tab
  // order and the accessibility tree outright. Clicking the label worked, so
  // the bug was invisible to mouse users while keyboard users had no way to
  // open the file picker at all.
  test('the file input is reachable by keyboard', async ({ page }) => {
    await page.goto('/');

    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await page.evaluate(() => document.activeElement?.id)) === 'file';
    }
    expect(reached, 'Tab must be able to reach #file').toBe(true);
  });

  test('focusing the file input shows a ring on the drop zone', async ({ page }) => {
    await page.goto('/');
    // Keyboard focus, not .focus(), so :focus-visible actually matches.
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await page.evaluate(() => document.activeElement?.id)) === 'file';
    }
    expect(reached).toBe(true);

    const outline = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#drop-zone')!);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width, 'the invisible input needs its label to show focus')
      .toBeGreaterThan(0);
  });

  test('the file input still accepts files', async ({ page }) => {
    // Guards the visually-hidden swap: hidden must not mean non-functional.
    const dir = mkdtempSync(join(tmpdir(), 'dksend-a11y-'));
    const file = join(dir, 'keyboard.txt');
    writeFileSync(file, 'still works');
    await page.goto('/');
    await page.locator('#file').setInputFiles(file);
    await expect(page.locator('#drop-zone span')).toHaveText('keyboard.txt');
  });

  test('the text field has an accessible name', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-mode-set="text"]').click();
    // getByLabel only resolves if the field has a real label association; a
    // placeholder alone would not satisfy this.
    await expect(page.getByLabel('Text to share')).toBeVisible();
  });
});
