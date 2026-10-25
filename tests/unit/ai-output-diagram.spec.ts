import { afterEach, describe, expect, it, vi } from 'vitest';
import { Marked, type Tokens } from 'marked';
import { renderDiagramSource } from '../../src/renderer/components/markdown/diagram/pele-render-core';
import {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_CHARS,
  MAX_DIAGRAM_SOURCE_LINES,
  MAX_DIAGRAM_SVG_CHARS,
  parseDiagramResponse,
  sourceLimitFailure,
  type DiagramRenderRequest,
} from '../../src/renderer/components/markdown/diagram/diagram-protocol';
import {
  createDiagramRenderQueue,
  type DiagramWorker,
} from '../../src/renderer/components/markdown/diagram/diagram-render-queue';
import {
  isClosedFence,
  isMermaidFence,
  selectDiagramFences,
} from '../../src/renderer/components/markdown/diagram/diagram-fence';

const FLOWCHART = 'flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A';
const SEQUENCE = 'sequenceDiagram\n  participant U as User\n  participant A as Agent\n  U->>A: Ask\n  A-->>U: Answer';

describe('renderDiagramSource (real Pele)', () => {
  it('draws a flowchart', () => {
    const result = renderDiagramSource({ id: 1, source: FLOWCHART });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('flowchart');
    expect(result.svg).toContain('<svg');
    expect(result.svg).toContain('Start');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('draws a sequence diagram', () => {
    const result = renderDiagramSource({ id: 2, source: SEQUENCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('sequence');
    expect(result.svg).toContain('Answer');
  });

  it('reports a category for malformed and unsupported sources, never the library message', () => {
    const invalid = renderDiagramSource({ id: 3, source: 'flowchart LR\n  A --> \n  ][ <script>' });
    expect(invalid).toEqual({ id: 3, ok: false, failure: 'invalid' });
    const unsupported = renderDiagramSource({ id: 4, source: 'notADiagram\n  x' });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) return;
    expect(['unsupported', 'invalid']).toContain(unsupported.failure);
    expect(Object.keys(unsupported)).toEqual(['id', 'ok', 'failure']);
  });

  it('refuses sources over the character, line and edge bounds before parsing', () => {
    const long = `flowchart LR\n  A[${'x'.repeat(MAX_DIAGRAM_SOURCE_CHARS)}] --> B`;
    expect(renderDiagramSource({ id: 5, source: long })).toEqual({ id: 5, ok: false, failure: 'too-large' });
    const tall = `flowchart TD\n${'  A --> B\n'.repeat(MAX_DIAGRAM_SOURCE_LINES)}`;
    expect(renderDiagramSource({ id: 6, source: tall })).toEqual({ id: 6, ok: false, failure: 'too-large' });
    const edges = `flowchart LR\n${Array.from({ length: 250 }, (_, i) => `n${String(i)}-->n${String(i + 1)}`).join(';')}`;
    expect(renderDiagramSource({ id: 7, source: edges })).toEqual({ id: 7, ok: false, failure: 'too-large' });
    expect(renderDiagramSource({ id: 8, source: '   ' })).toEqual({ id: 8, ok: false, failure: 'invalid' });
  });

  it('keeps hostile labels, links, clicks and directives out of the drawing', () => {
    const hostile = [
      "%%{init: {'securityLevel': 'loose', 'theme': 'base'}}%%",
      'flowchart LR',
      '  A["<img src=x onerror=alert(1)><script>alert(1)</script>"] --> B[<a href="https://evil.test">x</a>]',
      '  click A "https://evil.test" "tip"',
      '  click B call alert()',
    ].join('\n');
    const result = renderDiagramSource({ id: 9, source: hostile });
    if (!result.ok) {
      expect(['invalid', 'unsupported']).toContain(result.failure);
      return;
    }
    expect(result.svg).not.toMatch(/<script|<img|<a[\s>]|onerror=|<foreignObject|href=/iu);
    expect(result.svg).not.toContain('evil.test');
  });
});

describe('sourceLimitFailure and parseDiagramResponse', () => {
  it('bounds source before it is queued', () => {
    expect(sourceLimitFailure(FLOWCHART)).toBeNull();
    expect(sourceLimitFailure('')).toBe('invalid');
    expect(sourceLimitFailure('x'.repeat(MAX_DIAGRAM_SOURCE_CHARS + 1))).toBe('too-large');
  });

  it('accepts only a well-formed answer to the current request', () => {
    const ok = { id: 4, ok: true, svg: '<svg/>', width: 10, height: 10, kind: 'flowchart' };
    expect(parseDiagramResponse(ok, 4)).toEqual(ok);
    expect(parseDiagramResponse(ok, 5)).toBeNull();
    expect(parseDiagramResponse(null, 4)).toBeNull();
    expect(parseDiagramResponse([ok], 4)).toBeNull();
    expect(parseDiagramResponse({ id: 4, ok: 'yes' }, 4)).toBeNull();
    expect(parseDiagramResponse({ id: 4, ok: false, failure: '<b>boom</b>' }, 4)).toEqual({ id: 4, ok: false, failure: 'failed' });
    expect(parseDiagramResponse({ ...ok, svg: '' }, 4)).toEqual({ id: 4, ok: false, failure: 'failed' });
    expect(parseDiagramResponse({ ...ok, svg: 'x'.repeat(MAX_DIAGRAM_SVG_CHARS + 1) }, 4)).toEqual({ id: 4, ok: false, failure: 'too-large' });
    expect(parseDiagramResponse({ ...ok, width: MAX_DIAGRAM_DIMENSION + 1 }, 4)).toEqual({ id: 4, ok: false, failure: 'too-large' });
    expect(parseDiagramResponse({ ...ok, height: Number.NaN }, 4)).toEqual({ id: 4, ok: false, failure: 'too-large' });
    expect(parseDiagramResponse({ ...ok, kind: '<script>' }, 4)).toEqual({ ...ok, kind: 'diagram' });
  });
});

/** A worker the test answers by hand. */
class FakeWorker implements DiagramWorker {
  onmessage: DiagramWorker['onmessage'] = null;
  onerror: DiagramWorker['onerror'] = null;
  readonly posted: DiagramRenderRequest[] = [];
  terminated = false;
  postMessage(message: DiagramRenderRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: Parameters<typeof parseDiagramResponse>[0]): void {
    this.onmessage?.({ data } as MessageEvent<typeof data>);
  }
  /** Answers the last request with the real renderer, as the worker would. */
  answer(): void {
    const request = this.posted[this.posted.length - 1];
    if (request !== undefined) this.reply(renderDiagramSource(request));
  }
}

function harness(options: Parameters<typeof createDiagramRenderQueue>[1] = {}) {
  const workers: FakeWorker[] = [];
  const queue = createDiagramRenderQueue(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, options);
  return { queue, workers, latest: (): FakeWorker => workers[workers.length - 1] ?? new FakeWorker() };
}

describe('createDiagramRenderQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one render at a time and answers in order', async () => {
    const { queue, latest } = harness();
    const first = queue.render(FLOWCHART);
    const second = queue.render(SEQUENCE);
    expect(latest().posted).toHaveLength(1);
    latest().answer();
    await expect(first).resolves.toMatchObject({ ok: true, kind: 'flowchart' });
    expect(latest().posted).toHaveLength(2);
    latest().answer();
    await expect(second).resolves.toMatchObject({ ok: true, kind: 'sequence' });
  });

  it('ignores a stale or malformed answer and waits for the real one', async () => {
    const { queue, latest } = harness();
    const pending = queue.render(FLOWCHART);
    latest().reply({ id: 999, ok: true, svg: '<svg/>', width: 1, height: 1, kind: 'x' });
    latest().reply('nonsense');
    latest().answer();
    await expect(pending).resolves.toMatchObject({ ok: true, kind: 'flowchart' });
  });

  it('terminates a render that outlives its timeout and starts a fresh worker', async () => {
    vi.useFakeTimers();
    const { queue, workers, latest } = harness({ timeoutMs: 50 });
    const stuck = queue.render(FLOWCHART);
    const next = queue.render(SEQUENCE);
    vi.advanceTimersByTime(51);
    await expect(stuck).resolves.toEqual({ ok: false, failure: 'timeout' });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[0]?.answer();
    latest().answer();
    await expect(next).resolves.toMatchObject({ ok: true, kind: 'sequence' });
  });

  it('cancels an active render by terminating the worker, and a queued one by dropping it', async () => {
    const { queue, workers } = harness();
    const active = new AbortController();
    const queued = new AbortController();
    const first = queue.render(FLOWCHART, active.signal);
    const second = queue.render(SEQUENCE, queued.signal);
    queued.abort();
    await expect(second).resolves.toEqual({ ok: false, failure: 'failed' });
    active.abort();
    await expect(first).resolves.toEqual({ ok: false, failure: 'failed' });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[0]?.posted).toHaveLength(1);
  });

  it('refuses renders beyond the bounded queue as busy', async () => {
    const { queue } = harness({ maxQueued: 1 });
    void queue.render(FLOWCHART);
    void queue.render(SEQUENCE);
    await expect(queue.render(FLOWCHART)).resolves.toEqual({ ok: false, failure: 'busy' });
  });

  it('refuses out-of-bounds sources without posting them', async () => {
    const { queue, workers } = harness();
    await expect(queue.render('x'.repeat(MAX_DIAGRAM_SOURCE_CHARS + 1))).resolves.toEqual({ ok: false, failure: 'too-large' });
    expect(workers).toHaveLength(0);
  });

  it('reports a worker error as a failure and recovers', async () => {
    const { queue, workers, latest } = harness();
    const broken = queue.render(FLOWCHART);
    latest().onerror?.({} as ErrorEvent);
    await expect(broken).resolves.toEqual({ ok: false, failure: 'failed' });
    expect(workers[0]?.terminated).toBe(true);
    const next = queue.render(SEQUENCE);
    latest().answer();
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('stops an idle worker, and dispose settles everything pending', async () => {
    vi.useFakeTimers();
    const { queue, workers, latest } = harness({ idleMs: 100 });
    const done = queue.render(FLOWCHART);
    latest().answer();
    await done;
    vi.advanceTimersByTime(101);
    expect(workers[0]?.terminated).toBe(true);
    const a = queue.render(FLOWCHART);
    const b = queue.render(SEQUENCE);
    queue.dispose();
    await expect(a).resolves.toEqual({ ok: false, failure: 'failed' });
    await expect(b).resolves.toEqual({ ok: false, failure: 'failed' });
    expect(workers[1]?.terminated).toBe(true);
  });

  it('rejects a worker answer that exceeds the output bounds', async () => {
    const { queue, latest } = harness();
    const pending = queue.render(FLOWCHART);
    latest().reply({ id: 1, ok: true, svg: '<svg><script>alert(1)</script></svg>', width: 1e9, height: 1, kind: 'x' });
    await expect(pending).resolves.toEqual({ ok: false, failure: 'too-large' });
  });
});

describe('diagram fence selection', () => {
  const marked = new Marked({ gfm: true });
  const codeTokens = (markdown: string): Tokens.Code[] =>
    marked.lexer(markdown).filter((token): token is Tokens.Code => token.type === 'code');

  it('recognises mermaid fences by their first info word', () => {
    const [plain, upper, attrs, other] = codeTokens('```mermaid\na\n```\n\n```MERMAID\na\n```\n\n```mermaid title=x\na\n```\n\n```ts\na\n```');
    expect(plain && isMermaidFence(plain)).toBe(true);
    expect(upper && isMermaidFence(upper)).toBe(true);
    expect(attrs && isMermaidFence(attrs)).toBe(true);
    expect(other && isMermaidFence(other)).toBe(false);
  });

  it('treats a fence without its closing line as unfinished', () => {
    expect(isClosedFence('```mermaid\nflowchart LR\n```')).toBe(true);
    expect(isClosedFence('~~~~mermaid\na\n~~~~~\n')).toBe(true);
    expect(isClosedFence('```mermaid\nflowchart LR\n  A --> B')).toBe(false);
    expect(isClosedFence('````mermaid\na\n```')).toBe(false);
    expect(isClosedFence('```mermaid\na\n~~~')).toBe(false);
    expect(isClosedFence('```mermaid')).toBe(false);
  });

  it('selects complete fences in order, including nested ones, up to the cap', () => {
    const fence = (n: number): string => `\`\`\`mermaid\nflowchart LR\n  A${String(n)} --> B\n\`\`\``;
    const source = `${fence(1)}\n\n> ${fence(2).split('\n').join('\n> ')}\n\n- item\n\n  ${fence(3).split('\n').join('\n  ')}\n\n${fence(4)}\n\n\`\`\`mermaid\nflowchart LR\n  open`;
    const tokens = marked.lexer(source);
    const all = [...selectDiagramFences(tokens, 10)].map((code) => code.text);
    expect(all).toHaveLength(4);
    expect(all[0]).toContain('A1');
    expect(all.some((text) => text.includes('A2'))).toBe(true);
    expect(all.some((text) => text.includes('A3'))).toBe(true);
    expect(all.some((text) => text.includes('open'))).toBe(false);
    expect(selectDiagramFences(tokens, 2).size).toBe(2);
  });
});
