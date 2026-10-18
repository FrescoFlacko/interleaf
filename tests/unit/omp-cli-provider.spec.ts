/**
 * Omp Reader Chat adapter.
 *
 * Every process here is a fixture. No test spawns the real `omp` binary, and
 * nothing in this file can reach a paid provider.
 */
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import {
  CliAIProvider,
  createCliProviderDefinitions,
  type CliAIProviderOptions,
  type CliDefinition,
  type CliExecFile,
  type CliChildProcess,
} from '@main/ai/providers/cli-ai-provider';
import {
  buildOmpChatArgs,
  createOmpCatalogProbe,
  isOmpModelSelector,
  OmpStreamParser,
  parseOmpModelCatalog,
  OMP_CHAT_FLAGS,
  OMP_LIST_MODELS_ARGS,
} from '@main/ai/providers/omp-cli';
import { agentJsonToolActivity } from '@main/ai/providers/agent-json-stream';
import type { AIModelInfo } from '@shared/types/ai';
import type { Logger } from '@main/logging/logger';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    const delivered = signal ?? 'SIGTERM';
    this.killSignals.push(delivered);
    this.signalCode = delivered;
    this.emit('close', null, this.signalCode);
    return true;
  }

  close(code = 0): void {
    this.exitCode = code;
    this.signalCode = null;
    this.emit('close', code, null);
  }
}

/** `FakeChild` already answers the provider's child-process seam. */
function childProcess(child: FakeChild): CliChildProcess {
  return child;
}

/** A logger whose calls the test can read back, still usable as a `Logger`. */
type MockLogger = { readonly [TMethod in keyof Logger]: Mock<Logger[TMethod]> };

function logger(): MockLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ompDefinition(): CliDefinition {
  return createCliProviderDefinitions().find((definition) => definition.id === 'omp')!;
}

const MODEL: AIModelInfo = {
  id: 'ollama/qwen3:8b',
  name: 'Qwen3 8B',
  contextWindow: 40_960,
  maxOutputTokens: 4_096,
  supportsStreaming: true,
};

/** `omp models --json`, in the shape the installed 18.1 CLI prints. */
const CATALOG_JSON = JSON.stringify({
  models: [
    { provider: 'ollama', id: 'qwen3:8b', selector: 'ollama/qwen3:8b', name: 'Qwen3 8B', contextWindow: 40_960, maxTokens: 4_096 },
    { provider: 'openrouter', id: '~anthropic/claude-sonnet-latest', selector: 'openrouter/~anthropic/claude-sonnet-latest', name: 'Claude Sonnet', contextWindow: 200_000, maxTokens: 64_000 },
  ],
});

function textDelta(delta: string): string {
  return JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
}

const AGENT_END = JSON.stringify({ type: 'agent_end', messages: [] });

/** An Omp stand-in whose only subcommand is the read-only model listing. */
function fakeOmpExecFile(options: {
  readonly catalog?: string;
  readonly fail?: boolean;
  readonly onCall?: (args: readonly string[], execOptions: ExecFileOptionsWithStringEncoding) => void;
} = {}): CliExecFile {
  return (_binary, args, execOptions) => {
    options.onCall?.(args, execOptions);
    if (args[0] === '--version') return Promise.resolve({ stdout: 'omp/18.1.16', stderr: '' });
    if (args[0] === 'models') {
      if (options.fail === true) return Promise.reject(new Error('probe failed'));
      return Promise.resolve({ stdout: options.catalog ?? CATALOG_JSON, stderr: '' });
    }
    return Promise.reject(new Error(`unexpected omp invocation: ${args[0] ?? ''}`));
  };
}

function ompProvider(execFile: CliExecFile, overrides: Partial<CliAIProviderOptions> = {}): CliAIProvider {
  return new CliAIProvider(ompDefinition(), '/safe/chat-root', {
    execFile,
    resolveBinary: () => Promise.resolve('/canonical/omp'),
    prepareChatDirectory: () => Promise.resolve({ path: '/safe/empty-chat', cleanup: vi.fn(() => Promise.resolve()) }),
    logger: logger(),
    ...overrides,
  });
}

