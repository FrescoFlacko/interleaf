/** Colour tokens every palette defines explicitly. */
export const PALETTE_COLOR_TOKENS = [
  'bg-primary',
  'bg-surface',
  'bg-surface-elevated',
  'bg-reader',
  'text-primary',
  'text-secondary',
  'border-subtle',
  'border-strong',
  'accent',
  'accent-muted',
  'selection',
  'focus-ring',
  'danger',
  'success',
  'warning',
  'on-accent',
  'search-mark',
] as const;

type PaletteColorToken = (typeof PALETTE_COLOR_TOKENS)[number];

/**
 * One palette's explicit values. The translucent selection and note paints are
 * the accent at these alphas; each alpha was chosen so `text-primary` keeps
 * 7:1 against the paint composited over `bg-reader`.
 */
export type PaletteTokens = Readonly<Record<PaletteColorToken, string>> & {
  readonly selectionAlpha: number;
  readonly noteAlpha: number;
};

export type PaletteTokenTable = Readonly<Record<string, PaletteTokens>>;
