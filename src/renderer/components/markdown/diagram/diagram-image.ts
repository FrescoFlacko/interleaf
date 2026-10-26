import { sanitizeRenderedSvg } from '../../../mermaid-sandbox/svg-allowlist';
import { DIAGRAM_FONT_FAMILY, DIAGRAM_FONT_SIZE_PX, MAX_DIAGRAM_DIMENSION } from './diagram-protocol';

/**
 * The colours a diagram is drawn in. An `<img>` is its own document, so the
 * app's CSS variables do not reach into it; the palette is written onto the
 * drawing's root instead.
 */
export type DiagramPalette = {
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly line: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly accent: string;
};

/** Paper, used for any token that is missing or not a plain hex colour. */
const FALLBACK_PALETTE: DiagramPalette = {
  background: '#ffffff',
  text: '#1c1917',
  muted: '#4a4542',
  line: '#4a4542',
  surface: '#f4f4f3',
  surfaceAlt: '#e5e3e1',
  border: '#8a837e',
  accent: '#075985',
};

const PALETTE_TOKENS: Readonly<Record<keyof DiagramPalette, string>> = {
  background: '--bg-primary',
  text: '--text-primary',
  muted: '--text-secondary',
  line: '--text-secondary',
  surface: '--bg-surface',
  surfaceAlt: '--border-subtle',
  border: '--border-strong',
  accent: '--accent',
};

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

/** The current palette's diagram colours, read from the tokens on `<html>`. */
export function readDiagramPalette(root: Element = document.documentElement): DiagramPalette {
  const style = getComputedStyle(root);
  const entries = Object.entries(PALETTE_TOKENS).map(([role, token]) => {
    const value = style.getPropertyValue(token).trim();
    const fallback = FALLBACK_PALETTE[role as keyof DiagramPalette];
    return [role, HEX_COLOUR.test(value) ? value : fallback];
  });
  return Object.fromEntries(entries) as DiagramPalette;
}

/**
 * Pele's root variables, bound to the palette instead of to page CSS. The
 * sanitizer drops the worker's root style, so the font the drawing was
 * measured in is restored here from Interleaf's own constants.
 */
function rootStyle(palette: DiagramPalette): string {
  return [
    `--_bg:${palette.background}`,
    `--_fg:${palette.text}`,
    `--_m:${palette.muted}`,
    `--_l:${palette.line}`,
    `--_s:${palette.surface}`,
    `--_a:${palette.surfaceAlt}`,
    `--_b:${palette.border}`,
    `--_c:${palette.accent}`,
    '--_r:4px',
    '--_fm:monospace',
    `color:${palette.text}`,
    `font-family:${DIAGRAM_FONT_FAMILY}`,
    `font-size:${String(DIAGRAM_FONT_SIZE_PX)}px`,
  ].join(';');
}

function encodeBase64(markup: string): string {
  const bytes = new TextEncoder().encode(markup);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Sanitized drawing markup, independent of the palette. */
export type SanitizedDiagram = { readonly markup: string; readonly width: number; readonly height: number };

/**
 * Rebuilds the worker's SVG from the shared allow-list. Scripts, handlers,
 * links, `foreignObject`, images and external references cannot survive it.
 * Throws when the markup cannot be rebuilt safely.
 */
export function sanitizeDiagramSvg(svg: string): SanitizedDiagram {
  return sanitizeRenderedSvg(svg, MAX_DIAGRAM_DIMENSION);
}

/**
 * A `data:` URL for the sanitized drawing in `palette`. The URL is only ever
 * the `src` of an `<img>`, which renders SVG as an inert picture.
 */
export function diagramImageUrl(diagram: SanitizedDiagram, palette: DiagramPalette): string {
  const document = new DOMParser().parseFromString(diagram.markup, 'image/svg+xml');
  const root = document.documentElement;
  root.setAttribute('style', rootStyle(palette));
  return `data:image/svg+xml;base64,${encodeBase64(new XMLSerializer().serializeToString(root))}`;
}
