/**
 * The `local` Reader Chat provider.
 *
 * Every server here is a fixture listening on 127.0.0.1 for the duration of one
 * test. Nothing in this file reaches a paid provider, and no test runs real
 * inference: the fixtures replay bytes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPortableRecord, parsePortableJson, type PortableRecord, type PortableValue } from '@shared/models/portable';
import {
  LocalProvider,
  OpenAiDeltaStreamParser,
  parseOllamaContextWindow,
  parseOpenAiModelIds,
} from '@main/ai/providers/local-provider';
import { LOOPBACK_MAX_LINE_LENGTH, loopbackRequest, loopbackStreamLines } from '@main/ai/providers/loopback-transport';
import { DEFAULT_LOCAL_ENDPOINT, parseLoopbackEndpoint } from '@shared/schemas/local-endpoint';
import type { LocalProviderSettings } from '@shared/schemas/settings';
import type { ProviderChatRequest } from '@main/ai/providers/types';
import { AIProviderRegistry } from '@main/ai/provider-registry';
import { testAIProviderRegistryInput } from '../helpers/ai-provider-registry';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

type Fixture = {
  readonly endpoint: string;
  /** Every request the fixture received, in order. */
  readonly requests: { method: string; url: string; body: string }[];
};

const servers: Server[] = [];

async function drainLines(lines: AsyncIterable<string>): Promise<readonly string[]> {
  const drained: string[] = [];
  for await (const line of lines) drained.push(line);
  return drained;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => { resolve(); });
  })));
});

/** Start a loopback fixture server and return its literal-IP endpoint. */
async function startFixture(handler: Handler): Promise<Fixture> {
  const requests: { method: string; url: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', body });
      handler(request, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${String(port)}`, requests };
}

function endpointOf(url: string) {
  const parsed = parseLoopbackEndpoint(url);
  if (!parsed.ok) throw new Error(`fixture endpoint rejected: ${parsed.reason}`);
  return parsed.endpoint;
}

function settings(endpoint: string, overrides: Partial<LocalProviderSettings> = {}): LocalProviderSettings {
  return { mode: 'openai-compatible', endpoint, model: null, ...overrides };
}

function sse(...events: readonly PortableValue[]): string {
  return events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

function contentEvent(content: string, extra: PortableRecord = {}): PortableRecord {
  return { choices: [{ index: 0, delta: { content, ...extra } }] };
}

const CHAT_REQUEST: ProviderChatRequest = {
  requestId: 'local-turn',
  modelId: null,
  systemPrompt: 'Use only the supplied reference data.',
  contextXml: '<document/>',
  history: [],
  userMessage: 'Summarise section two.',
  sources: [],
  webSearch: false,
};

async function collect(provider: LocalProvider, request: ProviderChatRequest = CHAT_REQUEST): Promise<string> {
  let text = '';
  for await (const event of provider.streamChat(request)) {
    if (event.type === 'token') text += event.token;
  }
  return text;
}

/** A fixture that lists models and then streams a fixed SSE body. */
function chatFixture(stream: string, models = ['qwen3:8b']): Promise<Fixture> {
  return startFixture((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(stream);
      return;
    }
    response.writeHead(404).end();
  });
}

describe('Loopback endpoint policy', () => {
  it('accepts only literal loopback authorities', () => {
    for (const value of [
      DEFAULT_LOCAL_ENDPOINT,
      'http://127.0.0.1:8080',
      'http://[::1]:11434',
      'http://[0:0:0:0:0:0:0:1]:11434',
      'http://127.0.0.1:11434/',
      // `URL` canonicalizes integer and hex spellings of an IPv4 address, so
      // these arrive as the literal 127.0.0.1 rather than as a second syntax
      // that would have to be recognised separately.
      'http://2130706433:11434',
      'http://0x7f000001:11434',
    ]) {
      expect(parseLoopbackEndpoint(value).ok, value).toBe(true);
    }
  });

  it('refuses names, other addresses, and anything beyond a bare origin', () => {
    const rejections: readonly (readonly [string, string])[] = [
      ['', 'empty'],
      ['   ', 'empty'],
      [`http://127.0.0.1:11434/${'a'.repeat(200)}`, 'too-long'],
      ['127.0.0.1:11434', 'malformed'],
      ['http://127.0.0.1:11434\r\nX-Injected: 1', 'malformed'],
      ['https://127.0.0.1:11434', 'scheme'],
      ['file:///etc/passwd', 'scheme'],
      ['http://user:pass@127.0.0.1:11434', 'credentials'],
      // A name, even one that usually resolves to loopback: it is resolved, and
      // a resolver is exactly the step this policy removes.
      ['http://localhost:11434', 'host'],
      ['http://0.0.0.0:11434', 'host'],
      ['http://127.0.0.2:11434', 'host'],
      ['http://192.168.1.10:11434', 'host'],
      ['http://10.0.0.1:11434', 'host'],
      ['http://example.com:11434', 'host'],
      ['http://3232235786:11434', 'host'],
      ['http://127.0.0.1:0', 'port'],
      ['http://127.0.0.1:99999', 'malformed'],
      ['http://127.0.0.1:11434/v1', 'path'],
      ['http://127.0.0.1:11434/?to=evil.example', 'path'],
      ['http://127.0.0.1:11434/#frag', 'path'],
    ];
    for (const [value, reason] of rejections) {
      const result = parseLoopbackEndpoint(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toBe(reason);
    }
  });

  it('canonicalizes to an origin plus a bare address the socket can use', () => {
    const v6 = parseLoopbackEndpoint('http://[0:0:0:0:0:0:0:1]:11434');
    expect(v6.ok && v6.endpoint).toEqual({ origin: 'http://[::1]:11434', host: '::1', port: 11_434, family: 6 });
    const v4 = parseLoopbackEndpoint('http://127.0.0.1:11434/');
    expect(v4.ok && v4.endpoint).toEqual({ origin: 'http://127.0.0.1:11434', host: '127.0.0.1', port: 11_434, family: 4 });
    const integer = parseLoopbackEndpoint('http://2130706433:11434');
    expect(integer.ok && integer.endpoint.host).toBe('127.0.0.1');
  });
});

