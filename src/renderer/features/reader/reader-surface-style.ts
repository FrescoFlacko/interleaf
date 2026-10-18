import type { CSSProperties } from 'react';
import type { PaletteId } from '@shared/constants/palettes';
import { paletteInfo } from '@shared/constants/palette-lookup';
import { paletteCssVariables, readerBackgroundVariables } from '@shared/constants/palette-tokens';

/**
 * Inline custom properties for `.reader-surface`. "Match theme" (`palette`)
 * sets nothing and inherits the app palette; an explicit reader background
 * applies that palette's reader pair from the typed token table.
 */
export function readerSurfaceStyle(background: 'palette' | PaletteId): CSSProperties | undefined {
  if (background === 'palette') return undefined;
  const style: Record<string, string> = { ...readerBackgroundVariables(background) };
  return style;
}

/**
 * Inline custom properties for the document region inside the reader surface:
 * the reader palette's complete semantic set, not only its page and body text.
 *
 * Headings, links, quotes, code and in-page controls are drawn with the
 * ordinary tokens (`text-primary`, `accent`, `bg-surface`…). Left on the app
 * palette, a dark app over a light reader page paints them dark on light and
 * near-invisible the other way round. Scoping the full set to this region pairs
 * every role with the page it sits on, while the reader toolbar and outline,
 * outside it, stay on the app palette. `color-scheme` follows so native
 * checkboxes and scrollbars match the page too.
 */
export function readerDocumentStyle(background: 'palette' | PaletteId): CSSProperties | undefined {
  if (background === 'palette') return undefined;
  const style: Record<string, string> = { ...paletteCssVariables(background), colorScheme: paletteInfo(background).appearance };
  return style;
}
