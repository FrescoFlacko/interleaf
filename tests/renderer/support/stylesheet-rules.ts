import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read access to the renderer's hand-written stylesheet for renderer specs.
 *
 * Some behaviour a component owns is expressed in `global.css` rather than in
 * utility classes — a media query cannot be written as a Tailwind class when
 * the rule has to remove a property outright. jsdom applies no stylesheet, so
 * the honest thing a renderer spec can assert is the rule that produced the
 * behaviour; the painted result is covered by the Electron E2E suite.
 */

const GLOBAL_CSS_PATH = resolve(__dirname, '../../../src/renderer/styles/global.css');

export function readGlobalCss(): string {
  return readFileSync(GLOBAL_CSS_PATH, 'utf8');
}

/**
 * The declarations of the rule with this exact selector, braces included.
 *
 * Selectors here are literal and brace-free, so a non-greedy match to the first
 * closing brace is the whole rule. A missing rule yields an empty string, which
 * fails the caller's assertions rather than silently passing them.
 */
export function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(css);
  return matches?.[0] ?? '';
}

/**
 * A whole `@media` block, brace-matched, so assertions about what a query does
 * cannot pick up rules that merely follow it. Blocks are selected by a fragment
 * they must contain, which is how a caller names the one it means.
 */
export function mediaBlock(css: string, query: string, contains: string): string {
  const blocks: string[] = [];
  for (let index = css.indexOf(query); index !== -1; index = css.indexOf(query, index + 1)) {
    let depth = 0;
    let cursor = css.indexOf('{', index);
    while (cursor < css.length && cursor !== -1) {
      depth += Number(css[cursor] === '{') - Number(css[cursor] === '}');
      if (depth === 0) break;
      cursor += 1;
    }
    blocks.push(css.slice(index, cursor + 1));
  }
  return blocks.find((block) => block.includes(contains)) ?? '';
}
