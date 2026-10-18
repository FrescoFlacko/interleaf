import { describe, expect, it } from 'vitest';
import { sessionPreview } from '../../src/main/db/repositories/chat-session-summary';

const ENVELOPE = JSON.stringify([
  { sourceId: 'src-1', label: 'Overview', pageLabel: '1', heading: 'Overview' },
]);

describe('sessionPreview code regions', () => {
  it('keeps a marker inside a fence that contains inline backticks literal', () => {
    const content = 'Actual grounding [src-1].\n\n```md\nUse `[src-1]` for a literal example.\n```';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('Actual grounding (p. 1). ```md Use `[src-1]` for a literal example. ```');
  });

  it('keeps tilde fences and indented code literal', () => {
    const content = 'See [src-1].\n\n~~~\nA ``` inside [src-1]\n~~~\n\n    indented [src-1]\n\nAfter [src-1].';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('See (p. 1). ~~~ A ``` inside [src-1] ~~~ indented [src-1] After (p. 1).');
  });

  it('pairs inline delimiter runs by length', () => {
    const content = 'Run ``a ` [src-1]`` then [src-1] and `x` [src-1] `y`.';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('Run ``a ` [src-1]`` then (p. 1) and `x` (p. 1) `y`.');
  });

  it('labels markers after an unmatched backtick and keeps unknown brackets', () => {
    expect(sessionPreview('A stray ` then [src-1] and [TODO].', ENVELOPE))
      .toBe('A stray ` then (p. 1) and [TODO].');
    expect(sessionPreview('Escaped \\`[src-1]\\` is text.', ENVELOPE))
      .toBe('Escaped \\`(p. 1)\\` is text.');
  });

  it('labels outside a fence that is still open, as the conversation renders it', () => {
    const content = 'Grounded [src-1].\n\n```\nunfinished [src-1]';

    expect(sessionPreview(content, ENVELOPE)).toBe('Grounded (p. 1). ``` unfinished [src-1]');
  });

  it('keeps code offsets exact across CRLF line endings and tabs', () => {
    const content = 'Tab\tthen [src-1].\r\n\r\n```\r\nliteral [src-1]\r\n```\r\n\r\n- item\t[src-1]';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('Tab then (p. 1). ``` literal [src-1] ``` - item (p. 1)');
  });

  it('finds a code span after a link whose title repeats the same text', () => {
    const content = '[Reference](https://example.org "Use `[src-1]`") then `[src-1]`.';

    expect(sessionPreview(content, ENVELOPE)).toBe(content);
  });

  it('labels an ordinary reference beside code that repeats earlier in a link', () => {
    const content = 'Per [src-1], [see `x`](https://example.org "`[src-1]` [src-1]") and `[src-1]` `x` [src-1].';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('Per (p. 1), [see `x`](https://example.org "`[src-1]` [src-1]") and `[src-1]` `x` (p. 1).');
  });

  it('places code in headings, emphasis and list items by their own markup', () => {
    const content = '# `[src-1]` [src-1]\n\n**`[src-1]`** [src-1]\n\n- `[src-1]` then [src-1]';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('# `[src-1]` (p. 1) **`[src-1]`** (p. 1) - `[src-1]` then (p. 1)');
  });

  it('places code on a one-line quote but keeps a multi-line quote with code verbatim', () => {
    expect(sessionPreview('> `x` [src-1]\n\nAfter [src-1].', ENVELOPE)).toBe('> `x` (p. 1) After (p. 1).');
    expect(sessionPreview('> `[src-1]` [src-1]\n> more [src-1]\n\nAfter [src-1].', ENVELOPE))
      .toBe('> `[src-1]` [src-1] > more [src-1] After (p. 1).');
  });

  it('protects a quoted fence rather than guessing its source range', () => {
    const content = 'Before [src-1].\n\n> ```\n> quoted [src-1]\n> ```\n\nAfter [src-1].';

    expect(sessionPreview(content, ENVELOPE))
      .toBe('Before (p. 1). > ``` > quoted [src-1] > ``` After (p. 1).');
  });
});
