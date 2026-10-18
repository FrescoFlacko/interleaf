import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS, type PaletteId } from '../../src/shared/constants/palettes';
import { paletteCssVariables } from '../../src/shared/constants/palette-tokens';

/**
 * The AI Chat panel carried its own light palette, so it stayed white under
 * every theme. These assertions hold it to the app's semantic tokens instead:
 * the panel must name only tokens, and every token it names must exist in
 * every palette, which is what makes it follow the theme rather than override it.
 */

const chatStylesheet = readFileSync(
  resolve(__dirname, '../../src/renderer/features/chat/chat-design.css'),
  'utf8'
);
const globalStylesheet = readFileSync(
  resolve(__dirname, '../../src/renderer/styles/global.css'),
  'utf8'
);
const tokenStylesheet = readFileSync(
  resolve(__dirname, '../../src/renderer/styles/tokens.css'),
  'utf8'
);

/** Every palette is applied at runtime from the typed token table. */
const THEME_IDS = PALETTE_IDS;

/** Declaration bodies only: comments and `white-space`-style keywords are noise here. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The colours the composer's focus hairline sits between: the panel ground and
 * the two card surfaces on either side of it, plus the idle border it replaces.
 * A focus indicator has to be visible against all of them (WCAG 2.1 SC 1.4.11),
 * and the inner fields deliberately draw no ring of their own, so this frame is
 * the only indicator those surfaces have.
 */
const ADJACENT_TOKENS = ['--bg-primary', '--bg-surface', '--bg-surface-elevated', '--border-subtle'] as const;

/** sRGB relative luminance, WCAG 2.1 definition, from a `#rrggbb` literal. */
function luminance(hex: string): number {
  const linear = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(one: string, other: string): number {
  const [lighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

function themeBlockBody(selector: string): string {
  const start = globalStylesheet.indexOf(`${selector} {`);
  expect(start, `theme block ${selector} exists`).toBeGreaterThanOrEqual(0);
  const end = globalStylesheet.indexOf('}', start);
  return globalStylesheet.slice(start, end);
}

describe('chat panel colour comes from the app theme, not a parallel palette', () => {
  const chatCss = withoutComments(chatStylesheet);

  it('names no literal colour: no hex, no rgb(), no white/black ground', () => {
    expect(chatCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chatCss).not.toMatch(/\brgba?\(/);
    // `white-space` is a layout keyword, not a colour; only value positions count.
    expect(chatCss).not.toMatch(/:\s*(white|black)\b/);
    // The old palette encoded a grey caret as a hex-escaped SVG data URI.
    expect(chatCss).not.toMatch(/%23/);
  });

  it('declares no parallel --chat-* palette and no per-theme overrides', () => {
    expect(chatCss).not.toMatch(/--chat-[a-z-]+\s*:/);
    expect(chatCss).not.toMatch(/\[data-theme=/);
  });

  it('grounds the panel on the app background and text tokens', () => {
    const panelBlock = /^\.chat-design \{([\s\S]*?)\}/m.exec(chatCss)?.[1];
    expect(panelBlock).toBeDefined();
    expect(panelBlock).toMatch(/background:\s*var\(--bg-primary\)/);
    expect(panelBlock).toMatch(/color:\s*var\(--text-primary\)/);
  });

  it('references only tokens that every palette defines', () => {
    // `--companion-text-scale` is the reader's companion text-size preference,
    // set on the panel element by the renderer. It carries a number rather than
    // a colour, so no palette declares it and none has anything to say about
    // it. Durations and easings are motion tokens declared once in tokens.css
    // for every theme; only names declared there are exempt, so a mistyped
    // one still fails. Every other variable the panel names must be a theme token.
    const motionTokens = [...withoutComments(tokenStylesheet).matchAll(/(--(?:dur|ease)-[a-z0-9-]+)\s*:/g)]
      .map((match) => match[1]);
    expect(motionTokens).toContain('--dur-fast');
    const nonPaletteVariables = new Set(['--companion-text-scale', ...motionTokens]);
    const referenced = [...new Set([...chatCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
      .filter((token) => token !== undefined && !nonPaletteVariables.has(token));
    expect(referenced.length).toBeGreaterThan(0);
    // Tokens declared once for every theme are theme-following too, as long as
    // they are derived from palette tokens rather than from a literal colour.
    const derivedBody = themeBlockBody(':root,\n[data-theme]');
    const derived = [...derivedBody.matchAll(/(--[a-z0-9-]+):/g)].map((match) => match[1]);
    expect(derived.length).toBeGreaterThan(0);
    expect(withoutComments(derivedBody)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    for (const id of THEME_IDS) {
      const variables = paletteCssVariables(id);
      const missing = referenced.filter(
        (token) => !(String(token) in variables) && !derived.includes(token)
      );
      expect(missing, `${id} defines every token the chat panel uses`).toEqual([]);
    }
  });

  /** `--token: #rrggbb` as the named palette declares it. */
  function paletteColour(id: PaletteId, token: string): string {
    const declared = paletteCssVariables(id)[`--${token.replace(/^--/, '')}`] ?? '';
    expect(declared, `${id} declares ${token} as a hex literal`).toMatch(/^#[0-9a-f]{6}$/i);
    return declared;
  }

  it.each(THEME_IDS)(
    'keeps the focused composer frame at 3:1 against everything it touches in %s',
    (id) => {
      // Resolved the way the cascade does: the shared role token names one
      // palette token, and each palette supplies its own value for it.
      const role = /--border-focus-surface:\s*var\((--[a-z-]+)\)/.exec(themeBlockBody(':root,\n[data-theme]'));
      expect(role, 'the focus-surface role resolves to a palette token').not.toBeNull();
      const frame = paletteColour(id, role![1]!);

      for (const token of ADJACENT_TOKENS) {
        const ratio = contrastRatio(frame, paletteColour(id, token));
        expect(ratio, `${id}: focus frame vs ${token} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  );
});
