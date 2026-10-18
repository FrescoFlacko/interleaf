import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, PALETTE_IDS } from '../../src/shared/constants/palettes';
import { paletteInfo } from '../../src/shared/constants/palette-lookup';
import { PALETTE_TOKENS, paletteCssVariables } from '../../src/shared/constants/palette-tokens';
import { isDarkColor, parseCssColor } from '../../src/shared/constants/palette-color';

const STYLES = resolve(__dirname, '../../src/renderer/styles');
const tokensCss = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8');
const globalCss = readFileSync(resolve(STYLES, 'global.css'), 'utf8');

function firstRootBlock(css: string): string {
  const match = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  expect(match, 'tokens.css declares a :root block').not.toBeNull();
  return match?.[1] ?? '';
}

describe('pre-hydration palette in tokens.css', () => {
  it('equals the default palette from the token table', () => {
    const declared: Record<string, string> = {};
    for (const [, name, value] of firstRootBlock(tokensCss).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      declared[name!] = value!.trim();
    }
    expect(declared).toEqual({ ...paletteCssVariables(DEFAULT_PALETTE) });
  });

  it('keeps palette colours out of the stylesheets', () => {
    expect(globalCss).not.toMatch(/\[data-theme=["']?[a-z-]+["']?\]\s*\{/);
    expect(globalCss).not.toMatch(/data-reader-background=/);
  });
});

describe('isDarkColor (paginator reader appearance)', () => {
  it.each(PALETTE_IDS)('classifies %s by its reader background luminance', (id) => {
    expect(isDarkColor(PALETTE_TOKENS[id]['bg-reader'])).toBe(paletteInfo(id).appearance === 'dark');
  });

  it('reads computed rgb() values, not only hex literals', () => {
    expect(isDarkColor('rgb(17, 17, 17)')).toBe(true);
    expect(isDarkColor('rgba(250, 250, 250, 1)')).toBe(false);
    expect(isDarkColor('#123')).toBe(true);
  });

  it('treats an unparseable colour as light', () => {
    expect(parseCssColor('transparent')).toBeNull();
    expect(isDarkColor('transparent')).toBe(false);
    expect(isDarkColor('')).toBe(false);
  });
});
