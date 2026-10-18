import katex from 'katex';
import type { TokenizerExtension, Tokens } from 'marked';

/**
 * TeX math in untrusted Markdown.
 *
 * Models write math as `\[ … \]`, `$$ … $$`, `\( … \)` or `$ … $`. Plain
 * Markdown treats `\[` and `\(` as escapes, eats the backslash and leaves the
 * reader with `[ \text{…} ]`. These tokenizers claim the delimited source
 * before the escape rule sees it, so the TeX survives intact into a `math`
 * token. Code spans and fenced code keep their text: the block lexer consumes
 * fences first, and an inline code span starts at its backtick, where no math
 * rule matches.
 */
export type MathToken = Tokens.Generic & {
  readonly type: 'math';
  readonly tex: string;
  readonly display: boolean;
};

/** Longest TeX source rendered; anything longer stays readable source text. */
const MAX_TEX_LENGTH = 4_000;

const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/u;
const INLINE_DISPLAY_MATH = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/u;
const INLINE_PAREN_MATH = /^\\\(([\s\S]+?)\\\)/u;
// A single `$` pair must hug its content, stay on one line, contain no code
// span and not be followed by a digit, so prices such as "$5 and $10" stay
// prose. It is also only claimed when the TeX parses; see the tokenizer.
const INLINE_DOLLAR_MATH = /^\$(?!\s)((?:\\\$|[^$`\n])+?)(?<!\s)\$(?!\d)/u;

function mathToken(raw: string, tex: string | undefined, display: boolean): MathToken | undefined {
  const source = tex?.trim() ?? '';
  if (source.length === 0 || source.length > MAX_TEX_LENGTH) return undefined;
  return { type: 'math', raw, tex: source, display };
}

function firstIndex(src: string, markers: readonly string[]): number | undefined {
  const found = markers.map((marker) => src.indexOf(marker)).filter((index) => index >= 0);
  return found.length > 0 ? Math.min(...found) : undefined;
}

const blockMath: TokenizerExtension = {
  name: 'math',
  level: 'block',
  start: (src) => firstIndex(src, ['$$', '\\[']),
  tokenizer(src) {
    const match = BLOCK_MATH.exec(src);
    if (!match) return undefined;
    return mathToken(match[0], match[1] ?? match[2], true);
  },
};

const inlineMath: TokenizerExtension = {
  name: 'math',
  level: 'inline',
  start: (src) => firstIndex(src, ['$', '\\[', '\\(']),
  tokenizer(src) {
    const display = INLINE_DISPLAY_MATH.exec(src);
    if (display) return mathToken(display[0], display[1] ?? display[2], true);
    const paren = INLINE_PAREN_MATH.exec(src);
    if (paren) return mathToken(paren[0], paren[1], false);
    const dollar = INLINE_DOLLAR_MATH.exec(src);
    const token = dollar ? mathToken(dollar[0], dollar[1], false) : undefined;
    // A bare `$` is too common in prose to claim when it is not real TeX.
    return token && renderMathMl(token.tex, false) !== null ? token : undefined;
  },
};

export const mathExtensions: readonly TokenizerExtension[] = [blockMath, inlineMath];

const renderedCache = new Map<string, string | null>();
const RENDERED_CACHE_LIMIT = 256;

/**
 * KaTeX's MathML for one expression, or `null` when the TeX does not parse.
 *
 * `trust: false` keeps `\href`, `\url`, `\includegraphics` and the `\html*`
 * commands off; expansion and size are bounded so a hostile macro cannot
 * stall the renderer. The string is only ever parsed into an inert document
 * and mapped through an element allowlist; it is never assigned as HTML.
 */
export function renderMathMl(tex: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const cached = renderedCache.get(key);
  if (cached !== undefined) return cached;
  let rendered: string | null;
  try {
    rendered = katex.renderToString(tex, {
      displayMode: display,
      output: 'mathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxExpand: 500,
      maxSize: 20,
    });
  } catch {
    rendered = null;
  }
  if (renderedCache.size >= RENDERED_CACHE_LIMIT) renderedCache.clear();
  renderedCache.set(key, rendered);
  return rendered;
}
