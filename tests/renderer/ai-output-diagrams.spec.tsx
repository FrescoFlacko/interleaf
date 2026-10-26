// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ChatCitation } from '@shared/types/ai';
import { renderDiagramSource } from '../../src/renderer/components/markdown/diagram/pele-render-core';
import {
  createDiagramRenderQueue,
  type DiagramRenderQueue,
  type DiagramWorker,
} from '../../src/renderer/components/markdown/diagram/diagram-render-queue';
import {
  DIAGRAM_FONT_FAMILY,
  DIAGRAM_FONT_SIZE_PX,
  type DiagramRenderRequest,
} from '../../src/renderer/components/markdown/diagram/diagram-protocol';
import { clearDiagramCache } from '../../src/renderer/components/markdown/diagram/use-diagram-render';
import { MarkdownContent } from '../../src/renderer/components/markdown/MarkdownContent';
import { MarkdownMessage } from '../../src/renderer/features/chat/MarkdownMessage';
import { MessageActivityItem } from '../../src/renderer/features/agent/AgentActivityItems';

/**
 * The worker thread is replaced by an in-process stand-in that answers with
 * the real Pele renderer, so these tests exercise real drawings, the real
 * queue and the real sanitizer; only the thread boundary is simulated (the
 * Electron E2E covers the real one).
 */
const host = vi.hoisted(() => ({
  hang: false,
  workers: [] as { terminated: boolean; posted: number }[],
  queue: null as DiagramRenderQueue | null,
}));

vi.mock('../../src/renderer/components/markdown/diagram/diagram-worker-host', () => ({
  diagramRenderQueue: (): DiagramRenderQueue => {
    if (host.queue === null) throw new Error('queue not prepared');
    return host.queue;
  },
}));

class InProcessWorker implements DiagramWorker {
  onmessage: DiagramWorker['onmessage'] = null;
  onerror: DiagramWorker['onerror'] = null;
  readonly record = { terminated: false, posted: 0 };
  postMessage(message: DiagramRenderRequest): void {
    this.record.posted += 1;
    if (host.hang) return;
    queueMicrotask(() => {
      if (this.record.terminated) return;
      const data = renderDiagramSource(message);
      this.onmessage?.({ data } as MessageEvent<typeof data>);
    });
  }
  terminate(): void {
    this.record.terminated = true;
  }
}

const FLOWCHART = '```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```';
const SEQUENCE = '```mermaid\nsequenceDiagram\n  User->>Agent: Ask\n  Agent-->>User: Answer\n```';

const citations = new Map<string, ChatCitation>([
  ['src-1', { sourceId: 'src-1', label: 'Page 1 · Overview', pageLabel: '1', heading: 'Overview' }],
]);
const onCitation = (): Promise<void> => Promise.resolve();

function decodedImages(): string[] {
  return screen.queryAllByTestId('markdown-diagram-image').map((image) => {
    const src = image.getAttribute('src') ?? '';
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const binary = atob(src.slice('data:image/svg+xml;base64,'.length));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  });
}

