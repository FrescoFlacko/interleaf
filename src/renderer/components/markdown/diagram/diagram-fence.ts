import type { Token, Tokens } from 'marked';

/** Whether a fenced code block declares Mermaid as its language. */
export function isMermaidFence(code: Tokens.Code): boolean {
  const language = (code.lang ?? '').trim().split(/\s+/u)[0] ?? '';
  return language.toLowerCase() === 'mermaid';
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

/**
 * Whether a fenced block's raw text ends with its closing fence. A reply that
 * is still being written — or one cut off mid-diagram — lexes into a code block
 * that runs to the end of the input; that block is shown as source, never
 * rendered half-written.
 */
export function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/u, '').split('\n');
  if (lines.length < 2) return false;
  const opening = OPENING_FENCE.exec(lines[0] ?? '')?.[1];
  const closing = CLOSING_FENCE.exec(lines[lines.length - 1] ?? '')?.[1];
  if (opening === undefined || closing === undefined) return false;
  return closing.startsWith(opening.charAt(0)) && closing.length >= opening.length;
}

function childTokens(token: Token): readonly Token[] {
  const nested: Token[] = [];
  if ('tokens' in token && Array.isArray(token.tokens)) nested.push(...token.tokens);
  if (token.type === 'list') nested.push(...(token as Tokens.List).items);
  return nested;
}

/**
 * The complete Mermaid fences of one message, in document order, up to `max`.
 * Fences after the cap, and unclosed ones, are not in the set and stay source.
 */
export function selectDiagramFences(tokens: readonly Token[], max: number): ReadonlySet<Tokens.Code> {
  const selected = new Set<Tokens.Code>();
  const visit = (list: readonly Token[]): void => {
    for (const token of list) {
      if (selected.size >= max) return;
      if (token.type === 'code') {
        const code = token as Tokens.Code;
        if (isMermaidFence(code) && isClosedFence(code.raw)) selected.add(code);
        continue;
      }
      visit(childTokens(token));
    }
  };
  visit(tokens);
  return selected;
}
