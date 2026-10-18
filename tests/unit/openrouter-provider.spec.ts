import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rejectionOf } from '../helpers/errors';
import { isPortableRecord, parsePortableJson, type PortableRecord } from '@shared/models/portable';
import {
  OpenRouterProvider,
  DEFAULT_OPENROUTER_MODEL,
  SseEventParser,
  type OpenRouterKeyStore,
  type OpenRouterSettingsStore,
} from '@main/ai/providers/openrouter-provider';
import type { ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import { appSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings, type AppSettingsInput } from '@shared/schemas/settings';
import { CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS, OPENROUTER_AUTH_FAILED_MESSAGE } from '@shared/constants/ai';
import type { ChatWebSource } from '@shared/types/ai';
import { UNCONFIGURED_CREDENTIAL_STATUS, USABLE_CREDENTIAL_STORAGE } from '../helpers/credential-status';
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

const request: ProviderChatRequest = {
  requestId: '550e8400-e29b-41d4-a716-446655440000',
  modelId: 'openrouter/auto',
  systemPrompt: 'System prompt',
  contextXml: '<document title="Guide" format="pdf"/>',
  history: [],
  userMessage: 'What is this?',
  sources: [],
  webSearch: false,
};

describe('OpenRouterProvider', () => {
  let mockVault: OpenRouterKeyStore;
  let storedKey: string | null;

  beforeEach(() => {
    storedKey = 'sk-or-v1-mock-key';
    mockVault = {
      getOpenRouterKey: vi.fn(() => Promise.resolve(storedKey)),
      hasOpenRouterKey: vi.fn(() => Promise.resolve(storedKey !== null)),
      setOpenRouterKey: vi.fn((key: string) => {
        storedKey = key;
        return Promise.resolve();
      }),
      clearOpenRouterKey: vi.fn(() => {
        storedKey = null;
        return Promise.resolve();
      }),
      describeStorage: vi.fn(() => USABLE_CREDENTIAL_STORAGE),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects available status based on credential vault configuration', async () => {
    const provider = new OpenRouterProvider(mockVault);
    expect(await provider.detect()).toMatchObject({
      id: 'openrouter',
      available: true,
      authentication: 'connected',
    });

    storedKey = null;
    expect(await provider.detect()).toMatchObject({
      available: false,
      authentication: 'disconnected',
    });
  });

  it('streams tokens from SSE stream and yields done event', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    const tokens: string[] = [];
    let completed = false;

    for await (const event of provider.streamChat(request)) {
      if (event.type === 'token') {
        tokens.push(event.token);
      } else {
        completed = true;
        expect(event.totalTokens).toBe(2);
      }
    }

    expect(tokens.join('')).toBe('Hello world');
    expect(completed).toBe(true);
  });

  it('handles multiline data lines and flushes at EOF without trailing newline', () => {
    const parser = new SseEventParser();
    const feedEvents = parser.feed('data: line1\ndata: line2\n\ndata: line3');
    expect(feedEvents).toEqual(['line1\nline2']);
    expect(parser.remainder).toBe('data: line3');

    const flushed = parser.flush(parser.remainder);
    expect(flushed).toEqual(['line3']);
  });

  it('surfaces in-band 200 error objects from data stream', async () => {
    const sseChunks = [
      'data: {"error":{"message":"Rate limit exceeded for model","code":429}}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    await expect(drainStream(provider.streamChat(request))).rejects.toThrow(/Rate limit exceeded/i);
  });

  it.each([401, 403])('names a refused key (%i) with the one typed message and never the provider text', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'No auth credentials found for sk-or-v1-leaked' } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    const thrown = await rejectionOf(drainStream(provider.streamChat(request)));
    expect(thrown.message).toBe(OPENROUTER_AUTH_FAILED_MESSAGE);
    expect(thrown.message).not.toContain('sk-or-v1');
  });

  it('splits large token chunks (>65,536 units) into safe events without data loss', async () => {
    const hugeToken = 'A'.repeat(70_000);
    const sseChunks = [
      `data: {"choices":[{"delta":{"content":"${hugeToken}"}}]}\n\n`,
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    const tokens: string[] = [];

    for await (const event of provider.streamChat(request)) {
      if (event.type === 'token') {
        tokens.push(event.token);
      }
    }

    expect(tokens.length).toBe(2);
    expect(tokens[0]?.length).toBe(65_536);
    expect(tokens[1]?.length).toBe(70_000 - 65_536);
    expect(tokens.join('')).toBe(hugeToken);
  });

  it('validates model selection and rejects invalid model IDs', async () => {
    const provider = new OpenRouterProvider(mockVault);
    const models = await provider.listModels();
    expect(models).toEqual([DEFAULT_OPENROUTER_MODEL]);

    expect(provider.resolveModel(null)).toEqual(DEFAULT_OPENROUTER_MODEL);
    expect(provider.resolveModel('openrouter/auto')).toEqual(DEFAULT_OPENROUTER_MODEL);

    const custom = provider.resolveModel('anthropic/claude-3.5-sonnet');
    expect(custom.id).toBe('anthropic/claude-3.5-sonnet');

    const thinking = provider.resolveModel('anthropic/claude-3.7-sonnet:thinking');
    expect(thinking.id).toBe('anthropic/claude-3.7-sonnet:thinking');

    const freeVariant = provider.resolveModel('arcee-ai/trinity-large-preview:free');
    expect(freeVariant.id).toBe('arcee-ai/trinity-large-preview:free');

    expect(() => provider.resolveModel('')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('   ')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('model')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('org/team/model')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('org/model:free:nitro')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('invalid model with spaces')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('malicious/../../traversal')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel('invalid:colon:')).toThrow(/Invalid OpenRouter model ID/i);
    expect(() => provider.resolveModel(':leading/colon')).toThrow(/Invalid OpenRouter model ID/i);
  });

  it('tests connection using vaulted key and bounded response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { label: 'Interleaf Key' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    const result = await provider.testConnection();
    expect(result.success).toBe(true);
    expect(result.message).toContain('verified successfully');
  });

  it('explains a rejected key in plain words, without the status code or the key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":{"message":"Invalid API key"}}', { status: 401, headers: { 'Content-Type': 'application/json' } })
    );

    const result = await new OpenRouterProvider(mockVault).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/did not accept this API key/u);
    expect(result.message).not.toMatch(/401/u);
    expect(result.message).not.toContain('sk-or-v1-mock-key');
  });

  it('throws validation error when API key is missing', async () => {
    storedKey = null;
    const provider = new OpenRouterProvider(mockVault);

    await expect(drainStream(provider.streamChat(request))).rejects.toThrow(
      /OpenRouter API key is not configured/i
    );
  });

  it('aborts generation when cancel is invoked', async () => {
    const stream = new ReadableStream({
      start() {
        // Keeps stream open
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const provider = new OpenRouterProvider(mockVault);
    const iteratePromise = drainStream(provider.streamChat(request));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await provider.cancel(request.requestId);
    await expect(iteratePromise).rejects.toThrow(/cancelled or timed out/i);
  });

  describe('optional provider-hosted web search', () => {
    /** Drains one streamChat and returns the JSON body that was posted. */
    async function bodyForRequest(chatRequest: ProviderChatRequest): Promise<PortableRecord> {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'
            )
          );
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );
      const provider = new OpenRouterProvider(mockVault);
      await drainStream(provider.streamChat(chatRequest));
      const body = fetchSpy.mock.calls[0]?.[1]?.body;
      if (typeof body !== 'string') throw new Error('the chat request must post a JSON string body');
      const parsed = parsePortableJson(body);
      if (!isPortableRecord(parsed)) throw new Error('the chat request body must be a JSON object');
      return parsed;
    }

    it('declares the capability so the rest of the app can offer the control', () => {
      expect(new OpenRouterProvider(mockVault).capabilities.hostedWebSearch).toBe(true);
    });

    it('asks OpenRouter to run its own search only for an opted-in turn', async () => {
      // https://openrouter.ai/docs/guides/features/server-tools/web-search —
      // the search runs on OpenRouter's servers; Interleaf dispatches no tool
      // call and gains no local capability from this. `max_total_results` is
      // the documented cumulative bound across every search one request runs,
      // and it is sent as the current (non-deprecated) server-tool shape rather
      // than the retired `plugins: [{ id: 'web' }]` form.
      const optedIn = await bodyForRequest({ ...request, webSearch: true });
      expect(optedIn.tools).toEqual([
        {
          type: 'openrouter:web_search',
          parameters: { max_total_results: CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS },
        },
      ]);
      expect(optedIn).not.toHaveProperty('plugins');
    });

    it('sends a main-only response cap as max_tokens, and the model limit otherwise', async () => {
      expect((await bodyForRequest({ ...request, maxResponseTokens: 64 })).max_tokens).toBe(64);
      vi.restoreAllMocks();
      expect((await bodyForRequest(request)).max_tokens).toBeGreaterThan(64);
    });

    it('sends no tools at all for an ordinary document-grounded turn', async () => {
      const ordinary = await bodyForRequest(request);
      // Not an empty array: a turn the user did not opt into carries no tool
      // surface whatsoever.
      expect(ordinary).not.toHaveProperty('tools');
    });
  });

  describe('provider-hosted web citations', () => {
    /** Streams the given SSE payloads and returns the provider's events. */
    async function streamOf(sse: string): Promise<readonly ProviderChatEvent[]> {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );
      const provider = new OpenRouterProvider(mockVault);
      return drainStream(provider.streamChat({ ...request, webSearch: true }));
    }

    /** The assistant text a turn actually produced, in order. */
    function answerText(events: readonly ProviderChatEvent[]): string {
      return events
        .filter((event): event is Extract<ProviderChatEvent, { type: 'token' }> => event.type === 'token')
        .map((event) => event.token)
        .join('');
    }

    /** The structured search metadata the turn reported alongside its answer. */
    function webSources(events: readonly ProviderChatEvent[]): readonly ChatWebSource[] {
      const done = events.find((event) => event.type === 'done');
      return done?.webSources ?? [];
    }

    /**
     * OpenRouter's standardized annotation shape for a hosted search result.
     * https://openrouter.ai/docs/guides/features/server-tools/web-search
     */
    function citationEvent(citations: readonly PortableRecord[], content = ''): string {
      const annotations = citations.map((url_citation) => ({ type: 'url_citation', url_citation }));
      return 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content, annotations } }] }) + '\n\n';
    }

    it('reports the provider’s own sources as metadata, never as answer text', async () => {
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Rates rose in 2025."}}]}\n\n' +
          citationEvent([
            {
              url: 'https://example.com/report',
              title: 'Annual Report',
              content: 'snippet',
              start_index: 0,
              end_index: 18,
            },
          ]) +
          'data: [DONE]\n\n'
      );

      // The answer is exactly what the model streamed. Nothing the provider
      // searched is appended to it, so the stored content stays model-authored.
      expect(answerText(events)).toBe('Rates rose in 2025.');
      expect(answerText(events)).not.toContain('example.com');
      expect(webSources(events)).toEqual([
        { url: 'https://example.com/report', title: 'Annual Report' },
      ]);
    });

    it('does not report the sources as generated tokens', async () => {
      const withCitation = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent([{ url: 'https://example.com/a', title: 'A' }]) +
          'data: [DONE]\n\n'
      );
      const withoutCitation = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'
      );

      const totals = (events: readonly ProviderChatEvent[]) =>
        events.find((event) => event.type === 'done')?.totalTokens;
      // The model did not generate the source list, so usage must not claim it.
      expect(totals(withCitation)).toBe(totals(withoutCitation));
      expect(answerText(withCitation)).toBe(answerText(withoutCitation));
      // A turn that searched nothing reports an empty list, not a missing one.
      expect(webSources(withoutCitation)).toEqual([]);
    });

    it('deduplicates sources and ignores annotations that are not usable web URLs', async () => {
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent([
            { url: 'https://example.com/a', title: 'First' },
            { url: 'https://example.com/a', title: 'Repeat of the same source' },
            { url: 'javascript:alert(1)', title: 'Not a web page' },
            { url: 'not a url at all', title: 'Malformed' },
            { title: 'No URL field' },
          ]) +
          'data: [DONE]\n\n'
      );

      expect(webSources(events)).toEqual([{ url: 'https://example.com/a', title: 'First' }]);
    });

    it('carries provider titles verbatim as data, applying no markup escaping', async () => {
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent([
            { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', title: '[Click](https://evil.test) **now**' },
          ]) +
          'data: [DONE]\n\n'
      );

      // Nothing is escaped or re-encoded, because nothing is being assembled
      // into Markdown: the title is a string field the renderer prints as text
      // and the URL keeps the bytes the provider actually reported.
      expect(webSources(events)).toEqual([
        { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', title: '[Click](https://evil.test) **now**' },
      ]);
      expect(answerText(events)).toBe('Answer');
    });

    it('reads citations that only arrive in the final flushed event', async () => {
      // No trailing blank line: the annotation is only recoverable at EOF.
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent([{ url: 'https://example.com/late', title: 'Late Source' }]).trimEnd()
      );
      expect(webSources(events)).toEqual([{ url: 'https://example.com/late', title: 'Late Source' }]);
    });

    it('falls back to the host when a source has no usable title', async () => {
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent([{ url: 'https://example.com/x', title: '   ' }]) +
          'data: [DONE]\n\n'
      );
      expect(webSources(events)).toEqual([{ url: 'https://example.com/x', title: 'example.com' }]);
    });

    it('stops collecting sources at the bound the request asked for', async () => {
      const many = Array.from({ length: CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS + 5 }, (_, index) => ({
        url: 'https://example.com/' + String(index),
        title: 'Source ' + String(index),
      }));
      const events = await streamOf(
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          citationEvent(many) +
          'data: [DONE]\n\n'
      );
      expect(webSources(events)).toHaveLength(CHAT_WEB_SEARCH_MAX_TOTAL_RESULTS);
    });
  });

  describe('model catalog fetching and caching', () => {
    it('fetches, parses, deduplicates, and deterministically sorts model catalog with openrouter/auto at top', async () => {
      const rawCatalog = {
        data: [
          { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
          { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash', context_length: 1048576, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
          { id: 'invalid-id-without-slash' },
          { id: 'meta-llama/llama-3.3-70b-instruct', name: '' }, // empty name falls back to id
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(rawCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const provider = new OpenRouterProvider(mockVault);
      const models = await provider.listCatalogModels();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Title': 'Interleaf',
          }),
        })
      );
      const requestHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(requestHeaders.Authorization).toBeUndefined();

      expect(models[0]).toEqual(DEFAULT_OPENROUTER_MODEL);
      expect(models.map((m) => m.id)).toEqual([
        'openrouter/auto',
        'anthropic/claude-3.5-sonnet',
        'google/gemini-2.0-flash-001',
        'meta-llama/llama-3.3-70b-instruct',
        'openai/gpt-4o',
      ]);

      const llama = models.find((m) => m.id === 'meta-llama/llama-3.3-70b-instruct');
      expect(llama?.name).toBe('meta-llama/llama-3.3-70b-instruct');
      expect(llama?.contextWindow).toBe(128000);

      const sonnet = models.find((m) => m.id === 'anthropic/claude-3.5-sonnet');
      expect(sonnet?.name).toBe('Anthropic: Claude 3.5 Sonnet');
      expect(sonnet?.contextWindow).toBe(200000);
      expect(sonnet?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: 0.000003 }, output: { kind: 'priced', usdPerToken: 0.000015 } });
    });

    it('preserves free, priced, sentinel-unavailable, and not-published pricing as distinct typed kinds', async () => {
      const rawCatalog = {
        data: [
          { id: 'free/exact-zero', name: 'Exact Zero', pricing: { prompt: '0', completion: 0 } },
          { id: 'vendor/sentinel', name: 'Sentinel', pricing: { prompt: '-1', completion: '-1' } },
          { id: 'vendor/negative-other', name: 'Negative Other', pricing: { prompt: '-2', completion: '-7' } },
          { id: 'vendor/partial-sentinel', name: 'Partial Sentinel', pricing: { prompt: '-1', completion: '0.000004' } },
          { id: 'vendor/one-direction-missing', name: 'One Direction Missing', pricing: { prompt: '0.0000025' } },
          { id: 'opaque/missing-fields', name: 'Missing Fields', pricing: {} },
          { id: 'opaque/non-numeric', name: 'Non Numeric', pricing: { prompt: 'abc', completion: '' } },
          { id: 'wide/priced-large', name: 'Large Decimal', pricing: { prompt: '2.5', completion: '1000' } },
          { id: 'sci/tiny-positive', name: 'Tiny Positive', pricing: { prompt: '1e-12', completion: '6.02E23' } },
          { id: 'sci/max-finite-double', name: 'Max Finite Double', pricing: { prompt: '1.7976931348623157e+308', completion: '9007199254740993' } },
          { id: 'sci/overflow-exponent', name: 'Overflow Exponent', pricing: { prompt: '1e999', completion: '-1e999' } },
          { id: 'malformed/hex-binary-octal', name: 'Hex Binary Octal', pricing: { prompt: '0x10', completion: '0b101' } },
          { id: 'malformed/octal-plus-dot', name: 'Octal Plus Dot', pricing: { prompt: '0777', completion: '+2.5' } },
          { id: 'malformed/infinity-nan', name: 'Infinity NaN', pricing: { prompt: 'Infinity', completion: 'NaN' } },
          { id: 'malformed/trailing-junk', name: 'Trailing Junk', pricing: { prompt: '2.5 usd', completion: '1.' } },
          { id: 'malformed/dot-and-broken-exp', name: 'Dot And Broken Exponent', pricing: { prompt: '.5', completion: '1e' } },
          { id: 'opaque/oversized-text', name: 'Oversized Text', pricing: { prompt: '1'.repeat(65), completion: '9'.repeat(65) } },
          { id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
          { id: 'cli/absent-pricing', name: 'Absent Pricing' },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(rawCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const provider = new OpenRouterProvider(mockVault);
      const models = await provider.listCatalogModels();
      const byId: Record<string, typeof models[number]> = Object.fromEntries(models.map((m) => [m.id, m]));

      // Real zero stays a numerically meaningful Free — never collapsed into
      // an error state and never rendered as an ordinary price tier.
      expect(byId['free/exact-zero']?.pricing).toEqual({ input: { kind: 'free' }, output: { kind: 'free' } });
      // The undocumented upstream -1 sentinel (and any negative marker) is a
      // price-availability gap, conservatively not claimed as published/free.
      expect(byId['vendor/sentinel']?.pricing).toEqual({ input: { kind: 'unavailable' }, output: { kind: 'unavailable' } });
      expect(byId['vendor/negative-other']?.pricing).toEqual({ input: { kind: 'unavailable' }, output: { kind: 'unavailable' } });
      // Directions classify independently inside one pricing object.
      expect(byId['vendor/partial-sentinel']?.pricing).toEqual({ input: { kind: 'unavailable' }, output: { kind: 'priced', usdPerToken: 0.000004 } });
      // A missing single direction is Not published while its sibling stays priced.
      expect(byId['vendor/one-direction-missing']?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: 0.0000025 }, output: { kind: 'not_published' } });
      // Absent fields / malformed / oversized text carry no usable figure.
      expect(byId['opaque/missing-fields']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      expect(byId['opaque/non-numeric']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      expect(byId['opaque/oversized-text']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      // Documented decimal prices carry no artificial ceiling: magnitudes far
      // beyond the old $1/token cap remain numeric priced values.
      expect(byId['wide/priced-large']?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: 2.5 }, output: { kind: 'priced', usdPerToken: 1000 } });
      // Scientific notation parses as priced in tiny and astronomic magnitudes.
      expect(byId['sci/tiny-positive']?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: 1e-12 }, output: { kind: 'priced', usdPerToken: 6.02e23 } });
      // Overflowing exponents convert to non-finite numbers: Not published,
      // even when written with a sign like a sentinel (finite guard wins).
      // Scientific notation parses as priced in tiny and astronomic magnitudes,
      // including the full IEEE-754 double range (no ceiling, exact round-trip).
      expect(byId['sci/max-finite-double']?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: Number.MAX_VALUE }, output: { kind: 'priced', usdPerToken: 9007199254740993 } });
      // Overflowing exponents convert to non-finite numbers: Not published,
      // even when written with a sign like a sentinel (finite guard wins).
      expect(byId['sci/overflow-exponent']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      // Only documented decimal/scientific syntax reaches Number conversion;
      // hex/binary/octal-like, Infinity/NaN lexemes cannot masquerade as numbers.
      expect(byId['malformed/hex-binary-octal']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      expect(byId['malformed/octal-plus-dot']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      expect(byId['malformed/infinity-nan']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      // Trailing junk, bare-dot fractions, and broken exponents are rejected.
      expect(byId['malformed/trailing-junk']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      expect(byId['malformed/dot-and-broken-exp']?.pricing).toEqual({ input: { kind: 'not_published' }, output: { kind: 'not_published' } });
      // Ordinary priced rows survive byte-for-byte as explicit priced values.
      expect(byId['openai/gpt-4o']?.pricing).toEqual({ input: { kind: 'priced', usdPerToken: 0.0000025 }, output: { kind: 'priced', usdPerToken: 0.00001 } });
      // Models whose source publishes no pricing object at all stay undefined
      // in transport; renderers treat the whole-object absence as Not published.
      expect(byId['cli/absent-pricing']?.pricing).toBeUndefined();
    });

    it('maps HTTP status to stable error messages without leaking response body secrets', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'Invalid key sk-or-v1-supersecret-token at /private/var/secrets/key.pem',
            },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const provider = new OpenRouterProvider(mockVault);
      const thrownError = await rejectionOf(provider.listCatalogModels());

      expect(thrownError).toBeInstanceOf(Error);
      const message = thrownError.message;
      expect(message).toContain(OPENROUTER_AUTH_FAILED_MESSAGE);
      expect(message).not.toContain('sk-or-v1-supersecret-token');
      expect(message).not.toContain('/private/var/secrets/key.pem');
    });

    it('maps 429 rate limit and 5xx service errors to stable messages', async () => {
      const provider = new OpenRouterProvider(mockVault);

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Too Many Requests', { status: 429 })
      );
      await expect(provider.listCatalogModels({ forceRefresh: true })).rejects.toThrow(
        'OpenRouter API rate limit reached. Please wait and retry.'
      );

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 503 })
      );
      await expect(provider.listCatalogModels({ forceRefresh: true })).rejects.toThrow(
        'OpenRouter service is temporarily unavailable. Please retry later.'
      );
    });

    it('handles malformed non-JSON payload safely', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('<html><body>Cloudflare Error</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const provider = new OpenRouterProvider(mockVault);
      await expect(provider.listCatalogModels()).rejects.toThrow(/not valid JSON/i);
    });

    it('handles oversized payload exceeding maximum byte limit', async () => {
      const hugeChunk = new Uint8Array(2 * 1024 * 1024);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(hugeChunk);
          controller.enqueue(hugeChunk);
          controller.enqueue(hugeChunk); // 6MB total > 5MB limit
          controller.close();
        },
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const provider = new OpenRouterProvider(mockVault);
      await expect(provider.listCatalogModels()).rejects.toThrow(/exceeded maximum size limit/i);
    });

    it('caches catalog responses within TTL and forces refresh when requested', async () => {
      const catalog1 = { data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] };
      const catalog2 = { data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }] };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(catalog1), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(catalog2), { status: 200 }));

      const provider = new OpenRouterProvider(mockVault);

      const res1 = await provider.listCatalogModels();
      expect(res1.some((m) => m.id === 'openai/gpt-4o')).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call within TTL returns cached result without second fetch
      const res2 = await provider.listCatalogModels();
      expect(res2).toBe(res1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // forceRefresh bypasses cache
      const res3 = await provider.listCatalogModels({ forceRefresh: true });
      expect(res3.some((m) => m.id === 'openai/gpt-4o-mini')).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    it('deduplicates concurrent in-flight catalog requests', async () => {
      let resolveFetch!: (res: Response) => void;
      const pendingResponse = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => pendingResponse);

      const provider = new OpenRouterProvider(mockVault);
      const p1 = provider.listCatalogModels();
      const p2 = provider.listCatalogModels();

      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] }), { status: 200 }));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(r2);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('joins active in-flight fetch when forceRefresh is called concurrently', async () => {
      let resolveFetch!: (res: Response) => void;
      const pendingResponse = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => pendingResponse);

      const provider = new OpenRouterProvider(mockVault);
      const pNormal = provider.listCatalogModels();
      const pForced = provider.listCatalogModels({ forceRefresh: true });

      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] }), { status: 200 }));

      const [rNormal, rForced] = await Promise.all([pNormal, pForced]);
      expect(rNormal).toBe(rForced);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('passes redirect: error to fetch so credentials cannot be forwarded across redirects', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] }), { status: 200 })
      );

      const provider = new OpenRouterProvider(mockVault);
      await provider.listCatalogModels();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          redirect: 'error',
        })
      );
    });

    it('rejects early when Content-Length header exceeds maximum allowed size', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Length': '10000000' }, // 10MB > 5MB limit
        })
      );

      const provider = new OpenRouterProvider(mockVault);
      await expect(provider.listCatalogModels()).rejects.toThrow(/exceeded maximum size limit/i);
    });

    it('returns all 5,000 remote models plus fallback when catalog is exactly at the 5,000 limit', async () => {
      const items = Array.from({ length: 5000 }, (_, i) => ({
        id: `provider/model-${String(i).padStart(4, '0')}`,
        name: `Model ${String(i)}`,
        context_length: 64000,
      }));

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: items }), { status: 200 })
      );

      const provider = new OpenRouterProvider(mockVault);
      const models = await provider.listCatalogModels();

      expect(models.length).toBe(5001); // 5000 remote + 1 fallback openrouter/auto
      expect(models[0]).toEqual(DEFAULT_OPENROUTER_MODEL);
    });

    it('fails with catalog-too-large error when catalog exceeds 5,000 entries rather than silently truncating', async () => {
      const items = Array.from({ length: 5001 }, (_, i) => ({
        id: `provider/model-${String(i).padStart(4, '0')}`,
        name: `Model ${String(i)}`,
      }));

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: items }), { status: 200 })
      );

      const provider = new OpenRouterProvider(mockVault);
      await expect(provider.listCatalogModels()).rejects.toThrow(
        'OpenRouter model catalog exceeded maximum entry limit.'
      );
    });

    it('truncates long names to 128 chars and clamps context window/tokens', async () => {
      const items = [
        { id: 'provider/model-a', name: 'X'.repeat(200), context_length: -100 },
        { id: 'provider/model-b', name: 'Normal', context_length: 999_999_999, top_provider: { max_completion_tokens: 50_000_000 } },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: items }), { status: 200 })
      );

      const provider = new OpenRouterProvider(mockVault);
      const models = await provider.listCatalogModels();

      const modelA = models.find((m) => m.id === 'provider/model-a');
      expect(modelA?.name.length).toBe(128);
      expect(modelA?.contextWindow).toBe(128_000); // clamped to default

      const modelB = models.find((m) => m.id === 'provider/model-b');
      expect(modelB?.contextWindow).toBe(128_000); // clamped to default
      expect(modelB?.maxOutputTokens).toBe(4_096); // clamped to default
    });

    it('sanitizes thrown network errors and does not leak private paths or tokens in message', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('Failed to connect to https://openrouter.ai?token=secret_key_123 at /var/root/secrets/key.pem')
      );

      const provider = new OpenRouterProvider(mockVault);
      await expect(provider.listCatalogModels()).rejects.toThrow(
        'OpenRouter model catalog is currently unavailable. Check network connection and retry.'
      );
    });
  });

  describe('atomic configure operation', () => {
    let currentSettings: AppSettings;
    let mockSettingsRepo: OpenRouterSettingsStore;

    beforeEach(() => {
      currentSettings = structuredClone(DEFAULT_APP_SETTINGS);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        data: [
          { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet' },
          { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash' },
          { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o' },
        ],
      }), { status: 200 }));
      mockSettingsRepo = {
        get: vi.fn(() => currentSettings),
        update: vi.fn((next: AppSettingsInput) => {
          currentSettings = structuredClone({ ...currentSettings, ...next } as AppSettings);
          return currentSettings;
        }),
      };
    });

    it('saves new key and new model atomically when unconfigured', async () => {
      storedKey = null;
      const provider = new OpenRouterProvider(mockVault);

      const result = await provider.configure(
        { apiKey: 'sk-or-v1-new-secret', model: 'anthropic/claude-3.5-sonnet' },
        mockSettingsRepo
      );

      expect(mockVault.setOpenRouterKey).toHaveBeenCalledWith('sk-or-v1-new-secret');
      expect(mockSettingsRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: expect.objectContaining({ openRouterModel: 'anthropic/claude-3.5-sonnet' }),
        })
      );
      expect(result.ai.openRouterModel).toBe('anthropic/claude-3.5-sonnet');
    });

    it('preserves existing key when already configured and apiKey is omitted/empty', async () => {
      storedKey = 'sk-or-v1-existing-secret';
      const provider = new OpenRouterProvider(mockVault);

      const result = await provider.configure(
        { model: 'google/gemini-2.0-flash-001' },
        mockSettingsRepo
      );

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(storedKey).toBe('sk-or-v1-existing-secret');
      expect(result.ai.openRouterModel).toBe('google/gemini-2.0-flash-001');
    });
    it('removes an existing key atomically with a model selection when requested', async () => {
      storedKey = 'sk-or-v1-existing-secret';
      const provider = new OpenRouterProvider(mockVault);

      const result = await provider.configure(
        { removeKey: true, model: 'openrouter/auto' },
        mockSettingsRepo
      );

      expect(mockVault.clearOpenRouterKey).toHaveBeenCalledTimes(1);
      expect(mockSettingsRepo.update).toHaveBeenCalledTimes(1);
      expect(storedKey).toBeNull();
      expect(result.ai.openRouterModel).toBe('openrouter/auto');
    });

    it('rejects a replacement key combined with staged removal before either store changes', async () => {
      const provider = new OpenRouterProvider(mockVault);

      await expect(
        provider.configure(
          { apiKey: 'sk-or-v1-replacement', removeKey: true, model: 'openrouter/auto' },
          mockSettingsRepo
        )
      ).rejects.toThrow(/cannot be combined/i);

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(mockVault.clearOpenRouterKey).not.toHaveBeenCalled();
      expect(mockSettingsRepo.update).not.toHaveBeenCalled();
    });
    it('throws validation error when unconfigured and no key is provided and leaves stores untouched', async () => {
      storedKey = null;
      const provider = new OpenRouterProvider(mockVault);

      await expect(
        provider.configure({ model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo)
      ).rejects.toThrow(/OpenRouter API key is required/i);

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(mockSettingsRepo.update).not.toHaveBeenCalled();
    });

    it('throws validation error when model ID is invalid and modifies neither vault nor settings', async () => {
      storedKey = null;
      const provider = new OpenRouterProvider(mockVault);

      await expect(
        provider.configure({ apiKey: 'sk-or-v1-test', model: 'invalid model id with spaces' }, mockSettingsRepo)
      ).rejects.toThrow('OpenRouter model identifier is invalid.');

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(mockSettingsRepo.update).not.toHaveBeenCalled();
    });

    it('throws validation error when API key exceeds 512 characters and modifies neither store', async () => {
      storedKey = null;
      const provider = new OpenRouterProvider(mockVault);

      await expect(
        provider.configure({ apiKey: 'x'.repeat(513), model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo)
      ).rejects.toThrow('OpenRouter API key is invalid.');

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(mockSettingsRepo.update).not.toHaveBeenCalled();
    });

    /**
     * The reported defect: after the profile migration a stored ciphertext can
     * no longer be decrypted under the current OS key. Replacing it must not
     * depend on reading it, so the old secret is never fetched at all.
     */
    it('replaces a stored key that can no longer be decrypted, without reading it', async () => {
      storedKey = 'sk-or-v1-existing';
      const undecryptable = vi
        .spyOn(mockVault, 'getOpenRouterKey')
        .mockRejectedValue(new Error('The stored OpenRouter credential could not be decrypted.'));

      const provider = new OpenRouterProvider(mockVault);

      const result = await provider.configure(
        { apiKey: 'sk-or-v1-replacement', model: 'anthropic/claude-3.5-sonnet' },
        mockSettingsRepo
      );

      expect(undecryptable).not.toHaveBeenCalled();
      expect(mockVault.setOpenRouterKey).toHaveBeenCalledWith('sk-or-v1-replacement');
      expect(storedKey).toBe('sk-or-v1-replacement');
      expect(result.ai.openRouterModel).toBe('anthropic/claude-3.5-sonnet');
    });

    it('removes a stored key that can no longer be decrypted, without reading it', async () => {
      storedKey = 'sk-or-v1-existing';
      const undecryptable = vi
        .spyOn(mockVault, 'getOpenRouterKey')
        .mockRejectedValue(new Error('The stored OpenRouter credential could not be decrypted.'));

      const provider = new OpenRouterProvider(mockVault);

      await provider.configure({ removeKey: true, model: 'openrouter/auto' }, mockSettingsRepo);

      expect(undecryptable).not.toHaveBeenCalled();
      expect(mockVault.clearOpenRouterKey).toHaveBeenCalledTimes(1);
      expect(storedKey).toBeNull();
    });

    it('restores the previous model and surfaces the vault error when the credential write fails', async () => {
      storedKey = 'sk-or-v1-original';
      currentSettings = appSettingsSchema.parse({
        ...currentSettings,
        ai: { openRouterModel: 'openai/gpt-4o' },
      });
      const provider = new OpenRouterProvider(mockVault);
      vi.spyOn(mockVault, 'setOpenRouterKey').mockRejectedValueOnce(new Error('Keychain unavailable'));

      await expect(
        provider.configure(
          { apiKey: 'sk-or-v1-replacement', model: 'anthropic/claude-3.5-sonnet' },
          mockSettingsRepo
        )
      ).rejects.toThrow('Keychain unavailable');

      // The compensable side is the non-secret model, and it is put back.
      expect(currentSettings.ai.openRouterModel).toBe('openai/gpt-4o');
      expect(storedKey).toBe('sk-or-v1-original');
    });

    it('reports truthfully when the credential write fails and the model cannot be restored', async () => {
      storedKey = 'sk-or-v1-original';
      const provider = new OpenRouterProvider(mockVault);
      vi.spyOn(mockVault, 'setOpenRouterKey').mockRejectedValueOnce(new Error('Keychain unavailable'));
      let updateCalls = 0;
      vi.spyOn(mockSettingsRepo, 'update').mockImplementation(() => {
        updateCalls += 1;
        if (updateCalls === 2) throw new Error('Database locked');
        return currentSettings;
      });

      await expect(
        provider.configure(
          { apiKey: 'sk-or-v1-replacement', model: 'anthropic/claude-3.5-sonnet' },
          mockSettingsRepo
        )
      ).rejects.toThrow(/credential was not changed, and the previous model setting could not be restored/i);
    });

    it('serializes concurrent configure operations to prevent interleaving', async () => {
      storedKey = 'sk-or-v1-initial';
      const provider = new OpenRouterProvider(mockVault);

      const order: string[] = [];
      vi.spyOn(mockSettingsRepo, 'update').mockImplementation((next: AppSettingsInput) => {
        order.push(next.ai?.openRouterModel ?? '');
        currentSettings = appSettingsSchema.parse({ ...currentSettings, ...next });
        return currentSettings;
      });

      const c1 = provider.configure({ model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo);
      const c2 = provider.configure({ model: 'openai/gpt-4o' }, mockSettingsRepo);

      await Promise.all([c1, c2]);

      expect(order).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4o']);
    });
    // Settings are written first, so a settings failure ends the operation
    // before the vault is touched: there is no credential state to compensate
    // and no reason to have read the old secret.
    it('leaves the stored key untouched when settings persistence fails on replacement', async () => {
      storedKey = 'sk-or-v1-initial-key';
      const provider = new OpenRouterProvider(mockVault);

      vi.spyOn(mockSettingsRepo, 'update').mockImplementationOnce(() => {
        throw new Error('Database write failure');
      });

      await expect(
        provider.configure({ apiKey: 'sk-or-v1-replacement-key', model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo)
      ).rejects.toThrow('Database write failure');

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(mockVault.getOpenRouterKey).not.toHaveBeenCalled();
      expect(storedKey).toBe('sk-or-v1-initial-key');
    });

    it('stores no key when settings persistence fails for a newly configured key', async () => {
      storedKey = null;
      const provider = new OpenRouterProvider(mockVault);

      vi.spyOn(mockSettingsRepo, 'update').mockImplementationOnce(() => {
        throw new Error('Disk full');
      });

      await expect(
        provider.configure({ apiKey: 'sk-or-v1-first-key', model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo)
      ).rejects.toThrow('Disk full');

      expect(mockVault.setOpenRouterKey).not.toHaveBeenCalled();
      expect(storedKey).toBeNull();
    });

    it('keeps the stored key when settings persistence fails during removal', async () => {
      storedKey = 'sk-or-v1-initial-key';
      const provider = new OpenRouterProvider(mockVault);
      vi.spyOn(mockSettingsRepo, 'update').mockImplementationOnce(() => {
        throw new Error('Database write failure');
      });

      await expect(
        provider.configure({ removeKey: true, model: 'openrouter/auto' }, mockSettingsRepo)
      ).rejects.toThrow('Database write failure');

      expect(mockVault.clearOpenRouterKey).not.toHaveBeenCalled();
      expect(storedKey).toBe('sk-or-v1-initial-key');
    });

    it('never puts the raw key into persisted settings, results, or failures', async () => {
      const secret = `sk-or-v1-${'9'.repeat(48)}`;
      const provider = new OpenRouterProvider(mockVault);

      const saved = await provider.configure({ apiKey: secret, model: 'anthropic/claude-3.5-sonnet' }, mockSettingsRepo);
      // Only the vault receives the secret; nothing that is persisted as
      // settings or handed back to the caller may carry it.
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(JSON.stringify(currentSettings)).not.toContain(secret);
      const persisted = vi.mocked(mockSettingsRepo.update).mock.calls.map(([next]) => JSON.stringify(next));
      for (const call of persisted) expect(call).not.toContain(secret);

      // A vault failure must not echo the secret back through the error path.
      vi.spyOn(mockVault, 'setOpenRouterKey').mockRejectedValueOnce(new Error('Keychain unavailable'));
      const failure = await rejectionOf(
        provider.configure({ apiKey: secret, model: 'openai/gpt-4o' }, mockSettingsRepo)
      );
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(secret);
    });

    /**
     * Immediate removal and configure both rewrite the one vault document, so
     * they share the provider's lock. Without it the second operation reads the
     * document the first has not finished writing: one write is lost, and each
     * caller reports a store state that never existed.
     */
    describe('immediate removal serialized against configure', () => {
      /** Lets every already-queued microtask and timer callback run. */
      const settle = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      };

      it('holds a removal until an in-flight replacement has finished writing', async () => {
        storedKey = 'sk-or-v1-existing';
        const provider = new OpenRouterProvider(mockVault);
        const order: string[] = [];
        let releaseReplacement!: () => void;
        const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
        vi.spyOn(mockVault, 'setOpenRouterKey').mockImplementation(async (key: string) => {
          await replacementGate;
          order.push('replace');
          storedKey = key;
        });
        vi.spyOn(mockVault, 'clearOpenRouterKey').mockImplementation(() => {
          order.push('remove');
          storedKey = null;
          return Promise.resolve();
        });

        const replacement = provider.configure(
          { apiKey: 'sk-or-v1-replacement', model: 'openrouter/auto' },
          mockSettingsRepo
        );
        const removal = provider.clearCredential();
        await settle();

        // Unserialized, the removal would already have deleted the record the
        // replacement is in the middle of writing, and would then have found
        // that key back in the store when it re-checked.
        expect(order).toEqual([]);

        releaseReplacement();
        await expect(replacement).resolves.toBeDefined();
        await expect(removal).resolves.toEqual(UNCONFIGURED_CREDENTIAL_STATUS);

        expect(order).toEqual(['replace', 'remove']);
        expect(storedKey).toBeNull();
      });

      it('holds a replacement until an in-flight removal has finished', async () => {
        storedKey = 'sk-or-v1-existing';
        const provider = new OpenRouterProvider(mockVault);
        const order: string[] = [];
        let releaseRemoval!: () => void;
        const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
        vi.spyOn(mockVault, 'clearOpenRouterKey').mockImplementation(async () => {
          await removalGate;
          order.push('remove');
          storedKey = null;
        });
        vi.spyOn(mockVault, 'setOpenRouterKey').mockImplementation((key: string) => {
          order.push('replace');
          storedKey = key;
          return Promise.resolve();
        });

        const removal = provider.clearCredential();
        const replacement = provider.configure(
          { apiKey: 'sk-or-v1-replacement', model: 'openrouter/auto' },
          mockSettingsRepo
        );
        await settle();

        expect(order).toEqual([]);

        releaseRemoval();
        // The removal reports the store as it left it; the replacement the
        // reader asked for afterwards is what stands at the end.
        await expect(removal).resolves.toEqual(UNCONFIGURED_CREDENTIAL_STATUS);
        await expect(replacement).resolves.toBeDefined();

        expect(order).toEqual(['remove', 'replace']);
        expect(storedKey).toBe('sk-or-v1-replacement');
      });

      it('answers with the masked unconfigured status and never reads the secret', async () => {
        storedKey = 'sk-or-v1-existing';
        const provider = new OpenRouterProvider(mockVault);

        await expect(provider.clearCredential()).resolves.toEqual(UNCONFIGURED_CREDENTIAL_STATUS);

        expect(mockVault.clearOpenRouterKey).toHaveBeenCalledTimes(1);
        expect(mockVault.getOpenRouterKey).not.toHaveBeenCalled();
        expect(mockSettingsRepo.update).not.toHaveBeenCalled();
      });

      it('reports a deletion that did not take effect as a failure', async () => {
        storedKey = 'sk-or-v1-existing';
        const provider = new OpenRouterProvider(mockVault);
        vi.spyOn(mockVault, 'clearOpenRouterKey').mockResolvedValue(undefined);

        await expect(provider.clearCredential()).rejects.toMatchObject({ code: 'internal' });

        // A failed removal must not leave the lock held for the next writer.
        await expect(
          provider.configure({ apiKey: 'sk-or-v1-replacement', model: 'openrouter/auto' }, mockSettingsRepo)
        ).resolves.toBeDefined();
      });
    });
  });
});