describe('Loopback transport', () => {
  it('requests only the fixed path it was given', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
    });
    const response = await loopbackRequest({ endpoint: endpointOf(fixture.endpoint), path: '/v1/models', method: 'GET' });
    expect(response.status).toBe(200);
    expect(fixture.requests).toEqual([{ method: 'GET', url: '/v1/models', body: '' }]);
  });

  it('does not follow a redirect a local server offers', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(302, { Location: 'http://198.51.100.7/v1/models' }).end();
    });
    const response = await loopbackRequest({ endpoint: endpointOf(fixture.endpoint), path: '/v1/models', method: 'GET' });
    // The redirect is returned as data, never chased: exactly one request was
    // made, and it went to the loopback fixture.
    expect(response.status).toBe(302);
    expect(fixture.requests).toHaveLength(1);
  });

  it('ignores proxy environment variables', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"m"}]}');
    });
    // A proxy on a port nothing is listening on: if the transport honoured it,
    // the request would fail rather than reach the fixture.
    const previous = { http: process.env.HTTP_PROXY, all: process.env.ALL_PROXY, no: process.env.NO_PROXY };
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.ALL_PROXY = 'http://127.0.0.1:9';
    delete process.env.NO_PROXY;
    try {
      const response = await loopbackRequest({ endpoint: endpointOf(fixture.endpoint), path: '/v1/models', method: 'GET' });
      expect(response.status).toBe(200);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      if (previous.http === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous.http;
      if (previous.all === undefined) delete process.env.ALL_PROXY; else process.env.ALL_PROXY = previous.all;
      if (previous.no !== undefined) process.env.NO_PROXY = previous.no;
    }
  });

  it('abandons a response larger than the cap instead of buffering it', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('x'.repeat(64 * 1024));
    });
    await expect(loopbackRequest({
      endpoint: endpointOf(fixture.endpoint),
      path: '/v1/models',
      method: 'GET',
      maxBytes: 1_024,
    })).rejects.toThrow(/more data than Interleaf accepts/u);
  });

  it('raises a non-2xx stream before yielding a single line', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/event-stream' }).end(sse(contentEvent('leaked')));
    });
    const lines: string[] = [];
    await expect((async () => {
      for await (const line of loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
      })) lines.push(line);
    })()).rejects.toThrow(/status 500/u);
    expect(lines).toEqual([]);
  });

  it('stops a stream that exceeds the line budget', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('noise\n'.repeat(50));
    });
    await expect((async () => {
      await drainLines(loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        maxLines: 10,
      }));
    })()).rejects.toThrow(/more data than Interleaf accepts/u);
  });

  it('reports a refused connection as a server that is not running', async () => {
    // Port 9 (discard) is reserved and closed on a normal macOS host.
    await expect(loopbackRequest({
      endpoint: endpointOf('http://127.0.0.1:9'),
      path: '/v1/models',
      method: 'GET',
    })).rejects.toThrow(/No local server is listening|could not reach/u);
  });
});

