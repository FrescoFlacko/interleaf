import type { PaletteId } from '@shared/constants/palettes';
import { paletteInfo } from '@shared/constants/palette-lookup';
import { paletteCssVariables } from '@shared/constants/palette-tokens';

/**
 * Applies a palette to the document root: every token as a custom property,
 * plus `data-theme`, `data-appearance` and `color-scheme`, so native
 * scrollbars and form chrome follow the palette's appearance. The values come
 * from the typed token table, never from document content. CSSOM property
 * writes are not inline-style markup, so the renderer CSP is unaffected.
 *
 * `data-theme` is written last: the reader adapters observe that attribute and
 * re-read the computed tokens, which must already be in place.
 */
export function applyPalette(palette: PaletteId, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(paletteCssVariables(palette))) {
    root.style.setProperty(name, value);
  }
  const appearance = paletteInfo(palette).appearance;
  root.style.colorScheme = appearance;
  root.dataset.appearance = appearance;
  root.dataset.theme = palette;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => object;
};

/**
 * Applies a palette with a short root cross-fade when the platform supports
 * view transitions and the reader has not asked for reduced motion. The whole
 * palette is applied inside one update, so no frame shows a half-applied
 * palette. The first application (no `data-theme` yet) is never animated, nor
 * is a hidden document, where the update would wait for a frame that the
 * throttled window may not paint.
 */
export function applyPaletteWithTransition(palette: PaletteId): void {
  const doc = document as ViewTransitionDocument;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = doc.visibilityState === 'visible' && doc.documentElement.dataset.theme !== undefined
    && doc.documentElement.dataset.theme !== palette;
  if (reduced || !animate || typeof doc.startViewTransition !== 'function') {
    applyPalette(palette);
    return;
  }
  doc.startViewTransition(() => {
    applyPalette(palette);
  });
}