const CHAT_REQUEST = {
  requestId: 'omp-turn',
  modelId: MODEL.id,
  systemPrompt: 'Use only the supplied reference data.',
  contextXml: '<document/>',
  history: [],
  userMessage: 'Summarise section two.',
  sources: [],
  webSearch: false,
} as const;

/** A spawn seam that writes `stdout` to a fresh child, then optionally closes it cleanly. */
function scriptedSpawn(child: FakeChild, stdout: string, close = true): () => CliChildProcess {
  return () => {
    setImmediate(() => {
      child.stdout.write(stdout);
      if (!close) return;
      child.stdout.end();
      child.close(0);
    });
    return childProcess(child);
  };
}

async function collect(provider: CliAIProvider, request = CHAT_REQUEST): Promise<string> {
  let text = '';
  for await (const event of provider.streamChat(request)) {
    if (event.type === 'token') text += event.token;
  }
  return text;
}

describe('Omp Reader Chat argv', () => {
  it('enforces every tool-free and isolation flag as whole argv tokens', () => {
    const args = buildOmpChatArgs({
      modelId: MODEL.id, models: [MODEL], systemPrompt: 'Reader AI prompt.', chatRoot: '/safe/empty-chat',
    });

    for (const required of [
      '--mode', '--print', '--no-tools', '--no-lsp', '--no-pty', '--no-extensions',
      '--no-skills', '--no-rules', '--no-session', '--no-title', '--approval-mode',
    ]) expect(args).toContain(required);
    expect(args[args.indexOf('--mode') + 1]).toBe('json');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('always-ask');
    // The Reader AI prompt replaces Omp's coding prompt, and the append slot is
    // explicitly emptied so discovered system text cannot extend it.
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Reader AI prompt.');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/safe/empty-chat');
    expect(args[args.indexOf('--model') + 1]).toBe(MODEL.id);
    for (const forbidden of ['--tools', '--yolo', '--allow-tool', '--session', '--print-thoughts']) {
      expect(args).not.toContain(forbidden);
    }
    expect(args.slice(0, OMP_CHAT_FLAGS.length)).toEqual([...OMP_CHAT_FLAGS]);
    // The document, history and question are never interpolated into argv.
    expect(args.join(' ')).not.toContain('Summarise section two.');
    expect(args.join(' ')).not.toContain('<document');
  });

  it('accepts the selector shapes Omp actually publishes', () => {
    for (const selector of [
      'ollama/qwen3:8b',
      'openrouter/~anthropic/claude-sonnet-latest',
      'ollama/hf.co/prithivMLmods/LFM2-2.6B-Exp-GGUF:BF16',
      'google-antigravity/claude-opus-4-6',
    ]) expect(isOmpModelSelector(selector)).toBe(true);
  });

  it('refuses a selector the catalog did not publish, and any injected token', () => {
    for (const hostile of [
      '--approval-mode=yolo', 'ollama/qwen3:8b --no-tools=false', '../../etc/passwd',
      'ollama/qwen3;rm -rf /', '', 'qwen3:8b', '-ollama/qwen3:8b', 'ollama/qwen3 8b',
      `ollama/${'a'.repeat(200)}`,
    ]) {
      expect(isOmpModelSelector(hostile)).toBe(false);
      expect(() => buildOmpChatArgs({
        modelId: hostile, models: [MODEL], systemPrompt: 'p', chatRoot: '/safe/empty-chat',
      })).toThrow('omp-model-unavailable');
    }
    // Well-formed but absent from the catalog is refused for the same reason:
    // shape is not entitlement.
    expect(() => buildOmpChatArgs({
      modelId: 'openrouter/openai/gpt-5', models: [MODEL], systemPrompt: 'p', chatRoot: '/safe/empty-chat',
    })).toThrow('omp-model-unavailable');
  });

  it('stops selectors at the same 128 characters the session row can store', () => {
    // `modelIdSchema` in the shared AI contract caps a model id at 128. A
    // longer selector accepted here would pass validation, reach Omp, and then
    // fail when the session that must remember it is written — so the limit is
    // enforced where the value is first read instead.
    const atLimit = `ollama/${'a'.repeat(121)}`;
    const overLimit = `ollama/${'a'.repeat(122)}`;
    expect(atLimit).toHaveLength(128);
    expect(overLimit).toHaveLength(129);

    expect(isOmpModelSelector(atLimit)).toBe(true);
    expect(isOmpModelSelector(overLimit)).toBe(false);

    const accepted: AIModelInfo = { ...MODEL, id: atLimit };
    expect(buildOmpChatArgs({
      modelId: atLimit, models: [accepted], systemPrompt: 'p', chatRoot: '/safe/empty-chat',
    })).toContain(atLimit);
    expect(() => buildOmpChatArgs({
      modelId: overLimit, models: [{ ...MODEL, id: overLimit }], systemPrompt: 'p', chatRoot: '/safe/empty-chat',
    })).toThrow('omp-model-unavailable');
  });

  it('drops an over-length selector from the catalog instead of publishing it', () => {
    const models = parseOmpModelCatalog(JSON.stringify({
      models: [
        { provider: 'ollama', selector: `ollama/${'a'.repeat(121)}`, name: 'At the limit' },
        { provider: 'ollama', selector: `ollama/${'a'.repeat(122)}`, name: 'One over' },
      ],
    }));
    expect(models.map((model) => model.id)).toEqual([`ollama/${'a'.repeat(121)}`]);
  });

  it('rejects a missing or oversized system prompt rather than sending one', () => {
    for (const prompt of ['', 'x'.repeat(8_193)]) {
      expect(() => buildOmpChatArgs({
        modelId: MODEL.id, models: [MODEL], systemPrompt: prompt, chatRoot: '/safe/empty-chat',
      })).toThrow('omp-system-prompt-invalid');
    }
  });
});

