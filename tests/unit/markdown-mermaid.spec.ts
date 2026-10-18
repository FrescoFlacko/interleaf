// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERMAID_LIMITS } from '@shared/schemas/mermaid';
import type { MermaidRenderRequest, MermaidRenderResult } from '@shared/types/mermaid';
import { MarkdownAdapter } from '../../src/renderer/features/reader/adapters/markdown-adapter';
import { stubBridge } from '../helpers/interleaf-api';
import { testDocumentSource } from '../helpers/document-source';

const DIAGRAM_SOURCE = 'flowchart TD\n  A[Start] --> B[End]';
const DIAGRAM_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#a)"/></svg>';

const originalFetch = globalThis.fetch;

type Bridge = { renderMermaid: (request: MermaidRenderRequest) => Promise<MermaidRenderResult> };

function installBridge(renderMermaid: Bridge['renderMermaid']): void {
  stubBridge({ reader: { renderMermaid } });
}

function serveMarkdown(text: string): void {
  const bytes = new TextEncoder().encode(text);
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(bytes.buffer, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })
  );
}

async function openMarkdown(
  adapter: MarkdownAdapter,
  text: string,
  documentId = 'doc-mermaid'
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  serveMarkdown(text);
  await adapter.open(container, testDocumentSource({ documentId, assetUrl: `test://${documentId}.md` }));
  return container;
}

