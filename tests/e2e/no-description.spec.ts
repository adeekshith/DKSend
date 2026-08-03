import { test, expect } from '@playwright/test';

// BRAND_DESCRIPTION is optional and this server does not set one, so these
// assert the unset case leaves no trace at all: not an empty element, and not
// the space an element would have occupied. Omitting the <p> is not enough on
// its own — the heading's bottom margin applied whether or not anything
// followed it, so an unconfigured instance still paid for a tagline it did not
// have.

test.describe('with no BRAND_DESCRIPTION set', () => {
  test('the hero renders no description element', async ({ page }) => {
    await page.goto('/');
    expect(await page.locator('.hero p').count(), 'no empty paragraph').toBe(0);
  });

  test('the hero reserves no vertical space for a description', async ({ page }) => {
    await page.goto('/');
    const box = await page.evaluate(() => {
      const hero = document.querySelector('.hero')!.getBoundingClientRect();
      const h1 = document.querySelector('.hero h1')!.getBoundingClientRect();
      return { heroHeight: hero.height, headingHeight: h1.height };
    });
    // The heading is the hero's only child, so the hero must be exactly as
    // tall as it — any surplus is space held for something that isn't there.
    expect(
      box.heroHeight - box.headingHeight,
      `hero is ${box.heroHeight}px for a ${box.headingHeight}px heading`,
    ).toBeLessThanOrEqual(1);
  });

  test('the gap below the heading matches the gap above the card', async ({ page }) => {
    await page.goto('/');
    // .shell owns the rhythm between sections. With no description, the space
    // under the heading should be that gap and nothing more.
    const gap = await page.evaluate(() => {
      const h1 = document.querySelector('.hero h1')!.getBoundingClientRect();
      const card = document.querySelector('.card')!.getBoundingClientRect();
      const shellGap = parseFloat(getComputedStyle(document.querySelector('.shell')!).rowGap);
      return { measured: card.top - h1.bottom, shellGap };
    });
    expect(
      gap.measured,
      `expected the ${gap.shellGap}px shell gap, measured ${gap.measured}px`,
    ).toBeCloseTo(gap.shellGap, 0);
  });
});
