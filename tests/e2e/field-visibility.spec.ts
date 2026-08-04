import { test, expect, Page } from '@playwright/test';

// Form fields used a hairline border in --stroke, which measured 1.24:1 against
// the card in dark mode and 1.44:1 in light. Both are far under the 3:1 WCAG
// 1.4.11 asks of a control boundary, so the inputs barely read as inputs. These
// check the rendered result rather than the token, since a fill and a border
// interact after the cascade resolves.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(color: string): number {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) throw new Error(`could not parse colour: ${color}`);
  const [r, g, b] = parts.slice(0, 3).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

async function styles(page: Page, selector: string, props: string[]): Promise<string[]> {
  return page.evaluate(
    ([sel, names]) => {
      const cs = getComputedStyle(document.querySelector(sel)!);
      return names.map((n) => cs.getPropertyValue(n));
    },
    [selector, props] as const,
  );
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('a text field border is visible against the card', async ({ page }) => {
      await page.goto('/');
      const [border] = await styles(page, '#filename', ['border-top-color']);
      const [card] = await styles(page, '.card', ['background-color']);
      const ratio = contrast(border, card);
      expect(
        ratio,
        `${colorScheme}: field border ${border} on card ${card} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    });

    test('a text field has a fill distinct from the card', async ({ page }) => {
      await page.goto('/');
      const [field] = await styles(page, '#filename', ['background-color']);
      const [card] = await styles(page, '.card', ['background-color']);
      expect(field, 'fields need their own fill, not a transparent one').not.toBe(card);
      // Text typed into the field still has to be readable on that fill.
      const [ink] = await styles(page, '#filename', ['color']);
      expect(contrast(ink, field)).toBeGreaterThanOrEqual(4.5);
    });

    test('the drop zone border is visible', async ({ page }) => {
      await page.goto('/');
      const [border, width] = await styles(page, '#drop-zone', [
        'border-top-color',
        'border-top-width',
      ]);
      const [card] = await styles(page, '.card', ['background-color']);
      expect(contrast(border, card)).toBeGreaterThanOrEqual(3);
      expect(parseFloat(width), 'the primary affordance deserves more than a hairline')
        .toBeGreaterThanOrEqual(2);
    });

    test('focusing a field shows a ring', async ({ page }) => {
      await page.goto('/');
      await page.locator('#filename').focus();
      const [style, width] = await styles(page, '#filename', ['outline-style', 'outline-width']);
      expect(style).not.toBe('none');
      expect(parseFloat(width)).toBeGreaterThan(0);
    });

    test('the textarea matches the other fields', async ({ page }) => {
      await page.goto('/');
      await page.locator('[data-mode-set="text"]').click();
      const [taRadius, taBorder] = await styles(page, '#text-input', [
        'border-top-left-radius',
        'border-top-color',
      ]);
      const [inRadius, inBorder] = await styles(page, '#filename', [
        'border-top-left-radius',
        'border-top-color',
      ]);
      expect(taRadius, 'textarea kept the UA radius').toBe(inRadius);
      expect(taBorder, 'textarea kept the UA border colour').toBe(inBorder);
    });
  });
}