/** Anything in a drawing that could run, load or navigate. The SVG namespace URI is not a load. */
const ACTIVE_MARKUP = /<script|<foreignObject|<image|<img|<a[\s>]|<iframe|<use|href=|\son[a-z]+=|javascript:|https?:|url\(/iu;

function activeMarkup(svg: string): RegExpExecArray | null {
  return ACTIVE_MARKUP.exec(svg.replaceAll('http://www.w3.org/2000/svg', ''));
}

describe('AI output diagrams', () => {
  beforeEach(() => {
    host.hang = false;
    host.workers.length = 0;
    host.queue = createDiagramRenderQueue(
      () => {
        const worker = new InProcessWorker();
        host.workers.push(worker.record);
        return worker;
      },
      { timeoutMs: 80 },
    );
    clearDiagramCache();
  });

  afterEach(() => {
    cleanup();
    host.queue?.dispose();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
  });

  it('draws flowchart and sequence fences in a chat reply as inert images', async () => {
    render(<MarkdownMessage content={`Plan:\n\n${FLOWCHART}\n\nThen:\n\n${SEQUENCE}`} citations={citations} onCitation={onCitation} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('markdown-diagram')).toHaveLength(2);
    });
    expect(screen.getByRole('img', { name: 'Flowchart diagram' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sequence diagram' })).toBeTruthy();
    const [flowchart, sequence] = decodedImages();
    expect(flowchart).toContain('Start');
    expect(sequence).toContain('Answer');
    for (const svg of decodedImages()) expect(activeMarkup(svg)).toBeNull();
    expect(document.querySelector('figure svg:not([data-icon])')).toBeNull();
  });

  it('leaves other fences, math and citations as they were', async () => {
    const content = `See [src-1] and $e^{i\\pi}+1=0$.\n\n\`\`\`ts src/app.ts\nconst a = 1;\n\`\`\`\n\n${FLOWCHART}`;
    render(<MarkdownMessage content={content} citations={citations} onCitation={onCitation} />);

    await screen.findByTestId('markdown-diagram');
    expect(screen.getByRole('button', { name: 'p. 1' })).toBeTruthy();
    expect(document.querySelector('math')).toBeTruthy();
    const languages = screen.getAllByTestId('markdown-code-language').map((node) => node.textContent);
    expect(languages).toEqual(['ts']);
    expect(screen.getByTestId('markdown-code-filename').textContent).toBe('src/app.ts');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('shows the source while the reply streams and draws it once complete', async () => {
    const { rerender } = render(
      <MarkdownMessage content={`Drawing:\n\n\`\`\`mermaid\nflowchart LR\n  A --> B`} citations={citations} onCitation={onCitation} streaming />,
    );
    expect(screen.getByTestId('markdown-code-language').textContent).toBe('mermaid');
    rerender(<MarkdownMessage content={`Drawing:\n\n${FLOWCHART}`} citations={citations} onCitation={onCitation} streaming />);
    expect(screen.queryByTestId('markdown-diagram-pending')).toBeNull();
    expect(host.workers).toHaveLength(0);

    rerender(<MarkdownMessage content={`Drawing:\n\n${FLOWCHART}`} citations={citations} onCitation={onCitation} />);
    expect(await screen.findByTestId('markdown-diagram')).toBeTruthy();
  });

  it('keeps an unclosed fence in a finished reply as plain source', () => {
    render(<MarkdownMessage content={'```mermaid\nflowchart LR\n  A --> B'} citations={citations} onCitation={onCitation} />);
    expect(screen.getByTestId('markdown-code-language').textContent).toBe('mermaid');
    expect(screen.queryByTestId('markdown-diagram-pending')).toBeNull();
    expect(host.workers).toHaveLength(0);
  });

  it('falls back to escaped source with a short generic reason for a malformed diagram', async () => {
    const source = 'flowchart LR\n  A --> \n  ][ <b>bold</b>';
    render(<MarkdownMessage content={`\`\`\`mermaid\n${source}\n\`\`\``} citations={citations} onCitation={onCitation} />);

    const fallback = await screen.findByTestId('markdown-diagram-fallback');
    expect(within(fallback).getByRole('note').textContent).toBe("This diagram couldn't be read; showing its source.");
    expect(fallback.querySelector('code')?.textContent).toBe(source);
    expect(fallback.querySelector('b')).toBeNull();
  });

  it('refuses an oversized diagram without sending it to the worker', async () => {
    const huge = `flowchart TD\n${'  A --> B\n'.repeat(400)}`;
    render(<MarkdownMessage content={`\`\`\`mermaid\n${huge}\`\`\``} citations={citations} onCitation={onCitation} />);
    const fallback = await screen.findByTestId('markdown-diagram-fallback');
    expect(fallback.getAttribute('data-diagram-failure')).toBe('too-large');
    expect(host.workers).toHaveLength(0);
  });

  it('draws at most six diagrams per message and keeps the rest as source', async () => {
    const fences = Array.from({ length: 7 }, (_, i) => `\`\`\`mermaid\nflowchart LR\n  N${String(i)} --> M\n\`\`\``);
    render(<MarkdownMessage content={fences.join('\n\n')} citations={citations} onCitation={onCitation} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('markdown-diagram')).toHaveLength(6);
    });
    expect(screen.getAllByTestId('markdown-code-language').map((node) => node.textContent)).toEqual(['mermaid']);
  });

  it('falls back after the hard timeout and terminates the worker', async () => {
    host.hang = true;
    render(<MarkdownMessage content={FLOWCHART} citations={citations} onCitation={onCitation} />);
    expect(screen.getByTestId('markdown-diagram-pending').getAttribute('aria-busy')).toBe('true');
    const fallback = await screen.findByTestId('markdown-diagram-fallback');
    expect(fallback.getAttribute('data-diagram-failure')).toBe('timeout');
    expect(host.workers[0]?.terminated).toBe(true);
  });

  it('cancels a pending render on unmount', async () => {
    host.hang = true;
    const { unmount } = render(<MarkdownMessage content={FLOWCHART} citations={citations} onCitation={onCitation} />);
    expect(host.workers[0]?.posted).toBe(1);
    unmount();
    await waitFor(() => {
      expect(host.workers[0]?.terminated).toBe(true);
    });
  });

  it('drops a result for a source that is no longer shown', async () => {
    const { rerender } = render(<MarkdownMessage content={FLOWCHART} citations={citations} onCitation={onCitation} />);
    rerender(<MarkdownMessage content={SEQUENCE} citations={citations} onCitation={onCitation} />);
    await screen.findByTestId('markdown-diagram');
    expect(screen.getByRole('img', { name: 'Sequence diagram' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Flowchart diagram' })).toBeNull();
  });

  it('keeps hostile labels, links, clicks and directives inert', async () => {
    const hostile = [
      '```mermaid',
      "%%{init: {'securityLevel': 'loose'}}%%",
      'flowchart LR',
      '  A["<img src=x onerror=alert(1)>"] --> B["javascript:alert(1)"]',
      '  click A "https://evil.test/x"',
      '```',
    ].join('\n');
    render(<MarkdownMessage content={hostile} citations={citations} onCitation={onCitation} />);
    await waitFor(() => {
      expect(screen.queryByTestId('markdown-diagram-pending')).toBeNull();
    });
    for (const svg of decodedImages()) {
      expect(activeMarkup(svg.replaceAll('javascript:alert(1)', 'label'))).toBeNull();
      expect(svg).not.toContain('evil.test');
      expect(svg).not.toMatch(/<img/iu);
    }
    expect(document.querySelector('script, foreignObject, iframe, a[href]')).toBeNull();
  });

  it('reveals the copyable source from a keyboard-operable toggle', async () => {
    const { container } = render(<MarkdownMessage content={FLOWCHART} citations={citations} onCitation={onCitation} />);
    const toggle = await screen.findByRole('button', { name: 'Show source' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('region', { name: 'Flowchart diagram' }).getAttribute('tabindex')).toBe('0');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide source' }).getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('code')?.textContent).toBe('flowchart LR\n  A[Start] --> B[Finish]');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('redraws the picture in the new palette when the theme changes', async () => {
    document.documentElement.style.setProperty('--text-primary', '#1c1917');
    render(<MarkdownMessage content={FLOWCHART} citations={citations} onCitation={onCitation} />);
    await screen.findByTestId('markdown-diagram');
    const before = decodedImages()[0] ?? '';
    act(() => {
      document.documentElement.style.setProperty('--text-primary', '#f1f3f5');
      document.documentElement.setAttribute('data-theme', 'midnight');
    });
    await waitFor(() => {
      expect(decodedImages()[0]).toContain('#f1f3f5');
    });
    expect(before).not.toContain('#f1f3f5');
  });

  it('displays the picture in the font size it was measured in', async () => {
    const wide = `\`\`\`mermaid\nflowchart LR\n  A[${'W'.repeat(40)}] --> B\n\`\`\``;
    render(<MarkdownMessage content={wide} citations={citations} onCitation={onCitation} />);
    await screen.findByTestId('markdown-diagram');
    const svg = new DOMParser().parseFromString(decodedImages()[0] ?? '', 'image/svg+xml').documentElement;
    const declarations = (svg.getAttribute('style') ?? '').split(';');
    expect(declarations).toContain(`font-size:${String(DIAGRAM_FONT_SIZE_PX)}px`);
    expect(declarations).toContain(`font-family:${DIAGRAM_FONT_FAMILY}`);
    expect(declarations.filter((declaration) => declaration.startsWith('font-size:'))).toHaveLength(1);
  });

  it('draws diagrams in agent messages, and notes keep mermaid as code', async () => {
    render(<MessageActivityItem activity={{ kind: 'message', id: 'm1', text: `Here is the flow:\n\n${FLOWCHART}` }} />);
    expect(await screen.findByTestId('markdown-diagram')).toBeTruthy();
    cleanup();

    render(<MarkdownContent content={FLOWCHART} />);
    expect(screen.getByTestId('markdown-code-language').textContent).toBe('mermaid');
    expect(screen.queryByTestId('markdown-diagram-pending')).toBeNull();
  });
});
