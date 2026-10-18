// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPalette, applyPaletteWithTransition } from '../../src/renderer/styles/apply-palette';
import { PALETTE_IDS } from '@shared/constants/palettes';
import { paletteInfo } from '@shared/constants/palette-lookup';
import { paletteCssVariables } from '@shared/constants/palette-tokens';

/** jsdom has no View Transitions API; tests install and remove a stand-in. */
function installTransition(start: (update: () => void) => object): void {
  Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true });
}

function reset(): void {
  const root = document.documentElement;
  root.removeAttribute('style');
  delete root.dataset.theme;
  delete root.dataset.appearance;
  Reflect.deleteProperty(document, 'startViewTransition');
}

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query }));
}

afterEach(() => {
  reset();
  vi.unstubAllGlobals();
});

describe('applyPalette', () => {
  it.each(PALETTE_IDS)('writes every %s token, the appearance and colour scheme to the root', (id) => {
    applyPalette(id);
    const root = document.documentElement;
    for (const [name, value] of Object.entries(paletteCssVariables(id))) {
      expect(root.style.getPropertyValue(name), name).toBe(value);
    }
    const appearance = paletteInfo(id).appearance;
    expect(root.dataset.theme).toBe(id);
    expect(root.dataset.appearance).toBe(appearance);
    expect(root.style.colorScheme).toBe(appearance);
  });

  it('replaces every value when switching palettes', () => {
    applyPalette('paper');
    applyPalette('midnight');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--bg-primary')).toBe(paletteCssVariables('midnight')['--bg-primary']);
    expect(root.dataset.appearance).toBe('dark');
  });
});

describe('applyPaletteWithTransition', () => {
  it('cross-fades a palette change when view transitions are available', () => {
    stubReducedMotion(false);
    applyPalette('paper');
    const start = vi.fn((update: () => void) => {
      update();
      return {};
    });
    installTransition(start);
    applyPaletteWithTransition('graphite');
    expect(start).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('applies instantly under reduced motion', () => {
    stubReducedMotion(true);
    applyPalette('paper');
    const start = vi.fn(() => ({}));
    installTransition(start);
    applyPaletteWithTransition('graphite');
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('never animates the first application or an unchanged palette', () => {
    stubReducedMotion(false);
    const start = vi.fn(() => ({}));
    installTransition(start);
    applyPaletteWithTransition('sepia');
    applyPaletteWithTransition('sepia');
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('sepia');
  });

  it('falls back to an instant change without the View Transitions API', () => {
    stubReducedMotion(false);
    applyPalette('paper');
    applyPaletteWithTransition('ink');
    expect(document.documentElement.dataset.theme).toBe('ink');
  });
});
