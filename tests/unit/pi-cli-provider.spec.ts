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
  type CliSpawnOptions,
  type CliChildProcess,
} from '@main/ai/providers/cli-ai-provider';
import {
  buildPiAuthCheckArgs,
  buildPiChatArgs,
  isPiModelId,
  parsePiAuthCheck,
  parsePiModelTable,
  piToolActivity,
  PiStreamParser,
  PI_CHAT_FLAGS,
  PI_LIST_MODELS_ARGS,
} from '@main/ai/providers/pi-cli';
import { MAX_SCHEMA_CHUNK_UNITS } from '@main/ai/providers/cli-runtime';
import type { AIModelInfo } from '@shared/types/ai';
import type { ProviderChatEvent } from '@main/ai/providers/types';
import type { Logger } from '@main/logging/logger';
import { buildCliSearchPath } from '@main/app/cli-search-path';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5150;
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

class NeverClosingChild extends FakeChild {
  override kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal ?? 'SIGTERM');
    return false;
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

function piDefinition(): CliDefinition {
  return createCliProviderDefinitions().find((definition) => definition.id === 'pi')!;
}

const MODEL: AIModelInfo = {
  id: 'openai-codex/gpt-5.1-codex',
  name: 'openai-codex/gpt-5.1-codex',
  contextWindow: 272_000,
  maxOutputTokens: 128_000,
  supportsStreaming: true,
};

/** Pi's `--list-models` table, as the installed 0.84.4 CLI prints it. */
const MODEL_TABLE = [
  'provider              model                 context  maxOutput',
  'openai-codex          gpt-5.1-codex         272K     128K',
  'openai-codex          gpt-5.1                272K     128K',
  'anthropic             claude-sonnet-4-5     200K     64K',
].join('\n');

const CODEX_ONLY_LISTING = 'provider  model\nopenai-codex  gpt-5.1-codex  272K  128K';
const ANTHROPIC_ONLY_LISTING = 'provider  model\nanthropic  claude-sonnet-4-5  200K  64K';

const READY_JSON = JSON.stringify({ provider: 'openai-codex', status: 'ready' });
const NOT_READY_JSON = JSON.stringify({ provider: 'anthropic', status: 'not_ready' });

/**
 * A Pi CLI stand-in: `--version` answers, `--list-models` prints the table, and
 * each `auth check` answers per provider. Nothing here performs, or can
 * perform, a paid model call.
 */
function fakePiExecFile(options: {
  readonly listing?: string;
  readonly verdicts?: Readonly<Record<string, string>>;
  readonly onCall?: (args: readonly string[], options: ExecFileOptionsWithStringEncoding) => void;
} = {}): CliExecFile {
  const verdicts = options.verdicts ?? { 'openai-codex': READY_JSON, anthropic: NOT_READY_JSON };
  return (_binary, args, execOptions) => {
    options.onCall?.(args, execOptions);
    if (args[0] === '--version') return Promise.resolve({ stdout: 'pi 0.84.4', stderr: '' });
    if (args.includes('--list-models')) {
      return Promise.resolve({ stdout: options.listing ?? MODEL_TABLE, stderr: '' });
    }
    if (args[0] === 'auth') {
      const provider = args[args.indexOf('--provider') + 1] ?? '';
      const stdout = verdicts[provider];
      if (stdout === undefined) return Promise.reject(new Error('provider_not_found'));
      // `pi auth check` exits 1 for a not-ready provider while still printing
      // its verdict, which the adapter must read rather than discard.
      return JSON.parse(stdout).status === 'ready'
        ? Promise.resolve({ stdout, stderr: '' })
        : Promise.reject(Object.assign(new Error('exit 1'), { stdout, stderr: '', code: 1 }));
    }
    return Promise.reject(new Error(`unexpected pi invocation: ${args[0] ?? ''}`));
  };
}

function piProvider(execFile: CliExecFile, overrides: Partial<CliAIProviderOptions> = {}): CliAIProvider {
  return new CliAIProvider(piDefinition(), '/safe/chat-root', {
    execFile,
    resolveBinary: () => Promise.resolve('/canonical/pi'),
    prepareChatDirectory: () => Promise.resolve({ path: '/safe/empty-chat', cleanup: vi.fn(() => Promise.resolve()) }),
    logger: logger(),
    ...overrides,
  });
}