describe('Omp catalog discovery', () => {
  it('lists models without invoking one or asking for credentials, bounded and shell-free in the app-owned directory', async () => {
    const calls: string[][] = [];
    const seen: ExecFileOptionsWithStringEncoding[] = [];
    const provider = ompProvider(fakeOmpExecFile({ onCall: (args, execOptions) => { calls.push([...args]); seen.push(execOptions); } }));
    const status = await provider.detect();

    expect(status.authentication).toBe('connected');
    expect(status.models.map((model) => model.id)).toEqual([
      'ollama/qwen3:8b', 'openrouter/~anthropic/claude-sonnet-latest',
    ]);
    const listing = calls.find((args) => args[0] === 'models');
    expect(listing).toEqual([...OMP_LIST_MODELS_ARGS]);
    // Nothing that would run a model or print a secret.
    for (const call of calls) {
      for (const forbidden of ['--credentials', '--print', 'run', 'auth']) {
        expect(call).not.toContain(forbidden);
      }
    }
    const probe = seen.at(-1)!;
    expect(probe.shell).toBe(false);
    expect(probe.timeout).toBe(10_000);
    expect(typeof probe.maxBuffer).toBe('number');
    expect(probe.cwd).toBe('/safe/chat-root');
    // A minimal allowlisted environment, never the process's own.
    expect(Object.keys(probe.env as Record<string, string>)).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('reports an unreadable probe as unknown rather than connected', async () => {
    const provider = ompProvider(fakeOmpExecFile({ fail: true }));
    const status = await provider.detect();
    expect(status.authentication).toBe('unknown');
    expect(status.models).toEqual([]);
  });

  it('reports an empty credential-filtered catalog as signed out', async () => {
    const provider = ompProvider(fakeOmpExecFile({ catalog: JSON.stringify({ models: [] }) }));
    const status = await provider.detect();
    expect(status.authentication).toBe('disconnected');
  });

  it('caches a successful probe so repeated status checks do not re-run it', async () => {
    let listings = 0;
    const probe = createOmpCatalogProbe();
    const execFile = fakeOmpExecFile({ onCall: (args) => { if (args[0] === 'models') listings += 1; } });
    const context = { binary: '/canonical/omp', executeFile: execFile, cwd: '/safe', log: logger() };

    await probe(context);
    await probe(context);
    expect(listings).toBe(1);
  });
});

describe('Omp catalog parsing treats the listing as untrusted', () => {
  it('drops malformed entries, dedupes, and bounds names', () => {
    const models = parseOmpModelCatalog(JSON.stringify({
      models: [
        { provider: 'ollama', selector: 'ollama/qwen3:8b', name: 'Qwen3 8B' },
        // Duplicate selector.
        { provider: 'ollama', selector: 'ollama/qwen3:8b', name: 'Impostor' },
        // Unusable selectors.
        { provider: 'ollama', selector: '--approval-mode=yolo', name: 'Injected' },
        { provider: 'ollama', selector: 'no-slash', name: 'Injected' },
        { provider: '', selector: 'ollama/orphan:1b', name: 'No provider' },
        'not-an-object',
        null,
        // Control characters in the label must not survive to the UI.
        { provider: 'ollama', selector: 'ollama/gemma4:e4b', name: 'Gem\u001bma\u0000' },
      ],
    }));

    expect(models.map((model) => model.id)).toEqual(['ollama/qwen3:8b', 'ollama/gemma4:e4b']);
    expect(models[0]?.name).toBe('Qwen3 8B');
    expect(models[1]?.name).toBe('Gem ma');
  });

  it('clamps token counts and falls back conservatively when they are absent or absurd', () => {
    const models = parseOmpModelCatalog(JSON.stringify({
      models: [
        { provider: 'a', selector: 'a/one', contextWindow: 5_000_000, maxTokens: 900_000 },
        { provider: 'a', selector: 'a/two', contextWindow: -1, maxTokens: 'lots' },
        { provider: 'a', selector: 'a/three' },
      ],
    }));
    expect(models[0]).toMatchObject({ contextWindow: 2_000_000, maxOutputTokens: 200_000 });
    expect(models[1]).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 4_096 });
    expect(models[2]).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 4_096 });
  });

  it('returns nothing for malformed or non-catalog payloads', () => {
    for (const payload of ['', 'not json', '[]', '{}', JSON.stringify({ models: 'many' })]) {
      expect(parseOmpModelCatalog(payload)).toEqual([]);
    }
  });

  it('bounds the exposed catalog and shares the budget across providers', () => {
    // One provider publishing far more than the cap must not hide the others.
    const entries = [
      ...Array.from({ length: 500 }, (_, index) => ({ provider: 'openrouter', selector: `openrouter/model-${String(index)}` })),
      { provider: 'ollama', selector: 'ollama/qwen3:8b' },
    ];
    const models = parseOmpModelCatalog(JSON.stringify({ models: entries }));
    expect(models).toHaveLength(128);
    expect(models.map((model) => model.id)).toContain('ollama/qwen3:8b');
  });
});

