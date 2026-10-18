// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MarkdownMessage } from '../../src/renderer/features/chat/MarkdownMessage';
import type { ChatCitation } from '@shared/types/ai';

const citations = new Map<string, ChatCitation>([
  [
    'src-1',
    { sourceId: 'src-1', label: 'Page 1 · Overview', pageLabel: '1', heading: 'Overview' },
  ],
]);

describe('MarkdownMessage', () => {
  const onCitation = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders user/assistant-style Markdown semantics without literal syntax', () => {
    render(
      <MarkdownMessage
        content={'# Heading\n\nA **strong** and *emphasized* paragraph with [src-1].\n\n- first\n- second\n\n1. ordered\n2. list\n\n> quoted\n\n---\n\n`inline`'}
        citations={citations}
        onCitation={onCitation}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('strong').closest('strong')).toBeTruthy();
    expect(screen.getByText('emphasized').closest('em')).toBeTruthy();
    expect(screen.getAllByRole('list', { name: '' })).toHaveLength(2);
    expect(screen.getByText('quoted').closest('blockquote')).toBeTruthy();
    expect(screen.getByText('inline').tagName).toBe('CODE');
    expect(screen.queryByText('# Heading')).toBeNull();
    expect(screen.getByRole('button', { name: 'p. 1' })).toBeTruthy();
  });

  it('keeps heading hierarchy visibly differentiated and bounded in the narrow chat surface', () => {
    render(
      <MarkdownMessage
        content={'# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six'}
        citations={new Map()}
        onCitation={onCitation}
      />,
    );

    const classes = [1, 2, 3, 4, 5, 6].map((depth) => screen.getByTestId(`markdown-heading-${String(depth)}`).className);
    expect(new Set(classes).size).toBe(6);
    for (const className of classes) {
      expect(className).toContain('max-w-full');
      expect(className).toContain('break-words');
    }
  });

  it('keeps malformed or streaming Markdown visible as escaped text', () => {
    render(
      <MarkdownMessage
        content={'### Still streaming **unfinished\n\n<script>alert(1)</script>\n\n[visible](javascript:alert(1))'}
        citations={new Map()}
        onCitation={onCitation}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Still streaming **unfinished' })).toBeTruthy();
    expect(screen.getByTestId('markdown-raw-html')).toHaveTextContent('<script>alert(1)</script>');
    expect(screen.getByTestId('markdown-link-inert')).toHaveTextContent('visible');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[href]')).toBeNull();
  });

  it('does not activate data/file links or embedded images, and keeps http links inert without safe-open IPC', () => {
    render(
      <MarkdownMessage
        content={'[data](data:text/html,bad) [file](file:///tmp/x) [https](https://example.com) ![pixel](https://example.com/x.png)'}
        citations={new Map()}
        onCitation={onCitation}
      />,
    );

    expect(screen.getAllByTestId('markdown-link-inert')).toHaveLength(3);
    expect(screen.getByTestId('markdown-image-inert')).toHaveTextContent('[pixel]');
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('keeps a web source visibly separate from a document citation', () => {
    // A web-search turn can put both kinds of reference in one sentence. They
    // must not read as the same thing: `[src-1]` is a control that moves this
    // document, a web reference is inert text carrying its own host so the
    // reader can see the claim came from outside the book.
    render(
      <MarkdownMessage
        content={'Quorum holds [src-1], and the [2026 revision](https://standards.example.org/rfc/9999#quorum) says otherwise.'}
        citations={citations}
        onCitation={onCitation}
      />,
    );

    const citation = screen.getByRole('button', { name: 'p. 1' });
    expect(citation).toHaveAttribute('title', 'Jump to Page 1 · Overview');
    fireEvent.click(citation);
    expect(onCitation).toHaveBeenCalledWith('src-1');

    const webLink = screen.getByTestId('markdown-link-inert');
    expect(webLink).toHaveAttribute('data-link-kind', 'web');
    expect(webLink).toHaveAttribute('data-link-host', 'standards.example.org');
    expect(screen.getByTestId('markdown-link-host')).toHaveTextContent('(standards.example.org)');
    // No navigation affordance is invented for it: it is not a citation chip
    // and it is not an anchor, because no safe-open path exists.
    expect(webLink.tagName).toBe('SPAN');
    expect(webLink.querySelector('button')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });

  it('refuses to dress a web URL up as a document source id', () => {
    // A model can emit `[src-N]` as link text. The chip is only ever created
    // from a source the envelope actually carried, so an unknown id stays
    // ordinary text and a linked one stays a web reference.
    render(
      <MarkdownMessage
        content={'See [src-1](https://evil.example.com/page) and [src-42].'}
        citations={citations}
        onCitation={onCitation}
      />,
    );

    const webLink = screen.getByTestId('markdown-link-inert');
    expect(webLink).toHaveAttribute('data-link-host', 'evil.example.com');
    // The link text is not promoted into a jump control by virtue of its shape.
    expect(webLink.querySelector('button')).toBeNull();
    expect(webLink.textContent).toContain('src-1');
    expect(screen.queryByRole('button', { name: 'p. 1' })).toBeNull();
    expect(screen.getByText(/\[src-42\]/u)).toBeTruthy();
  });

  it('shows an unbound marker as an inert pending chip only while the answer streams', () => {
    const content = 'Quorum holds [src-1] and [src-2], see `[src-3]` and [link [src-4]](https://example.org).';
    const { rerender } = render(
      <MarkdownMessage content={content} citations={citations} onCitation={onCitation} streaming />,
    );

    // The bound marker is still the one jump control; the unbound one is a
    // non-interactive chip, and code and link text keep their literal markers.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'p. 1' })).toBeTruthy();
    const pending = screen.getAllByTestId('citation-pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tagName).toBe('SPAN');
    expect(pending[0]).toHaveTextContent('source');
    expect(screen.queryByText(/\[src-2\]/u)).toBeNull();
    expect(screen.getByText('[src-3]')).toBeTruthy();
    expect(screen.getByTestId('markdown-link-inert').textContent).toContain('[src-4]');

    // Settled, the same unbound marker is ordinary text again: nothing invented.
    rerender(<MarkdownMessage content={content} citations={citations} onCitation={onCitation} />);
    expect(screen.queryAllByTestId('citation-pending')).toHaveLength(0);
    expect(screen.getByText(/\[src-2\]/u)).toBeTruthy();
  });

  it('keeps ordinary bracketed text literal while streaming and binds only envelope-named ids', () => {
    const bound = new Map<string, ChatCitation>([
      ['doc:intro', { sourceId: 'doc:intro', label: 'Introduction', pageLabel: null, heading: 'Introduction' }],
    ]);
    const content = 'Choose [A] or [B]. Leave [TODO] for later. Grounding [src-1], see [doc:intro] and [src-0].';
    const { container, rerender } = render(
      <MarkdownMessage content={content} citations={bound} onCitation={onCitation} streaming />,
    );

    // Only main's grounded `src-N` marker convention waits for the envelope.
    expect(container.textContent).toContain('Choose [A] or [B]. Leave [TODO] for later.');
    expect(container.textContent).toContain('[src-0]');
    expect(screen.getAllByTestId('citation-pending')).toHaveLength(1);
    // An arbitrary id the envelope binds is still a citation.
    fireEvent.click(screen.getByRole('button', { name: 'Introduction' }));
    expect(onCitation).toHaveBeenCalledWith('doc:intro');

    rerender(<MarkdownMessage content={content} citations={bound} onCitation={onCitation} />);
    expect(screen.queryAllByTestId('citation-pending')).toHaveLength(0);
    expect(container.textContent).toContain('Grounding [src-1], see Introduction and [src-0].');
  });

  it('keeps the chat inert-image wording and the plain soft-break DOM', () => {
    const { container } = render(
      <MarkdownMessage
        content={'![pixel](https://example.com/x.png)\n\nfirst line\nsecond line'}
        citations={new Map()}
        onCitation={onCitation}
      />,
    );

    expect(screen.getByTestId('markdown-image-inert')).toHaveAttribute(
      'title',
      'Embedded images are not displayed in chat',
    );

    // A soft break is a bare <br>: no sibling newline text node is added, so the
    // rendered text stays the legacy concatenation.
    expect(container.querySelector('br')).not.toBeNull();
    const paragraphs = Array.from(container.querySelectorAll('p')).map((paragraph) => paragraph.textContent);
    expect(paragraphs).toContain('first linesecond line');
  });

  it('keeps hostile HTML, SVG, event handlers, and javascript links outside the active DOM', () => {
    render(
      <MarkdownMessage
        content={'<img src="x" onerror="alert(1)">\n\n<a href="javascript:alert(1)" onclick="alert(2)">bad link</a>\n\n<iframe src="https://evil.test"></iframe>\n\n<svg onload="alert(3)"><circle /></svg>\n\n<div onmouseover="alert(4)">plain text</div>'}
        citations={new Map()}
        onCitation={onCitation}
      />,
    );

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(Array.from(document.querySelectorAll('*')).some((element) =>
      Array.from(element.attributes).some((attribute) => /^on/iu.test(attribute.name))
    )).toBe(false);
    expect(screen.getAllByTestId('markdown-raw-html').map((element) => element.textContent).join('\n')).toContain('<img src="x" onerror="alert(1)">');
  });

  it('keeps citations keyboard-accessible and preserves very long tokens within the message container', async () => {
    const longToken = 'x'.repeat(20_000);
    const { container } = render(
      <MarkdownMessage
        content={`before [src-1] after\n\n${longToken}`}
        citations={citations}
        onCitation={onCitation}
      />,
    );

    const citation = screen.getByRole('button', { name: 'p. 1' });
    expect(citation).toHaveAttribute('type', 'button');
    fireEvent.click(citation);
    expect(onCitation).toHaveBeenCalledWith('src-1');
    expect(screen.getByText(longToken)).toBeTruthy();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
