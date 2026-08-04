// Executable contrast spec for the design tokens in static/app.css.
//
// The dark-mode button bug this guards against was not a typo: --accent-dark
// served as both a hover *background* and as link *text*, roles that need
// opposite lightness per scheme. Keeping it readable as text made buttons
// unreadable (white on #93c0ff = 1.87:1). A ratio asserted in a test cannot
// drift back, so every pairing the design relies on is checked here in both
// schemes rather than eyeballed once.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../static/app.css', import.meta.url), 'utf8');
// Comments explain *why* tokens changed and legitimately name retired ones, so
// checks for stale usage run against the stripped stylesheet.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

// --- token parsing -------------------------------------------------------
// Reads the :root block into { name: { light, dark } }. light-dark(a, b) takes
// its light value first; a plain value is the same in both schemes.
function parseTokens(source) {
  const root = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(root, ':root block must be present');
  const tokens = {};
  for (const line of root[1].split('\n')) {
    const decl = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/);
    if (!decl) continue;
    const [, name, value] = decl;
    const pair = value.match(/^light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)$/);
    if (pair) {
      tokens[name] = { light: pair[1], dark: pair[2] };
    } else if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      tokens[name] = { light: value, dark: value };
    }
  }
  return tokens;
}

const tokens = parseTokens(css);

// --- WCAG 2.1 relative luminance and contrast ---------------------------
function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG 1.4.3 wants 4.5:1 for normal-size text; 1.4.11 wants 3:1 for the
// boundary of a UI component.
const TEXT = 4.5;
const UI = 3;

// Each entry is [description, foreground token, background token, threshold].
const PAIRINGS = [
  ['primary button label', '--on-accent', '--accent', TEXT],
  ['primary button label on hover', '--on-accent', '--accent-hover', TEXT],
  ['body text on the page', '--ink', '--bg', TEXT],
  ['body text on a card', '--ink', '--card', TEXT],
  ['secondary text on a card', '--muted', '--card', TEXT],
  ['secondary text on the page', '--muted', '--bg', TEXT],
  ['link text on a card', '--link', '--card', TEXT],
  ['link text on the page', '--link', '--bg', TEXT],
  ['code text in a code block', '--code-ink', '--code-bg', TEXT],
  ['field text on its own fill', '--ink', '--field-bg', TEXT],
  ['placeholder text on a field', '--muted', '--field-bg', TEXT],
  // Control boundaries: a field or drop zone the user cannot see is a field
  // the user cannot find.
  ['a field border against its fill', '--stroke-strong', '--field-bg', UI],
  ['a field border against the card', '--stroke-strong', '--card', UI],
  ['a secondary button border', '--stroke-strong', '--card', UI],
  // The ring is offset onto the card, never inset over the button fill, so
  // this is the pairing that matters.
  ['the focus ring against a card', '--ring', '--card', UI],
  ['the focus ring against the page', '--ring', '--bg', UI],
  // Destructive and cautionary states.
  ['a destructive button label', '--on-accent', '--danger', TEXT],
  ['a destructive button label on hover', '--on-accent', '--danger-hover', TEXT],
  ['error text on a card', '--danger-ink', '--card', TEXT],
  ['caution text on a card', '--warn-ink', '--card', TEXT],
];

describe('design token contrast', () => {
  for (const scheme of ['light', 'dark']) {
    describe(scheme, () => {
      for (const [what, fgName, bgName, threshold] of PAIRINGS) {
        it(`${what} clears ${threshold}:1`, () => {
          const fg = tokens[fgName];
          const bg = tokens[bgName];
          assert.ok(fg, `${fgName} must be defined`);
          assert.ok(bg, `${bgName} must be defined`);
          const ratio = contrast(fg[scheme], bg[scheme]);
          assert.ok(
            ratio >= threshold,
            `${what} in ${scheme}: ${fg[scheme]} on ${bg[scheme]} is ` +
              `${ratio.toFixed(2)}:1, needs ${threshold}:1`,
          );
        });
      }
    });
  }

  // The whole point of the split: a hover background must move *away* from the
  // label colour, never toward it. Before the fix, dark-mode hover lightened
  // toward white text and contrast fell from 2.41:1 to 1.87:1.
  it('hovering a primary button never reduces its contrast', () => {
    for (const scheme of ['light', 'dark']) {
      const rest = contrast(tokens['--on-accent'][scheme], tokens['--accent'][scheme]);
      const hover = contrast(tokens['--on-accent'][scheme], tokens['--accent-hover'][scheme]);
      assert.ok(
        hover >= rest,
        `${scheme}: hover drops contrast from ${rest.toFixed(2)}:1 to ${hover.toFixed(2)}:1`,
      );
    }
  });

  it('has no --accent-dark left, which conflated background and text roles', () => {
    assert.ok(!code.includes('--accent-dark'), 'replaced by --accent-hover and --link');
  });

  it('never hardcodes a button label colour', () => {
    // A literal #fff on an accent fill is how the label escaped the contrast
    // budget in the first place; it must come from --on-accent.
    const offenders = code
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /^\s*color:\s*(#fff|#ffffff|white)\s*;/i.test(line));
    assert.deepEqual(offenders, [], `use var(--on-accent) instead: ${JSON.stringify(offenders)}`);
  });
});
