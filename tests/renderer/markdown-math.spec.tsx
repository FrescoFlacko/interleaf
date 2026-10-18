// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownContent } from '../../src/renderer/components/markdown/MarkdownContent';

afterEach(cleanup);

function renderMarkdown(content: string): HTMLElement {
  render(<MarkdownContent content={content} />);
  return screen.getByTestId('markdown-content');
}

describe('Markdown math', () => {
  it('renders bracketed display math instead of eating the backslashes', () => {
    const root = renderMarkdown(
      'The attention function is\n\n\\[ \\text{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V \\]\n\nwhere Q is the query.',
    );
    const math = screen.getByTestId('markdown-math');
    expect(math.dataset.display).toBe('block');
    expect(math.querySelector('math')).not.toBeNull();
    expect(math.querySelector('mfrac')).not.toBeNull();
    expect(math.querySelector('msqrt')).not.toBeNull();
    expect(root.textContent).not.toContain('[ \\text');
    expect(root.textContent).not.toContain('\\frac');
  });

  it('renders parenthesised and dollar inline math inside a sentence', () => {
    renderMarkdown('Scale by \\( \\sqrt{d_k} \\) and add $x_i^2$ to the sum.');
    const maths = screen.getAllByTestId('markdown-math');
    expect(maths).toHaveLength(2);
    for (const math of maths) expect(math.dataset.display).toBe('inline');
    expect(maths[0]!.querySelector('msqrt')).not.toBeNull();
    expect(maths[1]!.querySelector('msubsup')).not.toBeNull();
  });

  it('renders $$ display math, including inside a paragraph', () => {
    renderMarkdown('Energy: $$E = mc^2$$ holds.');
    const math = screen.getByTestId('markdown-math');
    expect(math.dataset.display).toBe('block');
    expect(math.querySelector('msup')).not.toBeNull();
  });

  it('leaves prices, code spans and fenced code as text', () => {
    const root = renderMarkdown('It costs $5 and $10 today. Use `\\(x\\)` or `$y$`.\n\n```\n\\[ z \\]\n```');
    expect(screen.queryByTestId('markdown-math')).toBeNull();
    expect(root.textContent).toContain('$5 and $10');
    expect(root.textContent).toContain('\\(x\\)');
    expect(root.textContent).toContain('$y$');
    expect(root.textContent).toContain('\\[ z \\]');
  });

  it('shows TeX that does not parse as its source', () => {
    renderMarkdown('Broken: \\( \\frac{a \\)');
    expect(screen.queryByTestId('markdown-math')).toBeNull();
    expect(screen.getByTestId('markdown-math-source').textContent).toBe('\\frac{a');
  });

  it('keeps links, HTML and TeX source annotations out of the rendered math', () => {
    renderMarkdown('\\[ \\href{javascript:alert(1)}{x} + \\htmlClass{evil}{y} \\]');
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('[href]')).toBeNull();
    expect(document.querySelector('.evil')).toBeNull();
    expect(document.querySelector('annotation')).toBeNull();
    expect(document.querySelector('script, [style], [onerror]')).toBeNull();
  });

  it('does not render a raw HTML payload that sits inside math delimiters', () => {
    renderMarkdown('\\( \\text{<img src=x onerror=alert(1)>} \\)');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
  });
});