describe('Local model catalog is untrusted input', () => {
  it('keeps only well-formed identifiers, deduped and bounded', () => {
    const ids = parseOpenAiModelIds(JSON.stringify({
      data: [
        { id: 'qwen3:8b' },
        { id: 'qwen3:8b' },
        { id: '  llama3.2  ' },
        { id: '' },
        { id: 'a'.repeat(200) },
        // Spelled as an escape rather than embedded literally: the byte would
        // make this source file binary to tooling, while the string built at
        // runtime is the same control character a server could really send.
        { id: ['bad', 'id'].join('\u0000') },
        { id: 42 },
        'not-an-object',
        null,
        ['nested'],
        {},
      ],
    }));
    expect(ids).toEqual(['qwen3:8b', 'llama3.2']);
  });

  it('caps the catalog however many models a server publishes', () => {
    const data = Array.from({ length: 500 }, (_value, index) => ({ id: `model-${String(index)}` }));
    expect(parseOpenAiModelIds(JSON.stringify({ data })).length).toBe(64);
  });

  it('returns nothing for a malformed or non-catalog payload', () => {
    expect(parseOpenAiModelIds('not json')).toEqual([]);
    expect(parseOpenAiModelIds('null')).toEqual([]);
    expect(parseOpenAiModelIds('{"data":{}}')).toEqual([]);
    expect(parseOpenAiModelIds('[]')).toEqual([]);
  });

  it('reads a real context window from Ollama metadata and falls back conservatively', () => {
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: { 'qwen3.context_length': 40_960 } }))).toBe(40_960);
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: { 'llama.context_length': 8_192 } }))).toBe(8_192);
    // Absurd, absent, and hostile values all land on the conservative default.
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: { 'x.context_length': -1 } }))).toBe(8_192);
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: { 'x.context_length': '99999' } }))).toBe(8_192);
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: {} }))).toBe(8_192);
    expect(parseOllamaContextWindow('not json')).toBe(8_192);
    expect(parseOllamaContextWindow(JSON.stringify({ model_info: { 'x.context_length': 9e15 } }))).toBe(1_000_000);
  });
});

