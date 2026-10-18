/**
 * How each Reader Chat transport carries one turn's reasoning level, and that
 * a level the bound model does not offer stops the turn before any process is
 * spawned or any request is sent. Every transport here is a local double or a
 * loopback fixture; nothing reaches a paid provider.
 */
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliAIProvider,
  createCliProviderDefinitions,
  type CliChildProcess,
  type CliProcessSpawner,
} from '@main/ai/providers/cli-ai-provider';
import { cliReasoningArgs } from '@main/ai/providers/cli-reasoning-args';
import { OpenRouterProvider, type OpenRouterKeyStore } from '@main/ai/providers/openrouter-provider';
import { LocalProvider } from '@main/ai/providers/local-provider';
import type { ProviderChatEvent, ProviderChatRequest } from '@main/ai/providers/types';
import type { AIModelInfo, ReasoningEffort } from '@shared/types/ai';
import { isPortableRecord, parsePortableJson, type PortableRecord } from '@shared/models/portable';
import { USABLE_CREDENTIAL_STORAGE } from '../helpers/credential-status';
import { silentLogger } from '../helpers/silent-logger';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    this.emit('close', null, 'SIGTERM');
    return true;
  }
  close(code = 0): void {
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

function asChild(child: FakeChild): CliChildProcess {
  return child;
}

const base: AIModelInfo = { id: 'm', name: 'M', contextWindow: 32_000, maxOutputTokens: 2_048, supportsStreaming: true };

function turn(modelId: string | null, reasoningEffort?: ReasoningEffort): ProviderChatRequest {
  return {
    requestId: 'turn-1',
    modelId,
    systemPrompt: 'Use only the supplied reference data.',
    contextXml: '<document/>',
    history: [],
    userMessage: 'Hello',
    sources: [],
    webSearch: false,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

async function drain(stream: AsyncIterable<ProviderChatEvent>): Promise<readonly ProviderChatEvent[]> {
  const events: ProviderChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function body(text: string | undefined): PortableRecord {
  const parsed = parsePortableJson(text ?? '');
  if (!isPortableRecord(parsed)) throw new Error('request body is not a record');
  return parsed;
}

describe('cliReasoningArgs', () => {
  const models: AIModelInfo[] = [
    { ...base, id: 'sentinel', reasoning: { levels: ['low', 'high', 'none', 'off'] } },
    { ...base, id: 'plain' },
  ];

  it('maps each CLI to its documented flag, after a level the model offers', () => {
    expect(cliReasoningArgs('codex', null, models, 'high')).toEqual(['-c', 'model_reasoning_effort="high"']);
    expect(cliReasoningArgs('codex', 'sentinel', models, 'none')).toEqual(['-c', 'model_reasoning_effort="none"']);
    expect(cliReasoningArgs('claude', null, models, 'low')).toEqual(['--effort', 'low']);
    expect(cliReasoningArgs('pi', null, models, 'off')).toEqual(['--thinking', 'off']);
    expect(cliReasoningArgs('omp', null, models, 'high')).toEqual(['--thinking', 'high']);
  });

  it('sends nothing for Default', () => {
    expect(cliReasoningArgs('codex', 'plain', models, undefined)).toEqual([]);
  });

  it('refuses a level the model or the CLI flag does not take', () => {
    expect(() => cliReasoningArgs('codex', 'plain', models, 'high')).toThrow(/does not offer/u);
    expect(() => cliReasoningArgs('codex', 'missing', models, 'high')).toThrow(/does not offer/u);
    // Listed for the model, but outside Claude's `--effort` vocabulary.
    expect(() => cliReasoningArgs('claude', null, models, 'none')).toThrow(/does not offer/u);
    expect(() => cliReasoningArgs('codex', null, models, 'off')).toThrow(/does not offer/u);
    expect(() => cliReasoningArgs('local', null, models, 'high')).toThrow(/does not offer/u);
  });
});

describe('CliAIProvider reasoning effort', () => {
  const found = createCliProviderDefinitions().find((definition) => definition.id === 'codex');
  if (found === undefined) throw new Error('codex definition missing');
  const codex = found;

  function provider(spawnProcess: CliProcessSpawner, cleanup = vi.fn(() => Promise.resolve())) {
    return new CliAIProvider(codex, '/safe/chat-root', {
      execFile: vi.fn((_binary: string, args: readonly string[]) => Promise.resolve(
        args[0] === '--version' ? { stdout: 'codex-cli 0.154.0', stderr: '' } : { stdout: 'Logged in using ChatGPT', stderr: '' }
      )),
      resolveBinary: () => Promise.resolve('/canonical/codex'),
      prepareChatDirectory: () => Promise.resolve({ path: '/safe/empty-chat', cleanup }),
      spawnProcess,
      modelListing: () => Promise.resolve({
        models: [{ id: 'gpt-b', reasoning: { levels: ['low', 'xhigh'] } }],
        defaultReasoning: { levels: ['medium', 'high'] },
      }),
      logger: silentLogger,
    });
  }

  it('appends the listed model’s level to the fixed argv', async () => {
    const spawned: (readonly string[])[] = [];
    const spawnProcess: CliProcessSpawner = (_binary, args) => {
      spawned.push(args);
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write('{"type":"item.delta","delta":{"text":"Hi"}}\n');
        child.stdout.end();
        child.close(0);
      });
      return asChild(child);
    };
    const cli = provider(spawnProcess);
    const models = await cli.listModels();
    expect(models.map((model) => [model.id, model.reasoning?.levels])).toEqual([
      [codex.model.id, ['medium', 'high']],
      ['gpt-b', ['low', 'xhigh']],
    ]);
    await drain(cli.streamChat(turn(null, 'high')));
    await drain(cli.streamChat(turn('gpt-b', 'xhigh')));
    await drain(cli.streamChat(turn('gpt-b')));
    expect(spawned[0]?.slice(-2)).toEqual(['-c', 'model_reasoning_effort="high"']);
    expect(spawned[1]?.slice(-2)).toEqual(['-c', 'model_reasoning_effort="xhigh"']);
    expect(spawned[2]?.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('spawns nothing and cleans up for a level the model does not offer', async () => {
    const spawnProcess = vi.fn<CliProcessSpawner>();
    const cleanup = vi.fn(() => Promise.resolve());
    const cli = provider(spawnProcess, cleanup);
    await cli.listModels();
    await expect(drain(cli.streamChat(turn('gpt-b', 'high')))).rejects.toThrow(/does not offer/u);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('OpenRouterProvider reasoning effort', () => {
  const vault: OpenRouterKeyStore = {
    getOpenRouterKey: () => Promise.resolve('sk-or-v1-mock-key'),
    hasOpenRouterKey: () => Promise.resolve(true),
    setOpenRouterKey: () => Promise.resolve(),
    clearOpenRouterKey: () => Promise.resolve(),
    describeStorage: () => USABLE_CREDENTIAL_STORAGE,
  };
  const catalog = {
    data: [
      { id: 'anthropic/thinker', name: 'Thinker', reasoning: { supported_efforts: ['low', 'high'] } },
      { id: 'openai/plain', name: 'Plain' },
    ],
  };

  function sse(...events: readonly string[]): Response {
    return new Response(events.map((event) => `data: ${event}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  /** The URL a fetch call was made with. */
  function urlOf(input: Parameters<typeof fetch>[0]): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  }

  function mockFetch(stream: () => Response) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => Promise.resolve(
      urlOf(input).endsWith('/models') ? new Response(JSON.stringify(catalog), { status: 200 }) : stream()
    ));
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it('reads catalog levels and sends the effort with require_parameters', async () => {
    const fetchSpy = mockFetch(() => sse('{"choices":[{"delta":{"content":"Hi"}}]}', '[DONE]'));
    const provider = new OpenRouterProvider(vault);
    const listed = await provider.listCatalogModels();
    expect(listed.find((model) => model.id === 'anthropic/thinker')?.reasoning).toEqual({ levels: ['low', 'high'] });
    expect(listed.find((model) => model.id === 'openai/plain')).not.toHaveProperty('reasoning');

    await drain(provider.streamChat(turn('anthropic/thinker', 'high')));
    const chat = fetchSpy.mock.calls.find(([input]) => urlOf(input).endsWith('/chat/completions'));
    const sent = body(typeof chat?.[1]?.body === 'string' ? chat[1].body : undefined);
    expect(sent.reasoning).toEqual({ effort: 'high' });
    expect(sent.provider).toEqual({ require_parameters: true });
  });

  it('sends no reasoning fields for Default', async () => {
    const fetchSpy = mockFetch(() => sse('{"choices":[{"delta":{"content":"Hi"}}]}', '[DONE]'));
    await drain(new OpenRouterProvider(vault).streamChat(turn('anthropic/thinker')));
    const chat = fetchSpy.mock.calls.find(([input]) => urlOf(input).endsWith('/chat/completions'));
    const sent = body(typeof chat?.[1]?.body === 'string' ? chat[1].body : undefined);
    expect(sent).not.toHaveProperty('reasoning');
    expect(sent).not.toHaveProperty('provider');
  });

  it('sends nothing for a level the catalog does not list', async () => {
    const fetchSpy = mockFetch(() => sse('[DONE]'));
    await expect(drain(new OpenRouterProvider(vault).streamChat(turn('openai/plain', 'high')))).rejects.toThrow(/does not offer/u);
    expect(fetchSpy.mock.calls.some(([input]) => urlOf(input).endsWith('/chat/completions'))).toBe(false);
  });

  it('explains an answer the reasoning budget cut off', async () => {
    mockFetch(() => sse('{"choices":[{"delta":{"content":"Partial"},"finish_reason":"length"}]}', '[DONE]'));
    await expect(drain(new OpenRouterProvider(vault).streamChat(turn('anthropic/thinker', 'high'))))
      .rejects.toThrow(/response budget/u);
    mockFetch(() => sse('[DONE]'));
    await expect(drain(new OpenRouterProvider(vault).streamChat(turn('anthropic/thinker', 'low'))))
      .rejects.toThrow(/Choose a lower reasoning effort or Default/u);
  });
});

describe('LocalProvider reasoning effort', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    })));
  });

  async function ollama(thinking: PortableRecord | null): Promise<{ readonly endpoint: string; readonly bodies: string[]; readonly urls: string[] }> {
    const bodies: string[] = [];
    const urls: string[] = [];
    const server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      request.on('end', () => {
        urls.push(request.url ?? '');
        if (request.url === '/v1/models') {
          response.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
        } else if (request.url === '/api/show') {
          response.writeHead(200).end(JSON.stringify({ model_info: {}, ...(thinking === null ? {} : { thinking }) }));
        } else if (request.url === '/v1/chat/completions') {
          bodies.push(text);
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
        } else {
          response.writeHead(404).end();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    return { endpoint: `http://127.0.0.1:${String(port)}`, bodies, urls };
  }

  function local(endpoint: string): LocalProvider {
    return new LocalProvider(() => ({ mode: 'ollama', endpoint, model: null }));
  }

  it('sends an On/Off choice as reasoning_effort medium/none', async () => {
    const fixture = await ollama({ values: [true, false] });
    const provider = local(fixture.endpoint);
    expect((await provider.listModels())[0]?.reasoning).toEqual({ levels: ['off', 'on'] });
    await drain(provider.streamChat(turn(null, 'on')));
    await drain(provider.streamChat(turn(null, 'off')));
    await drain(provider.streamChat(turn(null)));
    expect(fixture.bodies.map((text) => body(text).reasoning_effort)).toEqual(['medium', 'none', undefined]);
  });

  it('sends named levels as advertised and refuses one the model lacks', async () => {
    const fixture = await ollama({ values: ['low', 'high'] });
    const provider = local(fixture.endpoint);
    await drain(provider.streamChat(turn(null, 'high')));
    expect(body(fixture.bodies[0]).reasoning_effort).toBe('high');
    await expect(drain(provider.streamChat(turn(null, 'medium')))).rejects.toThrow(/does not offer/u);
    expect(fixture.bodies).toHaveLength(1);
  });

  it('offers nothing to a model without thinking metadata', async () => {
    const fixture = await ollama(null);
    const provider = local(fixture.endpoint);
    expect((await provider.listModels())[0]).not.toHaveProperty('reasoning');
    await expect(drain(provider.streamChat(turn(null, 'on')))).rejects.toThrow(/does not offer/u);
    expect(fixture.urls).not.toContain('/v1/chat/completions');
  });
});
