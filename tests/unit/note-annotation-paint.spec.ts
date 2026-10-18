// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_COLOR_CONFIGS } from '../../src/shared/constants/annotations';
import { PALETTE_IDS, type PaletteId } from '../../src/shared/constants/palettes';
import { paletteCssVariables, readerBackgroundVariables } from '../../src/shared/constants/palette-tokens';
import { applyDomHighlights } from '../../src/renderer/features/reader/annotations/dom-anchors';
import { Paginator } from '../../src/renderer/features/reader/adapters/foliate/paginator';
import type { Annotation } from '../../src/shared/types/annotation';

/**
 * A `CSS.highlights` entry as this spec observes it: jsdom implements neither
 * `Highlight` nor the registry, so the test double below stands in for both.
 */
type TestHighlightLike = { readonly ranges: readonly Range[] };

const css = readFileSync('src/renderer/styles/global.css', 'utf8');

const RGBA = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/;

/** Reads the `--*` custom properties declared inside one palette block. */
function readPaletteTokens(palette: PaletteId): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paletteCssVariables(palette)).map(([name, value]) => [name.slice(2), value])
  );
}

function alphaOf(value: string, label: string): number {
  const match = RGBA.exec(value);
  expect(match, `${label} should be an rgba() value, got "${value}"`).not.toBeNull();
  return Number.parseFloat(match?.[1] ?? '1');
}

function annotationFixture(overrides: Partial<Annotation>): Annotation {
  return {
    id: 'ann',
    documentId: 'doc',
    documentHash: 'hash',
    type: 'highlight',
    anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'Sample text', prefix: '', suffix: '' } },
    selectedText: 'Sample text',
    note: null,
    label: null,
    color: null,
    isLocationNote: false,
    status: 'anchored',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

/** Runs the real style injection and returns the injected stylesheet text. */
function injectedHighlightCss(): string {
  document.getElementById('interleaf-annotation-highlight-styles')?.remove();
  const registry = new Map<string, TestHighlightLike>();
  Object.defineProperty(window, 'CSS', { configurable: true, value: { highlights: registry } });
  Object.defineProperty(window, 'Highlight', {
    configurable: true,
    value: class TestHighlight {
      readonly ranges: readonly Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    },
  });

  const paragraph = document.createElement('p');
  paragraph.textContent = 'Sample text for note paint testing.';
  document.body.appendChild(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);

  const applied = applyDomHighlights(document, [
    { annotation: annotationFixture({ id: 'hl-yellow', color: 'yellow' }), range },
    {
      annotation: annotationFixture({
        id: 'note-1',
        type: 'note',
        color: null,
        note: 'A saved note',
        isLocationNote: false,
      }),
      range,
    },
  ]);
  expect(applied).toBe(true);
  const text = document.getElementById('interleaf-annotation-highlight-styles')?.textContent ?? '';
  paragraph.remove();
  return text;
}

function ruleBody(styleText: string, name: string): string {
  const body = new RegExp(`::highlight\\(${name}\\)\\s*\\{([^}]*)\\}`).exec(styleText)?.[1];
  expect(body, `missing ::highlight(${name}) rule`).toBeDefined();
  return body ?? '';
}

describe('note annotation paint strength', () => {
  it('defines a dedicated translucent note token stronger than selection in every palette', () => {
    for (const palette of PALETTE_IDS) {
      const tokens = readPaletteTokens(palette);
      const selectionValue = tokens['selection-translucent'] ?? '';
      const noteValue = tokens['note-translucent'] ?? '';
      expect(noteValue, `${palette} missing --note-translucent`).not.toBe('');

      const selectionAlpha = alphaOf(selectionValue, `${palette} --selection-translucent`);
      const noteAlpha = alphaOf(noteValue, `${palette} --note-translucent`);
      expect(noteAlpha, `${palette} note paint must be stronger than plain selection`).toBeGreaterThan(selectionAlpha);
      expect(noteAlpha, `${palette} note paint must stay translucent`).toBeLessThan(1);
      expect(noteAlpha, `${palette} note paint must keep underlying text readable`).toBeLessThanOrEqual(0.7);
    }
  });

  it('defines reader-background note overrides for every reading background', () => {
    for (const id of PALETTE_IDS) {
      const overrides = readerBackgroundVariables(id);
      const value = overrides['--note-translucent'] ?? '';
      const selection = overrides['--reader-selection-override'] ?? '';
      expect(
        alphaOf(value, `reader background ${id} note`),
        `reader background ${id} note must be stronger than its selection`
      ).toBeGreaterThan(alphaOf(selection, `reader background ${id} selection`));
      expect(value, `reader background "${id}" must set --note-translucent`).toBe(paletteCssVariables(id)['--note-translucent']);
    }

    /* The token must resolve, not merely be declared: a declaration whose own
       fallback names the property being declared is a cycle and therefore
       invalid at computed-value time. */
    const surfaceBlock = /\.reader-surface\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(surfaceBlock).not.toContain('--note-translucent');
  });

  it('paints notes with the stronger note token and never sets text color', () => {
    const styleText = injectedHighlightCss();
    const note = ruleBody(styleText, 'interleaf-note');

    expect(note).toContain('var(--note-translucent');
    expect(note).toContain('underline');
    expect(note).toContain('var(--accent');
    // Text color must stay untouched so the underlying text remains readable.
    expect(/(^|[;{\s])color\s*:/.test(note)).toBe(false);
    expect(note).not.toContain('opacity');
  });

  it('leaves ordinary highlight colors unchanged', () => {
    const styleText = injectedHighlightCss();
    for (const color of ['yellow', 'blue', 'green', 'pink', 'purple'] as const) {
      const body = ruleBody(styleText, `interleaf-${color}`);
      expect(body).toContain(HIGHLIGHT_COLOR_CONFIGS[color].cssRgba);
      expect(body).not.toContain('--note-translucent');
    }
  });

  it('injects the note token into the sandboxed reader iframe', async () => {
    const paginator = new Paginator();
    document.body.appendChild(paginator.element);
    paginator.element.style.setProperty('--note-translucent', 'rgba(3, 105, 161, 0.45)');
    const iframe = paginator.element.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const frameDocument = document.implementation.createHTMLDocument('Reader section');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frameDocument });

    await paginator.open({
      sections: [
        {
          id: 'note-paint-section',
          index: 0,
          load: () => Promise.resolve('<html><head></head><body><p>Note paint</p></body></html>'),
          unload: () => undefined,
        },
      ],
    });

    const injected = frameDocument.getElementById('interleaf-injected-styles')?.textContent ?? '';
    expect(injected).toContain('--note-translucent:');
    paginator.element.remove();
  });
});