describe('OpenAI-compatible delta stream', () => {
  it('emits assistant content and nothing else the server sends', () => {
    const parser = new OpenAiDeltaStreamParser();
    expect(parser.parseLine('')).toEqual([]);
    expect(parser.parseLine(': keep-alive comment')).toEqual([]);
    expect(parser.parseLine(`data: ${JSON.stringify(contentEvent('Section two '))}`)).toEqual(['Section two ']);
    expect(parser.parseLine(`data: ${JSON.stringify(contentEvent('argues X.'))}`)).toEqual(['argues X.']);
    expect(parser.parseLine('data: [DONE]')).toEqual([]);
    expect(parser.done).toBe(true);
    parser.assertComplete();
  });

  it('never surfaces reasoning fields as assistant text', () => {
    const parser = new OpenAiDeltaStreamParser();
    // qwen3 and similar local models emit these by default.
    expect(parser.parseLine(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'first I will…' } }] })}`)).toEqual([]);
    expect(parser.parseLine(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] })}`)).toEqual([]);
    expect(parser.parseLine(`data: ${JSON.stringify({ choices: [{ delta: { thinking: 'hidden' } }] })}`)).toEqual([]);
    // Content alongside reasoning yields only the content.
    expect(parser.parseLine(`data: ${JSON.stringify(contentEvent('Visible.', { reasoning: 'hidden' }))}`)).toEqual(['Visible.']);
  });

  it('treats a tool or function call as a violated invariant', () => {
    for (const event of [
      { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'bash' } }] } }] },
      { choices: [{ delta: { function_call: { name: 'bash' } } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [{ delta: {}, finish_reason: 'function_call' }] },
    ]) {
      const parser = new OpenAiDeltaStreamParser();
      expect(() => parser.parseLine(`data: ${JSON.stringify(event)}`)).toThrow(/unsupported tool operation/u);
    }
  });

  it('fails closed on a malformed event or a reported error', () => {
    expect(() => new OpenAiDeltaStreamParser().parseLine('data: {oops')).toThrow(/malformed/u);
    expect(() => new OpenAiDeltaStreamParser().parseLine('data: {"error":{"message":"boom"}}'))
      .toThrow(/reported an error/u);
  });

  it('refuses to call an unterminated stream complete', () => {
    const parser = new OpenAiDeltaStreamParser();
    parser.parseLine(`data: ${JSON.stringify(contentEvent('Half an ans'))}`);
    expect(() => { parser.assertComplete(); }).toThrow(/before it was complete/u);
  });

  it('accepts a natural finish_reason as the terminal signal', () => {
    const parser = new OpenAiDeltaStreamParser();
    parser.parseLine(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}`);
    expect(parser.done).toBe(true);
    parser.assertComplete();
  });
});

describe('Local provider status and catalog', () => {
  it('lists models over the OpenAI-compatible surface without running inference', async () => {
    const fixture = await chatFixture('', ['qwen3:8b', 'llama3.2']);
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    const status = await provider.detect();

    expect(status.available).toBe(true);
    expect(status.authentication).toBe('connected');
    expect(status.models.map((model) => model.id)).toEqual(['qwen3:8b', 'llama3.2']);
    expect(status.capabilities.toolFreeMode).toBe(true);
    expect(status.capabilities.hostedWebSearch).toBe(false);
    expect(fixture.requests.map((request) => request.url)).toEqual(['/v1/models']);
  });

  it('reads native metadata for a real context window in ollama mode', async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
        return;
      }
      if (request.url === '/api/show') {
        response.writeHead(200).end(JSON.stringify({ model_info: { 'qwen3.context_length': 40_960 } }));
        return;
      }
      response.writeHead(404).end();
    });
    const provider = new LocalProvider(() => settings(fixture.endpoint, { mode: 'ollama' }));
    const models = await provider.listModels();

    expect(models[0]?.contextWindow).toBe(40_960);
    // `/api/show` is read-only metadata; no generate or pull request is made.
    expect(fixture.requests.map((request) => request.url)).toEqual(['/v1/models', '/api/show']);
  });

  it('reports an unreachable server as disconnected with safe wording', async () => {
    const provider = new LocalProvider(() => settings('http://127.0.0.1:9'));
    const status = await provider.detect();
    expect(status.available).toBe(false);
    expect(status.authentication).toBe('disconnected');
    expect(status.errorMessage).toMatch(/No local server is listening|could not reach/u);
  });

  it('explains a rejected endpoint without opening a socket', async () => {
    const provider = new LocalProvider(() => settings('http://localhost:11434'));
    const status = await provider.detect();
    expect(status.installed).toBe(false);
    expect(status.errorMessage).toMatch(/Only 127\.0\.0\.1 and \[::1\]/u);
  });

  it('tests a connection by listing models only', async () => {
    const fixture = await chatFixture('', ['qwen3:8b']);
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    const result = await provider.testConnection();

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/1 model available/u);
    expect(fixture.requests.every((request) => request.url === '/v1/models')).toBe(true);
  });

  it('reports a running server with an empty catalog as unusable', async () => {
    const fixture = await chatFixture('', []);
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    expect((await provider.testConnection()).success).toBe(false);
    expect((await provider.detect()).errorMessage).toMatch(/no models available/u);
  });
});

describe('Local provider streaming turn', () => {
  it('streams assistant text reassembled across chunk boundaries', async () => {
    const body = sse(contentEvent('Section two '), contentEvent('argues X.'), '[DONE]');
    const fixture = await startFixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Split mid-event so the framing, not the fixture, does the reassembly.
      response.write(body.slice(0, 30));
      setTimeout(() => { response.end(body.slice(30)); }, 10);
    });
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    await expect(collect(provider)).resolves.toBe('Section two argues X.');
  });

  it('sends no tool, function or search field, and puts the document in the body only', async () => {
    const fixture = await chatFixture(sse(contentEvent('ok'), '[DONE]'));
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    await collect(provider);

    const chat = fixture.requests.find((request) => request.url === '/v1/chat/completions');
    expect(chat?.method).toBe('POST');
    const payload = parsePortableJson(chat?.body ?? '{}');
    if (!isPortableRecord(payload)) throw new Error('The chat request body must be a JSON object.');
    expect(payload.tools).toBeUndefined();
    expect(payload.functions).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
    expect(payload.stream).toBe(true);
    expect(JSON.stringify(payload.messages)).toContain('<document/>');
    expect(JSON.stringify(payload.messages)).toContain('Summarise section two.');
  });

  it('never yields reasoning a local model emits alongside its answer', async () => {
    const fixture = await chatFixture(sse(
      { choices: [{ delta: { reasoning: 'The user wants…' } }] },
      contentEvent('Answer.', { reasoning_content: 'still thinking' }),
      '[DONE]',
    ));
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    await expect(collect(provider)).resolves.toBe('Answer.');
  });

  it('aborts the turn when the server volunteers a tool call', async () => {
    const fixture = await chatFixture(sse(
      contentEvent('Reading '),
      { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'bash' } }] } }] },
      '[DONE]',
    ));
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    await expect(collect(provider)).rejects.toThrow(/unsupported tool operation/u);
  });

  it('fails a stream that stops before it is complete', async () => {
    const fixture = await chatFixture(sse(contentEvent('Half an ans')));
    const provider = new LocalProvider(() => settings(fixture.endpoint));
    await expect(collect(provider)).rejects.toThrow(/before it was complete/u);
  });

  it('surfaces a cancelled turn as a safe error', async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(contentEvent('Working')));
      // Never finishes; only cancellation ends this turn.
    });
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    const turn = collect(provider);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await provider.cancel(CHAT_REQUEST.requestId);
    await expect(turn).rejects.toThrow(/cancelled|could not reach/u);
  });

  it('rejects a forged web-search request before opening a socket', async () => {
    const fixture = await chatFixture(sse(contentEvent('ok'), '[DONE]'));
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    await expect(collect(provider, { ...CHAT_REQUEST, webSearch: true }))
      .rejects.toThrow(/does not support web search/u);
    expect(fixture.requests).toEqual([]);
  });

  it('refuses a model the server no longer publishes rather than substituting one', async () => {
    const fixture = await chatFixture(sse(contentEvent('ok'), '[DONE]'), ['qwen3:8b']);
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    await expect(collect(provider, { ...CHAT_REQUEST, modelId: 'deleted-model' }))
      .rejects.toThrow(/no longer available/u);
    expect(fixture.requests.some((request) => request.url === '/v1/chat/completions')).toBe(false);
  });

  it('refuses to chat through an endpoint the policy rejects', async () => {
    const provider = new LocalProvider(() => settings('http://192.168.1.10:11434'));
    await expect(collect(provider)).rejects.toThrow(/Only 127\.0\.0\.1 and \[::1\]/u);
  });
});

describe('Local provider registration', () => {
  it('is a Reader Chat provider that reads settings fresh on every use', async () => {
    const fixture = await chatFixture('', ['qwen3:8b']);
    let current = settings('http://127.0.0.1:9');
    const registry = new AIProviderRegistry(testAIProviderRegistryInput({ readLocalSettings: () => current }));
    const provider = registry.require('local');
    expect(provider.id).toBe('local');
    expect((await provider.detect()).installed).toBe(false);

    // Changing the endpoint in Settings takes effect on the next probe rather
    // than at the next restart.
    current = settings(fixture.endpoint);
    expect((await provider.detect()).installed).toBe(true);
  });

  it('registers declaring tool-free chat and no hosted search', () => {
    // No probe here: the default endpoint is the real Ollama default, and a
    // test must not depend on what happens to be running on the machine.
    const registry = new AIProviderRegistry(testAIProviderRegistryInput());
    const provider = registry.require('local');
    expect(provider.capabilities.toolFreeMode).toBe(true);
    expect(provider.capabilities.hostedWebSearch).toBe(false);
    expect(provider.capabilities.apiKeyAuth).toBe(false);
  });
});

/**
 * Bounds that have to hold *after* the response headers.
 *
 * Everything below is the class of failure a fixture with a well-behaved
 * `end()` cannot show: a server that answers `200 OK` and then misbehaves. Each
 * fixture here deliberately never finishes its body.
 */
describe('Loopback transport bounds after the headers arrive', () => {
  /** Answers with headers and a little body, then holds the socket open. */
  async function stallingFixture(prelude = 'data: {}\n\n'): Promise<Fixture> {
    return startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(prelude);
      // No `end()`, ever. The transport's deadlines are the only way out.
    });
  }

  it('gives up on a body that stops after the headers', async () => {
    const fixture = await stallingFixture();
    const started = Date.now();
    await expect((async () => {
      await drainLines(loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        timeoutMs: 250,
      }));
    })()).rejects.toThrow(/did not finish responding in time/u);
    // The point is that it returns at all; the margin keeps it non-flaky.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up on a whole-body read that stops after the headers', async () => {
    const fixture = await stallingFixture('{"data":');
    await expect(loopbackRequest({
      endpoint: endpointOf(fixture.endpoint),
      path: '/v1/models',
      method: 'GET',
      timeoutMs: 250,
    })).rejects.toThrow(/did not finish responding in time/u);
  });

  it('enforces the idle deadline once the server has gone quiet', async () => {
    const fixture = await stallingFixture();
    // Injected rather than waited out: the real idle deadline is a minute, and
    // a test that proves it by sleeping is a test nobody runs.
    await expect((async () => {
      await drainLines(loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        idleTimeoutMs: 200,
        timeoutMs: 30_000,
      }));
    })()).rejects.toThrow(/stopped responding/u);
  });

  it('stops a newline-free body at the total byte cap', async () => {
    // One long line and no terminator: a line-oriented reader would see
    // nothing to measure until the server chose to send a newline.
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (): void => {
        if (response.writableEnded) return;
        response.write('x'.repeat(8 * 1024), () => { setImmediate(write); });
      };
      write();
    });
    await expect((async () => {
      await drainLines(loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        maxBytes: 64 * 1024,
        timeoutMs: 10_000,
      }));
    })()).rejects.toThrow(/more data than Interleaf accepts/u);
  });

  it('stops a single line that grows past the per-line cap', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (): void => {
        if (response.writableEnded) return;
        response.write('y'.repeat(64 * 1024), () => { setImmediate(write); });
      };
      write();
    });
    await expect((async () => {
      await drainLines(loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        // Generous total, so the per-line bound is what has to fire.
        maxBytes: 64 * 1024 * 1024,
        timeoutMs: 10_000,
      }));
    })()).rejects.toThrow(/malformed response/u);
  });

  it('cancels a live stream promptly instead of waiting for the deadline', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (): void => {
        if (response.writableEnded) return;
        response.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n', () => { setTimeout(write, 5); });
      };
      write();
    });
    const controller = new AbortController();
    const started = Date.now();
    await expect((async () => {
      const seen: string[] = [];
      for await (const line of loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        signal: controller.signal,
        timeoutMs: 30_000,
      })) {
        seen.push(line);
        if (seen.length === 2) controller.abort();
      }
    })()).rejects.toThrow(/cancelled/u);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a request whose signal was already aborted', async () => {
    const fixture = await chatFixture(sse(contentEvent('hi'), '[DONE]'));
    const controller = new AbortController();
    controller.abort();
    await expect(loopbackRequest({
      endpoint: endpointOf(fixture.endpoint),
      path: '/v1/models',
      method: 'GET',
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/u);
  });

  it('reassembles a character split across two chunks rather than mangling it', async () => {
    // A single emoji cut through the middle of its UTF-8 sequence, which
    // per-chunk decoding would turn into two replacement characters.
    const payload = Buffer.from('data: {"choices":[{"delta":{"content":"🌍"}}]}\n\n', 'utf8');
    const cut = payload.indexOf(0xf0) + 2;
    const fixture = await startFixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(payload.subarray(0, cut));
      setTimeout(() => {
        // Concatenated as bytes: joining as strings here would decode the half
        // sequence in the fixture and hide what the transport does with it.
        response.end(Buffer.concat([payload.subarray(cut), Buffer.from('data: [DONE]\n\n', 'utf8')]));
      }, 10);
    });
    const lines: string[] = [];
    for await (const line of loopbackStreamLines({
      endpoint: endpointOf(fixture.endpoint),
      path: '/v1/chat/completions',
      method: 'POST',
      body: '{}',
    })) {
      lines.push(line);
    }
    expect(lines.join('')).toContain('🌍');
    expect(lines.join('')).not.toContain('�');
  });
});

describe('The saved local model is the one a new chat uses', () => {
  /** Lists `models` and streams a reply naming whichever model was requested. */
  function echoFixture(models: readonly string[]): Promise<Fixture> {
    return startFixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse(contentEvent('ok'), '[DONE]'));
    });
  }

  it('offers the saved model first, so every "first model" default lands on it', async () => {
    const fixture = await echoFixture(['llama3.2', 'qwen3:8b', 'phi4']);
    const provider = new LocalProvider(() => settings(fixture.endpoint, { model: 'qwen3:8b' }));

    const status = await provider.detect();
    // This ordering is the contract the chat store and the registry both rely
    // on when they take `models[0]` for a session created without a model.
    expect(status.models.map((model) => model.id)).toEqual(['qwen3:8b', 'llama3.2', 'phi4']);
    expect((await provider.listModels())[0]?.id).toBe('qwen3:8b');
    expect(status.errorMessage).toBeNull();
  });

  it('sends the saved model to the server when the turn names none', async () => {
    const fixture = await echoFixture(['llama3.2', 'qwen3:8b']);
    const provider = new LocalProvider(() => settings(fixture.endpoint, { model: 'qwen3:8b' }));

    await collect(provider, { ...CHAT_REQUEST, modelId: null });

    const chat = fixture.requests.find((entry) => entry.url === '/v1/chat/completions');
    expect(JSON.parse(chat?.body ?? '{}')).toMatchObject({ model: 'qwen3:8b' });
  });

  it('resolves a null model id to the saved one through the registry', async () => {
    const fixture = await echoFixture(['llama3.2', 'qwen3:8b']);
    const registry = new AIProviderRegistry(testAIProviderRegistryInput({
      readLocalSettings: () => settings(fixture.endpoint, { model: 'qwen3:8b' }),
    }));

    // The path a session created without an explicit model takes in main.
    expect((await registry.resolveModel('local', null)).id).toBe('qwen3:8b');
  });

  it('says so plainly when the saved model is gone, rather than quietly using another', async () => {
    const fixture = await echoFixture(['llama3.2', 'phi4']);
    const provider = new LocalProvider(() => settings(fixture.endpoint, { model: 'qwen3:8b' }));

    const status = await provider.detect();
    expect(status.errorMessage).toMatch(/no longer available/u);
    // The catalog stays exactly what the server published: the missing model is
    // not invented back into the list.
    expect(status.models.map((model) => model.id)).toEqual(['llama3.2', 'phi4']);
  });

  it('refuses a turn that explicitly names a model the server no longer has', async () => {
    const fixture = await echoFixture(['llama3.2']);
    const provider = new LocalProvider(() => settings(fixture.endpoint, { model: 'qwen3:8b' }));

    await expect(collect(provider, { ...CHAT_REQUEST, modelId: 'qwen3:8b' }))
      .rejects.toThrow(/no longer available/u);
  });

  it('never lets one endpoint be answered by the other endpoint catalog', async () => {
    // A slow first server and a fast second one, probed in that order. An
    // unkeyed single-flight would hand B whatever A eventually replied.
    const slow = await startFixture((request, response) => {
      if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'model-from-a' }] }));
      }, 120);
    });
    const fast = await echoFixture(['model-from-b']);

    let current = settings(slow.endpoint);
    const provider = new LocalProvider(() => current);

    const first = provider.detect();
    // Switch endpoints while A's probe is still in the air.
    current = settings(fast.endpoint);
    const second = await provider.detect();
    expect(second.models.map((model) => model.id)).toEqual(['model-from-b']);

    expect((await first).models.map((model) => model.id)).toEqual(['model-from-a']);
    // And the cache left behind belongs to B, not to whichever settled last.
    expect((await provider.listModels()).map((model) => model.id)).toEqual(['model-from-b']);
  });

  it('re-reads the server when a check is forced, and serves the cache otherwise', async () => {
    let published = ['first-model'];
    const fixture = await startFixture((request, response) => {
      if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: published.map((id) => ({ id })) }));
    });
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    expect((await provider.detect()).models.map((model) => model.id)).toEqual(['first-model']);
    published = ['second-model'];
    // Within the TTL an ordinary status read is still allowed to be cached.
    expect((await provider.detect()).models.map((model) => model.id)).toEqual(['first-model']);
    // A check the user asked for is not.
    expect((await provider.detect({ forceRefresh: true })).models.map((model) => model.id)).toEqual(['second-model']);

    const probes = fixture.requests.filter((entry) => entry.url === '/v1/models');
    expect(probes).toHaveLength(2);
    // Still read-only: a forced check lists models and starts no inference.
    expect(fixture.requests.some((entry) => entry.url === '/v1/chat/completions')).toBe(false);
  });
});

/**
 * Where a line ends, and what counts as a line.
 *
 * The stream framer measures raw bytes as they arrive rather than waiting for a
 * reader to hand it a finished line, so the bounds have to hold at the two
 * places that are easy to miss: a line whose terminator arrives together with
 * the bytes that push it over the cap, and the trailing line of a body that
 * simply ends.
 */
describe('Loopback stream framing bounds', () => {
  /** Serve a body in ordered pieces, each flushed before the next is written. */
  async function pieceFixture(pieces: readonly (string | Buffer)[]): Promise<Fixture> {
    return startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (index: number): void => {
        const piece = pieces[index];
        if (piece === undefined) { response.end(); return; }
        response.write(piece, () => { send(index + 1); });
      };
      send(0);
    });
  }

  function readLines(fixture: Fixture, maxLines?: number): Promise<string[]> {
    return (async () => {
      const seen: string[] = [];
      for await (const line of loopbackStreamLines({
        endpoint: endpointOf(fixture.endpoint),
        path: '/v1/chat/completions',
        method: 'POST',
        body: '{}',
        // Generous, so only the framing bounds under test can fire.
        maxBytes: 8 * 1024 * 1024,
        ...(maxLines === undefined ? {} : { maxLines }),
        timeoutMs: 10_000,
      })) seen.push(line);
      return seen;
    })();
  }

  it('accepts a line of exactly the maximum length', async () => {
    const fixture = await pieceFixture(['a'.repeat(LOOPBACK_MAX_LINE_LENGTH), '\n']);
    const lines = await readLines(fixture);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(LOOPBACK_MAX_LINE_LENGTH);
  });

  it('rejects an over-long line whose newline arrives with the bytes that break the cap', async () => {
    // The first piece stops exactly on the cap, so nothing pending is ever
    // over-long; the cap can only be broken by the finished line itself.
    const fixture = await pieceFixture(['a'.repeat(LOOPBACK_MAX_LINE_LENGTH), 'bbbbbbbbbb\n']);
    await expect(readLines(fixture)).rejects.toThrow(/malformed response/u);
  });

  it('counts the unterminated last line against the line budget instead of dropping it', async () => {
    // Two terminated lines spend the budget; the third has no newline because
    // the server simply stopped, which is a line all the same.
    const fixture = await pieceFixture(['first\nsecond\nthird']);
    await expect(readLines(fixture, 2)).rejects.toThrow(/more data than Interleaf accepts/u);
  });

  it('still yields an unterminated last line that fits in the budget', async () => {
    const fixture = await pieceFixture(['first\nsecond\nthird']);
    expect(await readLines(fixture, 3)).toEqual(['first', 'second', 'third']);
  });
});

/**
 * One catalog table per server, not one slot for "the current server".
 *
 * Every test here uses a fixture whose reply timing it controls, because the
 * failures being ruled out are ordering failures: a stale answer arriving after
 * a fresh one, or one endpoint's read being satisfied by another's.
 */
describe('Local catalog cache keys and generations', () => {
  /** A models-only fixture whose nth reply is `replies[n]`, after its delay. */
  async function scriptedFixture(
    replies: readonly { readonly models: readonly string[]; readonly delayMs: number }[]
  ): Promise<Fixture> {
    let served = 0;
    return startFixture((request, response) => {
      if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
      const reply = replies[served] ?? replies[replies.length - 1];
      served += 1;
      const send = (): void => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: (reply?.models ?? []).map((id) => ({ id })) }));
      };
      if (reply === undefined || reply.delayMs === 0) send();
      else setTimeout(send, reply.delayMs);
    });
  }

  const ids = (models: readonly { readonly id: string }[]): string[] => models.map((model) => model.id);

  it('does not let a read already in flight overwrite the forced refresh that replaced it', async () => {
    // The ordinary read is slow; the forced one that overtakes it is not. The
    // slow answer lands last and describes the server before the user asked to
    // look again, so it must not become the cached catalog.
    const fixture = await scriptedFixture([
      { models: ['stale-model'], delayMs: 150 },
      { models: ['fresh-model'], delayMs: 0 },
    ]);
    const provider = new LocalProvider(() => settings(fixture.endpoint));

    const slow = provider.detect();
    const forced = await provider.detect({ forceRefresh: true });
    expect(ids(forced.models)).toEqual(['fresh-model']);

    // The slow caller still receives its own answer — it is not cancelled, only
    // denied the cache.
    expect(ids((await slow).models)).toEqual(['stale-model']);
    expect(ids(await provider.listModels())).toEqual(['fresh-model']);
  });

  it('caches two endpoints side by side instead of one replacing the other', async () => {
    const a = await scriptedFixture([{ models: ['model-from-a'], delayMs: 60 }]);
    const b = await scriptedFixture([{ models: ['model-from-b'], delayMs: 60 }]);

    let current = settings(a.endpoint);
    const provider = new LocalProvider(() => current);
    const first = provider.detect();
    current = settings(b.endpoint);
    const second = provider.detect();

    // Independently single-flight: neither read waits for the other, and each
    // gets the catalog of the server it actually asked.
    const [statusA, statusB] = await Promise.all([first, second]);
    expect(ids(statusA.models)).toEqual(['model-from-a']);
    expect(ids(statusB.models)).toEqual(['model-from-b']);

    // A single cache slot would have been overwritten by B, forcing a second
    // probe of A. Both entries survive, so A is still served from cache.
    current = settings(a.endpoint);
    expect(ids(await provider.listModels())).toEqual(['model-from-a']);
    expect(a.requests.filter((entry) => entry.url === '/v1/models')).toHaveLength(1);
    expect(b.requests.filter((entry) => entry.url === '/v1/models')).toHaveLength(1);
  });

  it('keeps a forced refresh of one endpoint from discarding the other endpoint cache', async () => {
    const a = await scriptedFixture([{ models: ['model-from-a'], delayMs: 0 }]);
    const b = await scriptedFixture([
      { models: ['b-first'], delayMs: 0 },
      { models: ['b-second'], delayMs: 0 },
    ]);

    let current = settings(a.endpoint);
    const provider = new LocalProvider(() => current);
    expect(ids((await provider.detect()).models)).toEqual(['model-from-a']);

    current = settings(b.endpoint);
    expect(ids((await provider.detect()).models)).toEqual(['b-first']);
    expect(ids((await provider.detect({ forceRefresh: true })).models)).toEqual(['b-second']);

    current = settings(a.endpoint);
    expect(ids(await provider.listModels())).toEqual(['model-from-a']);
    expect(a.requests.filter((entry) => entry.url === '/v1/models')).toHaveLength(1);
  });
});