/** A promise whose settlement a test decides, without narrowing surprises. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value) => { box.resolve(value); } };
}

function rendered(): MermaidRenderResult {
  return { status: 'rendered', svg: DIAGRAM_SVG, width: 120, height: 80 };
}

beforeEach(() => {
  installBridge(() => Promise.resolve(rendered()));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll('style')) style.remove();
  vi.restoreAllMocks();
});

describe('markdown diagrams: recognition and drawing', () => {
  it('draws a fenced mermaid block as an image beside its source', async () => {
    const calls: MermaidRenderRequest[] = [];
    installBridge((request) => {
      calls.push(request);
      return Promise.resolve(rendered());
    });
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `Intro.\n\n\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    await vi.waitFor(() => {
      expect(container.querySelector('.markdown-mermaid-image')).not.toBeNull();
    });

    expect(calls).toEqual([{ source: DIAGRAM_SOURCE, appearance: 'light' }]);
    const image = container.querySelector<HTMLImageElement>('.markdown-mermaid-image');
    expect(image?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(image?.width).toBe(120);
    expect(image?.height).toBe(80);
    // The picture is named for anyone who cannot see it, and the label says
    // where the source is.
    expect(image?.alt).toBe('Flowchart. The diagram source is shown below.');
    await adapter.close();
  });

  it('never inserts renderer markup into the reader as live nodes', async () => {
    installBridge(() =>
      Promise.resolve({
        status: 'rendered',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        width: 10,
        height: 10,
      } as const)
    );
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    await vi.waitFor(() => {
      expect(container.querySelector('.markdown-mermaid-image')).not.toBeNull();
    });

    // The drawing is an image source, never document structure the reader's own
    // DOM contains.
    expect(container.querySelector('svg')).toBeNull();
    await adapter.close();
  });

  it('leaves an ordinary fenced code block alone', async () => {
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, '```ts\nconst a = 1;\n```\n');
    await Promise.resolve();

    expect(container.querySelector('.markdown-mermaid')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-code-block-0"]')).not.toBeNull();
    await adapter.close();
  });
});

describe('markdown diagrams: source metadata does not drift', () => {
  it('keeps exactly one block element per block index', async () => {
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(
      adapter,
      `Intro.\n\n\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n\nOutro.\n`
    );

    const blocks = container.querySelectorAll('[data-markdown-block]');
    expect([...blocks].map((element) => element.getAttribute('data-markdown-block'))).toEqual([
      '0',
      '1',
      '2',
    ]);
    // The illustration is the block element; the `<pre>` inside it no longer
    // claims to be one, so every `closest()` walk still finds one answer.
    const figure = container.querySelector('[data-testid="markdown-mermaid-1"]');
    expect(figure?.tagName).toBe('FIGURE');
    expect(container.querySelector('[data-testid="markdown-code-block-1"]')?.hasAttribute('data-markdown-block')).toBe(false);
    await adapter.close();
  });

  it('keeps the fenced source as the block text before and after drawing', async () => {
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    const textRoot = () =>
      container
        .querySelector('[data-testid="markdown-mermaid-0"]')
        ?.querySelector('.markdown-block-content')?.textContent;

    expect(textRoot()).toBe(DIAGRAM_SOURCE);
    await vi.waitFor(() => {
      expect(container.querySelector('.markdown-mermaid-image')).not.toBeNull();
    });
    // A picture appeared and not one character of the block's text moved.
    expect(textRoot()).toBe(DIAGRAM_SOURCE);
    await adapter.close();
  });

  it('keeps the diagram source searchable and inside the annotation scope', async () => {
    const adapter = new MarkdownAdapter();
    await openMarkdown(adapter, `Intro.\n\n\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n\nOutro.\n`);

    expect(adapter.getAnnotationScope()).toEqual({
      format: 'markdown',
      blockStart: 0,
      blockEnd: 2,
    });
    const matches = await adapter.search('flowchart');
    expect(matches).toHaveLength(1);
    const location = matches[0]?.location;
    expect(location?.format === 'markdown' ? location.blockIndex : null).toBe(1);

    const chunks: string[] = [];
    for await (const chunk of adapter.extractText()) chunks.push(chunk.text);
    expect(chunks.join('\n')).toContain(DIAGRAM_SOURCE);
    await adapter.close();
  });
});

describe('markdown diagrams: failure never costs the document', () => {
  it.each([
    ['invalid-syntax', 'not valid Mermaid'],
    ['timeout', 'took too long'],
    ['rejected-output', 'safety check'],
  ] as const)('shows the source and one sentence when a diagram fails (%s)', async (reason, wording) => {
    installBridge(() => Promise.resolve({ status: 'failed', reason } as const));
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `Intro.\n\n\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    const note = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="markdown-mermaid-note-1"]'
      );
      expect(element?.hidden).toBe(false);
      return element;
    });

    expect(note?.textContent).toContain(wording);
    expect(container.querySelector<HTMLElement>('.markdown-mermaid-diagram')?.hidden).toBe(true);
    // The rest of the document rendered exactly as it always does.
    expect(container.querySelector('[data-testid="markdown-paragraph-0"]')?.textContent).toBe(
      'Intro.'
    );
    expect(
      container.querySelector('[data-testid="markdown-code-block-1"]')?.textContent
    ).toBe(DIAGRAM_SOURCE);
    await adapter.close();
  });

  it('keeps reading the document when the bridge itself rejects', async () => {
    installBridge(() => Promise.reject(new Error('ipc is down')));
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLElement>('[data-testid="markdown-mermaid-note-0"]')?.hidden
      ).toBe(false);
    });
    expect(container.querySelector('[data-testid="markdown-code-block-0"]')).not.toBeNull();
    await adapter.close();
  });

  it('draws only the first diagrams of a document and explains the rest', async () => {
    const requests: MermaidRenderRequest[] = [];
    installBridge((request) => {
      requests.push(request);
      return Promise.resolve(rendered());
    });
    const fences = Array.from(
      { length: MERMAID_LIMITS.maxDiagramsPerDocument + 2 },
      () => `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\``
    ).join('\n\n');
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `${fences}\n`);

    const lastIndex = MERMAID_LIMITS.maxDiagramsPerDocument + 1;
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(
          `[data-testid="markdown-mermaid-note-${String(lastIndex)}"]`
        )?.hidden
      ).toBe(false);
    });

    expect(requests).toHaveLength(MERMAID_LIMITS.maxDiagramsPerDocument);
    expect(
      container.querySelector<HTMLElement>(
        `[data-testid="markdown-mermaid-note-${String(lastIndex)}"]`
      )?.textContent
    ).toContain(String(MERMAID_LIMITS.maxDiagramsPerDocument));
    // The over-budget fences still read as ordinary code blocks.
    expect(
      container.querySelector(`[data-testid="markdown-code-block-${String(lastIndex)}"]`)
    ).not.toBeNull();
    await adapter.close();
  });
});

describe('markdown diagrams: appearance follows the surface it is read against', () => {
  /** A rule the reader's stylesheet could have carried, applied when a test says. */
  function paint(css: string): HTMLStyleElement {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  }

  it('is decided from the diagram card, not the page behind it', async () => {
    paint('body { background-color: rgb(8, 8, 8); } .markdown-mermaid-diagram { background-color: rgb(250, 250, 250); }');
    const calls: MermaidRenderRequest[] = [];
    installBridge((request) => {
      calls.push(request);
      return Promise.resolve(rendered());
    });
    const adapter = new MarkdownAdapter();
    await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    // The picture sits on a light card, so it is drawn light however dark the
    // page around it is.
    expect(calls[0]?.appearance).toBe('light');
    await adapter.close();
  });

  it('waits out the reader crossfade before deciding the new appearance', async () => {
    const calls: MermaidRenderRequest[] = [];
    installBridge((request) => {
      calls.push(request);
      return Promise.resolve(rendered());
    });
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.appearance).toBe('light');

    const wrapper = container.querySelector<HTMLElement>('[data-testid="markdown-content-wrapper"]');
    wrapper?.style.setProperty('transition-duration', '0.08s');
    // The palette attribute lands first and the surface only reaches its new
    // colour part-way through the transition, which is exactly the window a
    // same-tick reading would answer from.
    document.documentElement.setAttribute('data-theme', 'midnight');
    setTimeout(() => {
      paint('.markdown-mermaid-diagram { background-color: rgb(12, 12, 12); }');
    }, 40);

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.appearance).toBe('dark');
    document.documentElement.removeAttribute('data-theme');
    await adapter.close();
  });

  it('drops a pending appearance check when the document closes', async () => {
    const calls: MermaidRenderRequest[] = [];
    installBridge((request) => {
      calls.push(request);
      return Promise.resolve(rendered());
    });
    const adapter = new MarkdownAdapter();
    await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    paint('.markdown-mermaid-diagram { background-color: rgb(12, 12, 12); }');
    document.documentElement.setAttribute('data-theme', 'midnight');
    await adapter.close();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Nothing redraws for a reader that is gone.
    expect(calls).toHaveLength(1);
    expect(document.querySelectorAll('.markdown-mermaid-image')).toHaveLength(0);
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('markdown diagrams: late replies cannot reach a stale reader', () => {
  it('drops a reply that arrives after the document was closed', async () => {
    let asked = false;
    const reply = deferred<MermaidRenderResult>();
    installBridge(() => {
      asked = true;
      return reply.promise;
    });
    const adapter = new MarkdownAdapter();
    const container = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);
    await vi.waitFor(() => {
      expect(asked).toBe(true);
    });

    await adapter.close();
    reply.resolve(rendered());
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.markdown-mermaid-image')).toBeNull();
    expect(document.querySelectorAll('.markdown-mermaid-image')).toHaveLength(0);
  });

  it('draws into the reopened document rather than the one that was replaced', async () => {
    const pending: { resolve: (value: MermaidRenderResult) => void }[] = [];
    installBridge(() => {
      const next = deferred<MermaidRenderResult>();
      pending.push(next);
      return next.promise;
    });
    const adapter = new MarkdownAdapter();
    const first = await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`, 'doc-a');
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });

    const second = await openMarkdown(
      adapter,
      `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`,
      'doc-b'
    );
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });

    // The abandoned reader's reply comes back first and must change nothing.
    pending[0]?.resolve(rendered());
    await Promise.resolve();
    expect(first.querySelector('.markdown-mermaid-image')).toBeNull();

    pending[1]?.resolve(rendered());
    await vi.waitFor(() => {
      expect(second.querySelector('.markdown-mermaid-image')).not.toBeNull();
    });
    await adapter.close();
  });

  it('stops observing the page once the document is closed', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const adapter = new MarkdownAdapter();
    await openMarkdown(adapter, `\`\`\`mermaid\n${DIAGRAM_SOURCE}\n\`\`\`\n`);
    const before = disconnect.mock.calls.length;

    await adapter.close();

    expect(disconnect.mock.calls.length).toBeGreaterThan(before);
  });
});