/** A spawn seam that writes `lines` as JSON events, then optionally ends cleanly. */
function scriptedSpawn(child: FakeChild, lines: readonly object[], close = true): () => CliChildProcess {
  return () => {
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      if (!close) return;
      child.stdout.end();
      child.close(0);
    });
    return childProcess(child);
  };
}

function textDelta(delta: string): object {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } };
}

async function drain(provider: CliAIProvider, request: Parameters<CliAIProvider['streamChat']>[0]): Promise<ProviderChatEvent[]> {
  const events: ProviderChatEvent[] = [];
  for await (const event of provider.streamChat(request)) events.push(event);
  return events;
}

const CHAT_REQUEST = {
  requestId: 'pi-turn',
  modelId: MODEL.id,
  systemPrompt: 'Use only the supplied reference data.',
  contextXml: '<document/>',
  history: [],
  userMessage: 'Summarise section two.',
  sources: [],
  webSearch: false,
} as const;

describe('Pi Reader Chat argv', () => {
  it('enforces every tool-free and isolation flag as whole argv tokens', () => {
    const args = buildPiChatArgs({ modelId: MODEL.id, models: [MODEL], systemPrompt: 'Reader AI prompt.' });

    for (const required of [
      '--mode', '--print', '--no-tools', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-session',
      '--no-approve', '--offline',
    ]) expect(args).toContain(required);
    expect(args[args.indexOf('--mode') + 1]).toBe('json');
    // The Reader AI prompt replaces Pi's coding prompt, and the append slot is
    // explicitly emptied so a discovered APPEND_SYSTEM.md cannot extend it.
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Reader AI prompt.');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe(MODEL.id);
    // Nothing that could re-open a tool, a session or an approval path.
    for (const forbidden of ['--tools', '--yolo', '--credentials', '--allow-tool', '--session']) {
      expect(args).not.toContain(forbidden);
    }
    expect(args.slice(0, PI_CHAT_FLAGS.length)).toEqual([...PI_CHAT_FLAGS]);
  });

  it('never interpolates the document, history or question into argv', () => {
    const args = buildPiChatArgs({ modelId: MODEL.id, models: [MODEL], systemPrompt: 'Reader AI prompt.' });
    expect(args.join('\0')).not.toContain('Summarise section two.');
    expect(args.join('\0')).not.toContain('<document');
  });

  it('refuses a model the CLI did not publish, and any injected token', () => {
    for (const hostile of [
      '--dangerously-skip-permissions', 'openai-codex/gpt-5.1 --no-tools=false',
      '../../etc/passwd', 'openai-codex/gpt;rm -rf /', '', 'gpt-5.1',
    ]) {
      expect(isPiModelId(hostile)).toBe(false);
      expect(() => buildPiChatArgs({ modelId: hostile, models: [MODEL], systemPrompt: 'p' }))
        .toThrow('pi-model-unavailable');
    }
    // Well-formed but absent from the discovered catalog is still refused.
    expect(() => buildPiChatArgs({ modelId: 'anthropic/claude-sonnet-4-5', models: [MODEL], systemPrompt: 'p' }))
      .toThrow('pi-model-unavailable');
    // No catalog at all means no turn, rather than a guessed default.
    expect(() => buildPiChatArgs({ modelId: null, models: [], systemPrompt: 'p' }))
      .toThrow('pi-model-unavailable');
  });

  it('refuses an empty or unbounded system prompt', () => {
    expect(() => buildPiChatArgs({ modelId: MODEL.id, models: [MODEL], systemPrompt: '' }))
      .toThrow('pi-system-prompt-invalid');
    expect(() => buildPiChatArgs({ modelId: MODEL.id, models: [MODEL], systemPrompt: 'x'.repeat(8_193) }))
      .toThrow('pi-system-prompt-invalid');
  });

  it('asks only whether a provider is usable, never for the credential', () => {
    expect(buildPiAuthCheckArgs('openai-codex')).toEqual([
      'auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh',
    ]);
    expect(buildPiAuthCheckArgs('openai-codex')).not.toContain('--credentials');
    expect(PI_LIST_MODELS_ARGS).toContain('--offline');
    expect(PI_LIST_MODELS_ARGS).toContain('--no-extensions');
  });
});

