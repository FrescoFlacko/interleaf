import { compositeOver, parseCssColor, toRgba, type Rgb } from './palette-color';
import type { PaletteTokens } from './palette-token-types';
import type { PaletteAppearance, PaletteId } from './palettes';

/**
 * The note composer's paper: an opaque card a shade warmer than the chrome it
 * sits on, with a hairline edge and a slim rail beside a quoted passage.
 *
 * Paper, Sepia and Midnight use the reviewed design values. Every other
 * palette tints its own raised surface with its accent, so a note reads as part
 * of that palette rather than as the same yellow everywhere.
 * `tests/unit/palette-contrast.spec.ts` checks text, accent, status and focus
 * contrast on every resulting surface.
 */
type NoteSurface = {
  readonly surface: string;
  readonly border: string;
  readonly rail: string;
};

const REVIEWED_NOTE_SURFACES: Partial<Readonly<Record<PaletteId, NoteSurface>>> = {
  paper: { surface: '#fffbeb', border: '#e8d8a3', rail: '#c49b39' },
  sepia: { surface: '#f0e1c2', border: '#cdb88a', rail: '#9c6e29' },
  midnight: { surface: '#1c2431', border: '#3b4b63', rail: '#8ab4ff' },
};

/** Accent strength over the raised surface for the card and for its edge. */
const TINT: Readonly<Record<PaletteAppearance, { readonly surface: number; readonly border: number }>> = {
  light: { surface: 0.05, border: 0.22 },
  dark: { surface: 0.08, border: 0.3 },
};

/** A lifted card, and the shallower shadow used when it sits inline in a list. */
const NOTE_SHADOWS: Readonly<Record<PaletteAppearance, { readonly card: string; readonly inline: string }>> = {
  light: {
    card: '0 2px 1px rgba(174, 138, 48, 0.125), 0 12px 26px rgba(79, 60, 24, 0.125)',
    inline: '0 2px 1px rgba(0, 0, 0, 0.05), 0 4px 12px rgba(0, 0, 0, 0.055)',
  },
  dark: {
    card: '0 2px 1px rgba(0, 0, 0, 0.533), 0 12px 26px rgba(0, 0, 0, 0.6)',
    inline: '0 2px 1px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.35)',
  },
};

function hex([red, green, blue]: Rgb): string {
  const channel = (value: number): string => Math.round(value).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function derivedNoteSurface(tokens: PaletteTokens, appearance: PaletteAppearance): NoteSurface {
  const accent = parseCssColor(tokens.accent);
  const raised = parseCssColor(tokens['bg-surface-elevated']);
  if (accent === null || raised === null) {
    return { surface: tokens['bg-surface-elevated'], border: tokens['border-subtle'], rail: tokens['border-strong'] };
  }
  const tint = TINT[appearance];
  return {
    surface: hex(compositeOver(accent, tint.surface, raised)),
    border: hex(compositeOver(accent, tint.border, raised)),
    rail: tokens.accent,
  };
}

/** The note composer's custom properties for one palette. */
export function noteCssVariables(
  id: PaletteId,
  tokens: PaletteTokens,
  appearance: PaletteAppearance,
): Readonly<Record<`--${string}`, string>> {
  const note = REVIEWED_NOTE_SURFACES[id] ?? derivedNoteSurface(tokens, appearance);
  const accent = parseCssColor(tokens.accent);
  return {
    '--note-surface': note.surface,
    '--note-border': note.border,
    '--note-quote-rail': note.rail,
    '--note-shadow': NOTE_SHADOWS[appearance].card,
    '--note-shadow-inline': NOTE_SHADOWS[appearance].inline,
    '--note-control-hover': accent === null ? tokens['accent-muted'] : toRgba(accent, appearance === 'dark' ? 0.16 : 0.1),
  };
}
