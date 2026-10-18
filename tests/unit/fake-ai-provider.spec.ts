import { describe, expect, it } from 'vitest';
import { FakeAIProvider } from '@main/ai/providers/fake-ai-provider';

/**
 * Runs a stream to completion and returns what it produced. Collecting the
 * events rather than throwing them away keeps the loop binding used, so
 * draining a stream to observe its failure needs no lint suppression.
 */
async function drainStream<T>(stream: AsyncIterable<T>): Promise<readonly T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const request = {
  requestId: '81b75ab1-888b-4a1e-95a8-022f35033523',
  modelId: 'fake-grounded',
  systemPrompt: 'System',
  contextXml: '<document/>',
  history: [],
  userMessage: 'Summarize this passage',
  sources: [{
    sourceId: 'src-1',
    documentId: 'doc',
    documentHash: 'hash',
    documentTitle: 'Title',
    documentFormat: 'pdf' as const,
    chunkId: 'chunk',
    contextItemId: null,
    location: { format: 'pdf' as const, pageIndex: 0 },
    excerptText: 'Text',
    excerptHash: 'excerpt',
    heading: null,
    pageLabel: '1',
    label: 'Page 1',
  }],
  webSearch: false,
};

describe('FakeAIProvider', () => {
  it('streams a deterministic grounded citation without external calls', async () => {
    const provider = new FakeAIProvider();
    let output = '';
    for await (const event of provider.streamChat(request)) {
      if (event.type === 'token') output += event.token;
    }
    expect(output).toContain('[src-1]');
    expect(await provider.detect()).toMatchObject({ available: true, authentication: 'connected' });
  });

  it('stops an active deterministic stream', async () => {
    const provider = new FakeAIProvider();
    let tokens = 0;
    for await (const event of provider.streamChat({ ...request, requestId: 'b5c5e12e-f5ea-4e6e-a842-2d57ee2d38c2' })) {
      if (event.type === 'token') {
        tokens += 1;
        await provider.cancel('b5c5e12e-f5ea-4e6e-a842-2d57ee2d38c2');
      }
    }
    expect(tokens).toBe(1);
  });
  it('throws simulated error when question contains error-trigger', async () => {
    const provider = new FakeAIProvider();
    const errorRequest = { ...request, userMessage: 'Please error-trigger now' };
    await expect(drainStream(provider.streamChat(errorRequest))).rejects.toThrow(
      /Simulated deterministic provider failure/i
    );
  });

  it('keeps Markdown fixture output opt-in so normal fake responses stay unchanged', async () => {
    const normalProvider = new FakeAIProvider();
    let normalOutput = '';
    for await (const event of normalProvider.streamChat({ ...request, userMessage: 'Please explain Markdown syntax' })) {
      if (event.type === 'token') normalOutput += event.token;
    }
    expect(normalOutput).not.toContain('### Grounded Markdown');

    const fixtureProvider = new FakeAIProvider({ enableMarkdownFixture: true });
    let fixtureOutput = '';
    for await (const event of fixtureProvider.streamChat({ ...request, userMessage: 'Please explain Markdown syntax' })) {
      if (event.type === 'token') fixtureOutput += event.token;
    }
    expect(fixtureOutput).toContain('### Grounded Markdown');
  });
});
