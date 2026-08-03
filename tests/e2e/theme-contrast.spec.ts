import { test, expect, Page } from '@playwright/test';

// The token-level contrast spec lives in tests/unit/contrast.test.mjs. This
// checks the same property one layer out: what the browser actually computes
// after the cascade resolves light-dark(), color-mix(), and every override.
// A token can be correct while a rule still paints the wrong pair.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Accepts the "rgb(r, g, b)" / "rgba(r, g, b, a)" that getComputedStyle returns.
function luminance(color: string): number {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) {
    throw new Error(`could not parse colour: ${color}`);
  }
  const [r, g, b] = parts.slice(0, 3).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

async function computed(page: Page, selector: string, prop: string): Promise<string> {
  return page.evaluate(
    ([sel, name]) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(name),
    [selector, prop] as const,
  );
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('the submit button label is readable against its fill', async ({ page }) => {
      await page.goto('/');
      const button = 'button[type="submit"]';
      const fg = await computed(page, button, 'color');
      const bg = await computed(page, button, 'background-color');
      const ratio = contrast(fg, bg);
      expect(
        ratio,
        `${colorScheme}: submit label ${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    // The reported bug: dark-mode hover lightened the fill toward the white
    // label, dropping contrast from 2.41:1 to 1.87:1.
    test('hovering the submit button does not reduce contrast', async ({ page }) => {
      await page.goto('/');
      const button = page.locator('button[type="submit"]');
      const restFg = await computed(page, 'button[type="submit"]', 'color');
      const restBg = await computed(page, 'button[type="submit"]', 'background-color');
      const rest = contrast(restFg, restBg);

      await button.hover();
      const hoverFg = await computed(page, 'button[type="submit"]', 'color');
      const hoverBg = await computed(page, 'button[type="submit"]', 'background-color');
      const hover = contrast(hoverFg, hoverBg);

      expect(
        hover,
        `${colorScheme}: hover moved ${rest.toFixed(2)}:1 -> ${hover.toFixed(2)}:1 ` +
          `(${hoverFg} on ${hoverBg})`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(hover).toBeGreaterThanOrEqual(rest - 0.01);
    });

    test('the selected mode tab is readable', async ({ page }) => {
      await page.goto('/');
      const tab = '.mode-tab[aria-selected="true"]';
      const fg = await computed(page, tab, 'color');
      const bg = await computed(page, tab, 'background-color');
      const ratio = contrast(fg, bg);
      expect(
        ratio,
        `${colorScheme}: selected tab ${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    test('body text is readable on the page background', async ({ page }) => {
      await page.goto('/');
      const fg = await computed(page, 'body', 'color');
      const bg = await computed(page, 'body', 'background-color');
      const ratio = contrast(fg, bg);
      expect(ratio, `${colorScheme}: body ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  });
}