describe('Pi discovery and status', () => {
  it('reports connected with only the ready models, probing shell-free, bounded, outside user directories', async () => {
    const seen: string[][] = [];
    const options: ExecFileOptionsWithStringEncoding[] = [];
    const provider = piProvider(fakePiExecFile({
      onCall: (args, execOptions) => { seen.push([...args]); options.push(execOptions); },
    }));

    const status = await provider.detect();

    expect(status.installed).toBe(true);
    expect(status.authentication).toBe('connected');
    expect(status.available).toBe(true);
    expect(status.errorMessage).toBeNull();
    expect(status.version).toBe('pi 0.84.4');
    expect(status.capabilities.toolFreeMode).toBe(true);
    expect(status.capabilities.hostedWebSearch).toBe(false);
    // The signed-out provider's models never reach the renderer.
    expect(status.models.map((model) => model.id)).toEqual(['openai-codex/gpt-5.1-codex', 'openai-codex/gpt-5.1']);
    expect(status.models[0]?.contextWindow).toBe(272_000);
    // Each probe is bounded, shell-free and runs in the app-owned directory.
    for (const args of seen.slice(1)) expect(args).not.toContain('--credentials');
    expect(options.length).toBeGreaterThan(1);
    for (const option of options.slice(1)) {
      expect(option.shell).toBe(false);
      expect(option.cwd).toBe('/safe/chat-root');
      expect(option.timeout).toBe(10_000);
      const { env } = option;
      if (env === undefined) throw new Error('Pi must be probed with an explicit minimal environment.');
      expect(env.PATH).toBe(buildCliSearchPath());
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
  });

  it('is signed out, not ready, when every provider answers not ready', async () => {
    const provider = piProvider(fakePiExecFile({
      listing: ANTHROPIC_ONLY_LISTING,
      verdicts: { anthropic: NOT_READY_JSON },
    }));

    const status = await provider.detect();

    expect(status.authentication).toBe('disconnected');
    expect(status.available).toBe(false);
    expect(status.models).toEqual([]);
    expect(status.errorMessage).toContain('Sign in');
  });

  it('never leaks probe output, paths or account detail into diagnostics', async () => {
    const log = logger();
    const provider = piProvider(
      () => Promise.reject(new Error('token=secret-value account=person@example.com')),
      { logger: log },
    );

    const status = await provider.detect();

    expect(status.available).toBe(false);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain('secret-value');
    expect(logged).not.toContain('person@example.com');
    expect(logged).not.toContain('/canonical/pi');
  });

  it('classifies auth verdicts only for the provider that was asked about', () => {
    expect(parsePiAuthCheck(READY_JSON, 'openai-codex')).toBe('ready');
    expect(parsePiAuthCheck(NOT_READY_JSON, 'anthropic')).toBe('not-ready');
    // Another provider's verdict, an unknown status, and unparseable output.
    expect(parsePiAuthCheck(READY_JSON, 'anthropic')).toBe('unknown');
    expect(parsePiAuthCheck(JSON.stringify({ provider: 'anthropic', status: 'maybe' }), 'anthropic')).toBe('unknown');
    expect(parsePiAuthCheck('not json at all', 'anthropic')).toBe('unknown');
    expect(parsePiAuthCheck('[]', 'anthropic')).toBe('unknown');
  });

  it('accepts ready only from a clean exit, and the documented exit-1 verdict only as not ready', async () => {
    const cleanReady = await piProvider(fakePiExecFile({
      listing: CODEX_ONLY_LISTING,
      verdicts: { 'openai-codex': READY_JSON },
    })).detect();
    expect(cleanReady.authentication).toBe('connected');
    expect(cleanReady.models.map((model) => model.id)).toEqual(['openai-codex/gpt-5.1-codex']);

    // The one rejection Pi documents: it ran to completion, exited 1, printed
    // its verdict. Readable, but only ever as a refusal.
    const notReady = await piProvider(fakePiExecFile({
      listing: CODEX_ONLY_LISTING,
      verdicts: { 'openai-codex': JSON.stringify({ provider: 'openai-codex', status: 'not_ready' }) },
    })).detect();
    expect(notReady.authentication).toBe('disconnected');
    expect(notReady.models).toEqual([]);
  });

  // A timeout kill, a maxBuffer abort, an exit-1 that claims readiness, and an
  // unexplained exit status: whatever the payload says, none of these is
  // evidence that the provider is usable. Exactly the child-process failure
  // fields the adapter reads back.
  it.each<{ killed?: boolean; signal?: string; code?: string | number }>([
    { killed: true, signal: 'SIGTERM' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true },
    { code: 'ETIMEDOUT' },
    { code: 1 },
    { code: 7 },
    { signal: 'SIGKILL' },
  ])('never treats a failed probe ($code/$signal) carrying ready-shaped output as signed in', async (failure) => {
    const provider = piProvider((_binary, args) => {
      if (args[0] === '--version') return Promise.resolve({ stdout: 'pi 0.84.4', stderr: '' });
      if (args.includes('--list-models')) return Promise.resolve({ stdout: CODEX_ONLY_LISTING, stderr: '' });
      return Promise.reject(Object.assign(new Error('probe failed'), { stderr: '', stdout: READY_JSON, ...failure }));
    });

    const status = await provider.detect();

    expect(status.authentication).not.toBe('connected');
    expect(status.models).toEqual([]);
    expect(status.available).toBe(false);
    expect(status.errorMessage).toContain('Sign in');
  });

  it('keeps only validated identifiers out of an untrusted model listing', () => {
    const rows = parsePiModelTable([
      'provider  model  context  maxOutput',
      'openai-codex  gpt-5.1-codex  272K  128K',
      '--dangerously-skip-permissions  x  1  1',
      'evil  model name with spaces  1  1',
      'openai-codex  gpt-5.1-codex  272K  128K',
      'anthropic  claude-sonnet-4-5  1.5M  64K',
      'weird  model  999999999999  99999999',
    ].join('\n'));

    expect(rows.map((row) => row.id)).toEqual([
      'openai-codex/gpt-5.1-codex',
      // 'evil/model' is a real pair: only the trailing words are dropped.
      'evil/model',
      'anthropic/claude-sonnet-4-5',
      'weird/model',
    ]);
    expect(rows.find((row) => row.id === 'anthropic/claude-sonnet-4-5')?.model.contextWindow).toBe(1_500_000);
    // Absurd counts are bounded rather than believed.
    expect(rows.find((row) => row.id === 'weird/model')?.model.contextWindow).toBeLessThanOrEqual(2_000_000);
    expect(rows.every((row) => isPiModelId(row.id))).toBe(true);
  });
});

describe('Pi JSON stream parsing', () => {
  it('renders only assistant text deltas, once', () => {
    const parser = new PiStreamParser();

    expect(parser.parseLine(JSON.stringify({
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
    }))).toEqual(['Hello ']);
    expect(parser.parseLine(JSON.stringify({
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world.' },
    }))).toEqual(['world.']);
    // Thinking, the authoritative end snapshot, lifecycle and unknown events
    // are all silent, so nothing is duplicated or invented.
    for (const line of [
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }),
      JSON.stringify({ type: 'message_end', message: { content: [{ type: 'text', text: 'Hello world.' }] } }),
      JSON.stringify({ type: 'turn_start' }),
      JSON.stringify({ type: 'some_future_event', assistantMessageEvent: { type: 'text_delta', delta: 'no' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 42 } }),
      '{ this is not json',
      '',
      '[]',
      'null',
    ]) expect(parser.parseLine(line)).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it('chunks an oversized delta without losing or duplicating text', () => {
    const delta = 'x'.repeat(MAX_SCHEMA_CHUNK_UNITS + 25);
    const chunks = new PiStreamParser().parseLine(JSON.stringify({
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta },
    }));

    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe(delta);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_SCHEMA_CHUNK_UNITS);
  });

  it('treats every tool-related event as a violation, not as content', () => {
    for (const line of [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }),
      JSON.stringify({ type: 'tool_execution_update' }),
      JSON.stringify({ type: 'tool_execution_end', result: 'root:x:0:0' }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', toolName: 'read' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path"' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } }),
      JSON.stringify({ type: 'turn_end', toolResults: [{ toolName: 'bash', output: 'secret' }] }),
    ]) {
      expect(piToolActivity(line)).toBe(true);
      // A violation is never rendered as assistant text either.
      expect(new PiStreamParser().parseLine(line)).toEqual([]);
    }
    // An ordinary turn end and ordinary text are not violations.
    expect(piToolActivity(JSON.stringify({ type: 'turn_end', toolResults: [] }))).toBe(false);
    expect(piToolActivity(JSON.stringify({
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'tool_execution_start' },
    }))).toBe(false);
    // Non-JSON noise is not a tool event; the parser already ignores it.
    expect(piToolActivity('warning: update available')).toBe(false);
  });

  it('rejects tool calls and results carried inside aggregate message envelopes', () => {
    const toolCallMessage = {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'text', text: 'Reading it now.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
    };
    for (const line of [
      // `message_start`/`message_end` carry the whole assistant message, so a
      // tool call can arrive without any tool-shaped event type.
      JSON.stringify({ type: 'message_start', message: toolCallMessage }),
      JSON.stringify({ type: 'message_end', message: toolCallMessage }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [] } }),
      // Terminal events aggregate the turn's messages and its tool results.
      JSON.stringify({ type: 'turn_end', message: toolCallMessage, toolResults: [] }),
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        toolResults: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'root:x:0:0' }] }],
      }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: 'hi' }, toolCallMessage] }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [] }],
      }),
      // The assistant event's own terminal payloads.
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'done', message: toolCallMessage } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'error', error: toolCallMessage } }),
    ]) {
      expect(piToolActivity(line)).toBe(true);
      expect(new PiStreamParser().parseLine(line)).toEqual([]);
    }

    // Ordinary aggregates, including assistant prose that merely discusses
    // tool events, stay ordinary: detection is structural, not textual.
    const plainMessage = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'A tool_execution_start event means the model called a "toolCall".' }],
    };
    for (const line of [
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'message_end', message: plainMessage }),
      JSON.stringify({ type: 'turn_end', message: plainMessage, toolResults: [] }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: 'hi' }, plainMessage] }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'done', message: plainMessage } }),
    ]) expect(piToolActivity(line)).toBe(false);
  });

  it('fails closed on an aggregate too large to scan instead of trusting its prefix', () => {
    // The scan is bounded for cost, so the bound itself must be a refusal: a
    // truncated scan would let a tool call sitting past the cut-off through.
    const plainMessage = (index: number) => ({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: `part ${String(index)}` }],
    });
    const textParts = (count: number) => Array.from({ length: count }, (_unused, index) => ({
      type: 'text', text: `part ${String(index)}`,
    }));

    // 1. An over-long message list, every entry of it ordinary.
    expect(piToolActivity(JSON.stringify({
      type: 'agent_end',
      messages: Array.from({ length: 65 }, (_unused, index) => plainMessage(index)),
    }))).toBe(true);
    expect(piToolActivity(JSON.stringify({
      type: 'turn_end',
      message: plainMessage(0),
      toolResults: Array.from({ length: 65 }, (_unused, index) => plainMessage(index)),
    }))).toBe(true);

    // 2. An over-long content list, all of it plain text.
    expect(piToolActivity(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: textParts(257) },
    }))).toBe(true);

    // 3. Exactly at each bound the aggregate is still scanned structurally,
    //    and ordinary content is still ordinary.
    expect(piToolActivity(JSON.stringify({
      type: 'agent_end',
      messages: Array.from({ length: 64 }, (_unused, index) => plainMessage(index)),
    }))).toBe(false);
    expect(piToolActivity(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: textParts(256) },
    }))).toBe(false);

    // 4. Tool activity at or within the accepted bounds is still caught, so
    //    the bound refuses extra work rather than replacing the scan.
    const lastMessages = Array.from({ length: 64 }, (_unused, index) => plainMessage(index));
    lastMessages[63] = { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [] } as never;
    expect(piToolActivity(JSON.stringify({ type: 'agent_end', messages: lastMessages }))).toBe(true);

    const lastParts = textParts(256);
    lastParts[255] = { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} } as never;
    expect(piToolActivity(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: lastParts },
    }))).toBe(true);
  });
});

