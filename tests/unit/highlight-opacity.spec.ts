// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIGHLIGHT_RGBA,
  HIGHLIGHT_COLOR_CONFIGS,
  HIGHLIGHT_COLOR_OPTIONS,
} from '../../src/shared/constants/annotations';
import { HIGHLIGHT_COLORS } from '../../src/shared/types/annotation';
import { PALETTE_IDS, type PaletteId } from '../../src/shared/constants/palettes';
import { paletteCssVariables, readerBackgroundVariables } from '../../src/shared/constants/palette-tokens';
import { Overlayer } from '../../src/renderer/features/reader/adapters/foliate/overlayer';

const css = readFileSync('src/renderer/styles/global.css', 'utf8');

describe('Defect 08: Highlight selection and color opacity', () => {
  it('defines semantic translucent selection tokens for every reading palette', () => {
    for (const palette of PALETTE_IDS) {
      const tokens = readPaletteTokens(palette);
      expect(tokens.selection, `${palette} missing --selection`).toBeDefined();
      expect(tokens['selection-translucent'], `${palette} missing --selection-translucent`).toBeDefined();

      const translucentValue = tokens['selection-translucent'] ?? '';
      const rgbaMatch = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(translucentValue);
      expect(rgbaMatch, `${palette} --selection-translucent should be rgba`).not.toBeNull();
      const alpha = Number.parseFloat(rgbaMatch?.[4] ?? '1');
      expect(alpha, `${palette} selection alpha must be translucent (< 0.7)`).toBeLessThan(0.7);
      expect(alpha, `${palette} selection alpha must be visible (> 0.2)`).toBeGreaterThan(0.2);
    }
  });

  it('defines independent reader background selection override tokens', () => {
    for (const id of PALETTE_IDS) {
      const selectionOverride = readerBackgroundVariables(id)['--reader-selection-override'] ?? '';
      expect(selectionOverride, `reader background ${id} selection override`).toContain('rgba');
    }
  });

  it('configures PDF.js text layer selection with translucent fill and transparent text', () => {
    const textLayerBlock = /\.textLayer\s*::selection\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(textLayerBlock).toContain('var(--selection-translucent');
    expect(textLayerBlock).toContain('color: transparent');
  });

  it('configures reader-surface selection with translucent selection variable', () => {
    const readerSurfaceBlock = /\.reader-surface\s*::selection\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(readerSurfaceBlock).toContain('var(--selection-translucent');
  });

  it('centralizes 5 accessible translucent highlight colors', () => {
    expect(HIGHLIGHT_COLORS).toEqual(['yellow', 'blue', 'green', 'pink', 'purple']);
    expect(HIGHLIGHT_COLOR_OPTIONS).toHaveLength(5);

    for (const color of HIGHLIGHT_COLORS) {
      const config = HIGHLIGHT_COLOR_CONFIGS[color];
      expect(config).toBeDefined();
      expect(config.id).toBe(color);
      expect(config.label.length).toBeGreaterThan(0);

      const rgbaMatch = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(config.cssRgba);
      expect(rgbaMatch, `${color} highlight should use rgba`).not.toBeNull();
      const alpha = Number.parseFloat(rgbaMatch?.[4] ?? '1');
      expect(alpha, `${color} alpha must be translucent (< 0.6)`).toBeLessThan(0.6);
      expect(alpha, `${color} alpha must be visible (> 0.25)`).toBeGreaterThan(0.25);

      // The selection toolbar paints its swatches from `hexValue`, so each
      // color owes an opaque hex form of exactly the hue it paints on the page.
      // (This replaces assertions on `shortKey` and on a per-color utility
      // class that the production build never emitted, which could not have
      // failed when the toolbar rendered white circles.)
      expect(config.hexValue, `${color} needs an opaque hex swatch value`).toMatch(/^#[0-9a-f]{6}$/);
      expect(
        [1, 2, 3].map((group) => Number.parseInt(rgbaMatch?.[group] ?? '-1', 10)),
        `${color} swatch hue must match its document paint`
      ).toEqual([1, 3, 5].map((start) => Number.parseInt(config.hexValue.slice(start, start + 2), 16)));
    }
  });

  it('gives selection-toolbar swatches an unconditional boundary and a forced-colors fallback', () => {
    // A swatch is only readable if it cannot dissolve into the toolbar: pale
    // yellow on a white surface needs the boundary painted at all times, not on
    // hover or selection, and forced-colors must keep the fill rather than
    // flatten five circles into one system color.
    const swatch = /\.ml-highlight-swatch\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(swatch, 'missing .ml-highlight-swatch rule').not.toBe('');
    expect(swatch).toMatch(/border:\s*1px solid/);
    expect(swatch).toContain('box-shadow: inset');

    const forcedColorsBlocks = [...css.matchAll(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1] ?? '')
      .filter((block) => block.includes('.ml-highlight-swatch'));
    expect(forcedColorsBlocks, 'missing forced-colors rule for .ml-highlight-swatch').toHaveLength(1);
    expect(forcedColorsBlocks[0]).toContain('forced-color-adjust: none');
    expect(forcedColorsBlocks[0]).toContain('border-color: CanvasText');
  });

  it('renders foliate overlayer SVG highlights with centralized translucent color by default', () => {
    const dummyRect: DOMRect = {
      left: 10,
      top: 20,
      right: 110,
      bottom: 40,
      width: 100,
      height: 20,
      x: 10,
      y: 20,
      toJSON() { return {}; },
    };
    const element = Overlayer.highlight([dummyRect]);
    expect(element.getAttribute('fill')).toBe(DEFAULT_HIGHLIGHT_RGBA);
  });
});

function readPaletteTokens(palette: PaletteId): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paletteCssVariables(palette)).map(([name, value]) => [name.slice(2), value])
  );
}