describe('Omp JSON event stream', () => {
  it('emits only assistant text deltas and never reasoning', () => {
    const parser = new OmpStreamParser();
    expect(parser.parseLine(textDelta('Hello'))).toEqual(['Hello']);
    for (const hidden of [
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'secret plan' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } }),
      JSON.stringify({ type: 'message_start' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'some_future_event', delta: 'Hello' }),
      'not json',
      '',
    ]) expect(parser.parseLine(hidden)).toEqual([]);
    expect(parser.parseLine(AGENT_END)).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it('fails closed when the stream ends with no terminal event', () => {
    const parser = new OmpStreamParser();
    parser.parseLine(textDelta('Half an ans'));
    expect(() => parser.finish()).toThrow(/before it was complete/u);
  });

  it('accepts turn_end as well as agent_end', () => {
    const parser = new OmpStreamParser();
    parser.parseLine(textDelta('Done'));
    parser.parseLine(JSON.stringify({ type: 'turn_end', toolResults: [] }));
    expect(() => parser.finish()).not.toThrow();
  });
});

describe('Omp tool-use detection', () => {
  it('flags incremental, aggregate, and OpenAI-shaped tool events', () => {
    for (const line of [
      JSON.stringify({ type: 'tool_execution_start', name: 'bash' }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { name: 'read' } } }),
      JSON.stringify({ type: 'function_call', name: 'read_file' }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'function_call_delta' } }),
      JSON.stringify({ type: 'turn_end', toolResults: [{ role: 'toolResult', content: [] }] }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'toolUse', content: [] }] }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolResult' }] } }),
    ]) expect(agentJsonToolActivity(line)).toBe(true);
  });

  it('treats an oversized envelope as a violation rather than scanning a prefix', () => {
    const messages = Array.from({ length: 65 }, () => ({ role: 'assistant', content: [] }));
    expect(agentJsonToolActivity(JSON.stringify({ type: 'agent_end', messages }))).toBe(true);
    const content = Array.from({ length: 257 }, () => ({ type: 'text', text: 'x' }));
    expect(agentJsonToolActivity(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content } }))).toBe(true);
  });

  it('does not flag ordinary prose that merely names a tool event', () => {
    expect(agentJsonToolActivity(textDelta('The tool_execution_start event means a tool ran.'))).toBe(false);
    expect(agentJsonToolActivity(JSON.stringify({ type: 'agent_end', messages: [] }))).toBe(false);
    expect(agentJsonToolActivity('not json')).toBe(false);
  });
});

