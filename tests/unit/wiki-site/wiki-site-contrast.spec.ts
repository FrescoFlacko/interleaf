import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const stylesheet = fileURLToPath(new URL('../../../wiki-site/styles.css', import.meta.url));

/** Custom properties of one theme block, keyed by name without the `--`. */
function themeVariables(css: string, blockStart: string): Map<string, string> {
  const start = css.indexOf(blockStart);
  expect(start, blockStart).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('}', start));
  const variables = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/giu)) {
    if (name !== undefined && value !== undefined) variables.set(name, value);
  }
  return variables;
}

function relativeLuminance(colour: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(colour.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const backgrounds = ['paper', 'paper-raised', 'paper-sunken'];
const foregrounds = ['ink', 'ink-soft', 'ink-faint', 'accent-ink'];

describe('text contrast', () => {
  it('computes known WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it.each([
    ['light', ':root {'],
    ['dark', '@media (prefers-color-scheme: dark) {'],
  ])('keeps %s theme body text at AA on every surface', async (_theme, blockStart) => {
    const css = await readFile(stylesheet, 'utf8');
    const variables = themeVariables(css, blockStart);
    for (const foreground of foregrounds) {
      for (const background of backgrounds) {
        const ink = variables.get(foreground);
        const surface = variables.get(background);
        expect(ink, foreground).toBeDefined();
        expect(surface, background).toBeDefined();
        const ratio = contrastRatio(ink ?? '', surface ?? '');
        expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
