import { describe, expect, it } from 'vitest';
import { PALETTE_IDS, PALETTES, type PaletteId } from '../../src/shared/constants/palettes';
import { PALETTE_TOKENS, paletteCssVariables, readerBackgroundVariables } from '../../src/shared/constants/palette-tokens';
import { PALETTE_COLOR_TOKENS } from '../../src/shared/constants/palette-token-types';
import { compositeOver, contrastRatio, parseCssColor, type Rgb } from '../../src/shared/constants/palette-color';

/**
 * Token-level contrast targets (docs/UX_SPEC.md §2, audit §4). These are
 * computed guarantees for the palette table, a mitigation toward the AAA 7:1
 * body-text target; they are not a WCAG conformance claim for rendered UI.
 */

const SURFACES = ['bg-primary', 'bg-surface', 'bg-surface-elevated', 'bg-reader'] as const;
const CHROME_SURFACES = ['bg-primary', 'bg-surface', 'bg-surface-elevated'] as const;

function rgb(value: string | undefined, label: string): Rgb {
  const parsed = parseCssColor(value ?? '');
  expect(parsed, `${label} is a parseable colour (${String(value)})`).not.toBeNull();
  return parsed ?? [0, 0, 0];
}

function variable(id: PaletteId, name: string): string {
  const value = paletteCssVariables(id)[`--${name}`];
  expect(value, `${id} defines --${name}`).toBeDefined();
  return value ?? '';
}

function ratio(id: PaletteId, foreground: string, background: string): number {
  return contrastRatio(rgb(variable(id, foreground), `${id} ${foreground}`), rgb(variable(id, background), `${id} ${background}`));
}

function alphaOf(value: string): number {
  return Number.parseFloat(/rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(value)?.[1] ?? '1');
}

describe('palette table', () => {
  it('has at least 20 unique palettes covering both appearances', () => {
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PALETTE_IDS).size).toBe(PALETTE_IDS.length);
    expect(new Set(PALETTES.map((info) => info.id))).toEqual(new Set(PALETTE_IDS));
    expect(PALETTES.length).toBe(PALETTE_IDS.length);
    expect(PALETTES.some((info) => info.appearance === 'light')).toBe(true);
    expect(PALETTES.some((info) => info.appearance === 'dark')).toBe(true);
  });

  it('keeps the six original palette ids valid for stored settings', () => {
    for (const legacy of ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight']) {
      expect(PALETTE_IDS).toContain(legacy);
    }
  });

  it('gives every palette every token as an opaque colour, with a label and mood', () => {
    for (const info of PALETTES) {
      expect(info.label.length, `${info.id} label`).toBeGreaterThan(0);
      expect(info.mood.length, `${info.id} mood`).toBeGreaterThan(0);
      const tokens = PALETTE_TOKENS[info.id];
      for (const name of PALETTE_COLOR_TOKENS) {
        expect(tokens[name], `${info.id} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('keeps every pair of palettes visibly distinct in background plus accent', () => {
    // Summed RGB distance of bg-primary and accent; the closest designed pair
    // (birch / fjord) sits at ~31, so 24 leaves margin while catching duplicates.
    const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const [index, first] of PALETTE_IDS.entries()) {
      for (const second of PALETTE_IDS.slice(index + 1)) {
        const total =
          distance(rgb(PALETTE_TOKENS[first]['bg-primary'], first), rgb(PALETTE_TOKENS[second]['bg-primary'], second)) +
          distance(rgb(PALETTE_TOKENS[first].accent, first), rgb(PALETTE_TOKENS[second].accent, second));
        expect(total, `${first} vs ${second}`).toBeGreaterThanOrEqual(24);
      }
    }
  });
});

describe.each(PALETTE_IDS)('palette %s contrast targets', (id) => {
  it('keeps body and secondary text at 7:1 on every background', () => {
    for (const foreground of ['text-primary', 'text-secondary']) {
      for (const background of SURFACES) {
        expect(ratio(id, foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it('keeps accent text at 7:1 on the page and 4.5:1 on raised surfaces', () => {
    expect(ratio(id, 'accent', 'bg-primary')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'accent', 'bg-reader')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'accent', 'bg-surface')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(id, 'accent', 'bg-surface-elevated')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps status text at 7:1 on the page and 4.5:1 elsewhere', () => {
    for (const status of ['danger', 'success', 'warning']) {
      expect(ratio(id, status, 'bg-primary'), `${status} on bg-primary`).toBeGreaterThanOrEqual(7);
      for (const background of SURFACES) {
        expect(ratio(id, status, background), `${status} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps labels on solid fills at 7:1', () => {
    expect(ratio(id, 'on-accent', 'accent')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'on-danger', 'danger')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'on-success', 'success')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'on-warning', 'warning')).toBeGreaterThanOrEqual(7);
  });

  it('keeps text at 7:1 on muted accent, selection and search marks', () => {
    expect(ratio(id, 'text-primary', 'accent-muted')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'text-primary', 'selection')).toBeGreaterThanOrEqual(7);
    expect(ratio(id, 'text-primary', 'search-mark')).toBeGreaterThanOrEqual(7);
  });

  it('keeps text at 7:1 on translucent selection and note paint composited over the page', () => {
    const page = rgb(variable(id, 'bg-reader'), 'bg-reader');
    const text = rgb(variable(id, 'text-primary'), 'text-primary');
    const accent = rgb(variable(id, 'accent'), 'accent');
    for (const paint of ['selection-translucent', 'note-translucent']) {
      const composited = compositeOver(accent, alphaOf(variable(id, paint)), page);
      expect(contrastRatio(text, composited), paint).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps focus ring and control borders at 3:1 against chrome surfaces', () => {
    for (const background of CHROME_SURFACES) {
      expect(ratio(id, 'focus-ring', background), `focus-ring on ${background}`).toBeGreaterThanOrEqual(3);
      expect(ratio(id, 'border-strong', background), `border-strong on ${background}`).toBeGreaterThanOrEqual(3);
      expect(ratio(id, 'warning-border', background), `warning-border on ${background}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives the independent reader background a complete accessible pair', () => {
    const reader = readerBackgroundVariables(id);
    const background = rgb(reader['--reader-background-override'], 'reader background');
    const foreground = rgb(reader['--reader-foreground-override'], 'reader foreground');
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(foreground, rgb(reader['--search-mark'], 'reader search mark'))).toBeGreaterThanOrEqual(7);
  });
});