describe('Omp streaming turn', () => {
  it('streams assistant text through the production adapter', async () => {
    const provider = ompProvider(fakeOmpExecFile(), {
      spawnProcess: scriptedSpawn(new FakeChild(), `${textDelta('Section two ')}\n${textDelta('argues X.')}\n${AGENT_END}\n`),
    });
    await provider.detect();

    await expect(collect(provider)).resolves.toBe('Section two argues X.');
  });

  it('sends the document, history and question only on stdin', async () => {
    const child = new FakeChild();
    let stdin = '';
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8'); });
    let spawnArgs: readonly string[] = [];
    const emit = scriptedSpawn(child, `${textDelta('ok')}\n${AGENT_END}\n`);
    const provider = ompProvider(fakeOmpExecFile(), {
      spawnProcess: (_binary: string, args: readonly string[]) => { spawnArgs = args; return emit(); },
    });
    await provider.detect();

    await collect(provider);

    expect(stdin).toContain('Summarise section two.');
    expect(stdin).toContain('<document/>');
    expect(spawnArgs.join(' ')).not.toContain('Summarise section two.');
    // The system prompt is Omp's one argv-borne value.
    expect(spawnArgs[spawnArgs.indexOf('--system-prompt') + 1]).toBe(CHAT_REQUEST.systemPrompt);
  });

  it('aborts the turn when a tool event appears, before its payload is read as text', async () => {
    const child = new FakeChild();
    const provider = ompProvider(fakeOmpExecFile(), {
      spawnProcess: scriptedSpawn(child, `${textDelta('Reading ')}\n${JSON.stringify({ type: 'tool_execution_start', name: 'bash' })}\n`, false),
    });
    await provider.detect();

    await expect(collect(provider)).rejects.toThrow(/unsupported tool operation/u);
    expect(child.killSignals.length).toBeGreaterThan(0);
  });

  it('fails a truncated stream that exits cleanly', async () => {
    const provider = ompProvider(fakeOmpExecFile(), {
      spawnProcess: scriptedSpawn(new FakeChild(), `${textDelta('Half an ans')}\n`),
    });
    await provider.detect();

    await expect(collect(provider)).rejects.toThrow(/before it was complete/u);
  });

  it('surfaces a cancelled turn as a safe error', async () => {
    const child = new FakeChild();
    const provider = ompProvider(fakeOmpExecFile(), {
      spawnProcess: () => {
        setImmediate(() => {
          child.stdout.write(`${textDelta('Working')}\n`);
          setImmediate(() => { void provider.cancel(CHAT_REQUEST.requestId); });
        });
        return childProcess(child);
      },
    });
    await provider.detect();

    await expect(collect(provider)).rejects.toThrow(/cancelled/u);
  });
});

describe('Omp provider definition', () => {
  // `hostedWebSearch: false` is what makes the chat service refuse a forged
  // `webSearch: true` request before any provider turn starts; that guard is
  // covered provider-agnostically in tests/unit/chat-service.spec.ts.
  it('declares tool-free chat and no hosted web search', () => {
    const definition = ompDefinition();
    expect(definition.capabilities.toolFreeMode).toBe(true);
    expect(definition.capabilities.hostedWebSearch).toBe(false);
    // No flag enables search or tools; every capability flag is a negation.
    expect(OMP_CHAT_FLAGS.filter((flag) => /^--(?!no-)(web-search|search|tools|extensions)$/u.test(flag))).toEqual([]);
    expect(definition.systemPromptInArgv).toBe(true);
    expect(definition.chatAllowedWhenConnected).toBe(true);
    expect(definition.binary).toBe('omp');
  });
});