describe('Pi streaming boundary', () => {
  it('spawns the canonical binary with the enforced argv in an app-owned empty cwd', async () => {
    const child = new FakeChild();
    let spawned: { binary: string; args: readonly string[]; options: CliSpawnOptions } | null = null;
    const emit = scriptedSpawn(child, [textDelta('Section two argues X.')]);
    const provider = piProvider(fakePiExecFile(), {
      spawnProcess: (binary: string, args: readonly string[], options: CliSpawnOptions) => {
        spawned = { binary, args, options };
        return emit();
      },
    });
    await provider.detect();

    const events = await drain(provider, CHAT_REQUEST);

    expect(events).toEqual([{ type: 'token', token: 'Section two argues X.' }, { type: 'done' }]);
    const launch = spawned!;
    expect(launch.binary).toBe('/canonical/pi');
    expect(launch.options.shell).toBe(false);
    expect(launch.options.cwd).toBe('/safe/empty-chat');
    // The spawn contract requires an explicit environment; it must be the minimal one.
    const { env } = launch.options;
    expect(env.PATH).toBe(buildCliSearchPath());
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(launch.args).toEqual(buildPiChatArgs({
      modelId: MODEL.id, models: [MODEL], systemPrompt: CHAT_REQUEST.systemPrompt,
    }));
    // The question travels on stdin, never as an argument.
    expect(launch.args.join('\0')).not.toContain(CHAT_REQUEST.userMessage);
  });

  it('sends the turn data on stdin without repeating the system prompt Pi already has in argv', async () => {
    const child = new FakeChild();
    let stdin = '';
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8'); });
    const provider = piProvider(fakePiExecFile(), { spawnProcess: scriptedSpawn(child, [textDelta('Answer.')]) });
    await provider.detect();

    await drain(provider, { ...CHAT_REQUEST, history: [{ role: 'user', content: 'Earlier question.' } as never] });

    // The Reader AI prompt is installed once, as `--system-prompt`; repeating
    // it in the turn data would send the same instructions twice.
    expect(stdin).not.toContain(CHAT_REQUEST.systemPrompt);
    // Everything the turn actually needs is still there.
    expect(stdin).toContain(CHAT_REQUEST.contextXml);
    expect(stdin).toContain(CHAT_REQUEST.userMessage);
    expect(stdin).toContain('Earlier question.');
  });

  it('terminates the turn on a tool event before its payload can be rendered', async () => {
    const cleanup = vi.fn(() => Promise.resolve());
    const terminate = vi.fn(() => Promise.resolve());
    const provider = piProvider(fakePiExecFile(), {
      prepareChatDirectory: () => Promise.resolve({ path: '/safe/empty-chat', cleanup }),
      terminateProcess: terminate,
      spawnProcess: scriptedSpawn(new FakeChild(), [
        { type: 'tool_execution_end', toolName: 'bash', result: 'root:x:0:0:/root' },
      ], false),
    });
    await provider.detect();

    const events: ProviderChatEvent[] = [];
    await expect((async () => {
      for await (const event of provider.streamChat(CHAT_REQUEST)) events.push(event);
    })()).rejects.toThrow(/unsupported tool operation/i);

    expect(events).toEqual([]);
    expect(terminate).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fails a clean exit that produced no readable assistant text', async () => {
    const provider = piProvider(fakePiExecFile(), {
      spawnProcess: scriptedSpawn(new FakeChild(), [{ type: 'turn_end', toolResults: [] }]),
    });
    await provider.detect();

    await expect(drain(provider, CHAT_REQUEST)).rejects.toThrow();
  });

  it('settles cancellation and cleans the workspace when the child never closes', async () => {
    const child = new NeverClosingChild();
    const cleanup = vi.fn(() => Promise.resolve());
    const provider = piProvider(fakePiExecFile(), {
      prepareChatDirectory: () => Promise.resolve({ path: '/safe/empty-chat', cleanup }),
      spawnProcess: () => childProcess(child),
      terminateProcess: () => Promise.resolve(),
      providerTimeoutMs: 10,
    });
    await provider.detect();

    const iterator = provider.streamChat(CHAT_REQUEST)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await provider.cancel(CHAT_REQUEST.requestId);

    await expect(pending).rejects.toThrow(/cancelled|closed|terminated|timed out/i);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('refuses the turn while no Pi model provider is signed in', async () => {
    const provider = piProvider(fakePiExecFile({
      listing: ANTHROPIC_ONLY_LISTING,
      verdicts: { anthropic: NOT_READY_JSON },
    }), {
      spawnProcess: () => { throw new Error('pi must not be spawned while signed out'); },
    });
    await provider.detect();

    await expect(drain(provider, { ...CHAT_REQUEST, modelId: null })).rejects.toThrow();
  });
});
