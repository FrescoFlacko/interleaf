import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for the renderer's design system (docs/UX_SPEC.md): spacing
 * and type come from the token scales, dropdowns are the themed listbox, and
 * motion uses the shared tokens rather than ad-hoc animation utilities.
 *
 * Every guard takes an allow-list of `file: match` entries, each commented
 * with why it is allowed. An empty list means there is no exception.
 */

const RENDERER_ROOT = resolve(__dirname, '../../src/renderer');

function rendererSources(dir: string = RENDERER_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...rendererSources(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const SOURCES = rendererSources().map((path) => ({
  file: relative(RENDERER_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** `file:line: match` for every hit not named by the allow-list. */
function violations(pattern: RegExp, allow: readonly string[]): string[] {
  const hits: string[] = [];
  for (const { file, text } of SOURCES) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        if (!allow.includes(`${file}: ${match[0]}`)) hits.push(`${file}:${String(index + 1)}: ${match[0]}`);
      }
    });
  }
  return hits;
}

// No exceptions: every spacing utility is a step on the 4px scale.
const SPACING_ALLOW: readonly string[] = [];
// No exceptions: `em` sizes are not matched (see the guard), and nothing sets
// an absolute size off the 11/12/13/14/16/20 scale.
const TEXT_SIZE_ALLOW: readonly string[] = [];
// No exceptions: text over cover artwork is solid white, never faded.
const FADED_TEXT_ALLOW: readonly string[] = [];
const SELECT_ALLOW: readonly string[] = [
  // Prose in the doc comment explaining why the platform popup is not used.
  'components/ui/select.tsx: <select>',
];
// No exceptions: enter motion uses `.ui-enter-from-start` and panels slide
// their content with a transform instead of animating width.
const MOTION_ALLOW: readonly string[] = [];
// No exceptions: each spinner stops under reduced motion (checked per line).
const SPINNER_ALLOW: readonly string[] = [];

describe('renderer style guards', () => {
  it('finds the renderer sources it guards', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it('uses the spacing scale instead of arbitrary pixel spacing', () => {
    const spacing = /(?<![\w-])-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[[^\]]*px\]/g;
    expect(violations(spacing, SPACING_ALLOW)).toEqual([]);
  });

  it('sets text on the type scale, never an arbitrary size', () => {
    // `em` sizes stay legal: they are relative to the surrounding text (inline
    // code and math, and imported Markdown typeset from the reader's own font
    // size), not a second absolute scale.
    const size = /(?<![\w-])text-\[[0-9.]+(?:px|rem)\]/g;
    expect(violations(size, TEXT_SIZE_ALLOW)).toEqual([]);
  });

  it('never composes a text colour from opacity', () => {
    const fadedText =
      /(?<![\w-])(?:placeholder:)?text-(?:white|black|accent|danger|warning|success|on-accent|text-[a-z]+)\/\d+/g;
    expect(violations(fadedText, FADED_TEXT_ALLOW)).toEqual([]);
  });

  it('renders dropdowns as the themed listbox, never a native select', () => {
    expect(violations(/<select[\s>]/g, SELECT_ALLOW)).toEqual([]);
  });

  it('animates through the motion tokens, not enter utilities or width', () => {
    expect(violations(/(?<![\w-])animate-in\b/g, MOTION_ALLOW)).toEqual([]);
    expect(violations(/transition-\[width/g, MOTION_ALLOW)).toEqual([]);
  });

  it('stops every spinner under reduced motion', () => {
    const spinners = violations(/(?<![\w-])animate-spin\b/g, SPINNER_ALLOW);
    const unguarded = spinners.filter((hit) => {
      const [file, line] = hit.split(':');
      const source = SOURCES.find((entry) => entry.file === file)?.text.split('\n')[Number(line) - 1] ?? '';
      return !source.includes('motion-reduce:animate-none');
    });
    expect(unguarded).toEqual([]);
  });
});
