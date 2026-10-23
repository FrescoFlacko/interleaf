import { DARK_PALETTE_TOKENS } from './palette-tokens-dark';
import { LIGHT_PALETTE_TOKENS } from './palette-tokens-light';
import { PALETTE_COLOR_TOKENS, type PaletteTokens } from './palette-token-types';
import { parseCssColor, toRgba } from './palette-color';
import type { PaletteAppearance, PaletteId } from './palettes';
import { paletteInfo } from './palette-lookup';
import { noteCssVariables } from './palette-note-tokens';

/** Every palette's tokens. Typed by id, so a missing palette is a compile error. */
export const PALETTE_TOKENS: Readonly<Record<PaletteId, PaletteTokens>> = {
  ...LIGHT_PALETTE_TOKENS,
  ...DARK_PALETTE_TOKENS,
};

type CssVariableName = `--${string}`;
export type CssVariables = Readonly<Record<CssVariableName, string>>;

function translucentAccent(tokens: PaletteTokens, alpha: number): string {
  const accent = parseCssColor(tokens.accent);
  return accent === null ? tokens.selection : toRgba(accent, alpha);
}

/** Elevation is defined per appearance: dark surfaces need a deeper shadow. */
const SHADOWS: Readonly<Record<PaletteAppearance, { readonly popover: string; readonly dialog: string }>> = {
  light: {
    popover: '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)',
    dialog: '0 24px 64px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.08)',
  },
  dark: {
    popover: '0 8px 24px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)',
    dialog: '0 24px 64px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0, 0, 0, 0.45)',
  },
};

/**
 * The complete custom-property set for one palette: the explicit tokens plus
 * the values derived from them (translucent paints, status-fill text colours,
 * the warning border and elevation). Status fills take white on light palettes
 * and the palette's own darkest surface on dark ones; both clear 7:1.
 */
export function paletteCssVariables(id: PaletteId): CssVariables {
  const tokens = PALETTE_TOKENS[id];
  const appearance = paletteInfo(id).appearance;
  const variables: Record<CssVariableName, string> = {};
  for (const name of PALETTE_COLOR_TOKENS) variables[`--${name}`] = tokens[name];
  const onStatus = appearance === 'dark' ? tokens['bg-primary'] : '#ffffff';
  variables['--selection-translucent'] = translucentAccent(tokens, tokens.selectionAlpha);
  variables['--note-translucent'] = translucentAccent(tokens, tokens.noteAlpha);
  variables['--warning-border'] = tokens.danger;
  variables['--on-danger'] = onStatus;
  variables['--on-success'] = onStatus;
  variables['--on-warning'] = onStatus;
  variables['--elevation-popover'] = SHADOWS[appearance].popover;
  variables['--elevation-dialog'] = SHADOWS[appearance].dialog;
  Object.assign(variables, noteCssVariables(id, tokens, appearance));
  return variables;
}

/**
 * Overrides applied to `.reader-surface` when the reader background is set to
 * a specific palette instead of following the app palette. Derived from the
 * same table so every palette is a complete foreground/background pair.
 */
export function readerBackgroundVariables(id: PaletteId): CssVariables {
  const tokens = PALETTE_TOKENS[id];
  return {
    '--reader-background-override': tokens['bg-reader'],
    '--reader-foreground-override': tokens['text-primary'],
    '--reader-selection-override': translucentAccent(tokens, tokens.selectionAlpha),
    '--note-translucent': translucentAccent(tokens, tokens.noteAlpha),
    '--search-mark': tokens['search-mark'],
  };
}
