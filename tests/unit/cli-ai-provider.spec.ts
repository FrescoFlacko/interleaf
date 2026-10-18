import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  CliAIProvider,
  CliStreamParser,
  codexToolActivity,
  type CliAIProviderOptions,
  type CliExecFile,
  type CliProcessSpawner,
  type CliSpawnOptions,
  type CliProcessTerminator,
  createCliProviderDefinitions,
  parseCodexAuthStatus,
  parseCodexAuthStreams,
  resolveBinary,
  resolveWindowsTaskkillPath,
  resolveWindowsWherePath,
  splitToSafeChunks,
  terminateProcessTree,
  type CliArgsContext,
  type CliChildProcess,
  MAX_SCHEMA_CHUNK_UNITS,
} from '@main/ai/providers/cli-ai-provider';
import type { Logger } from '@main/logging/logger';
import { buildCliSearchPath } from '@main/app/cli-search-path';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
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

/**
 * Claude Code 2.1.267 refuses `--print` with `--output-format stream-json`
 * unless `--verbose` is present, exiting 1 before inference; Reader Chat then
 * fails with a generic provider error. `--verbose` is part of the contract, and
 * it must not have been traded for a wider tool surface.
 */
function expectHardenedClaudeArgs(args: readonly string[]): void {
  expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
  // `--tools ''` must stay an empty allowlist.
  expect(args[args.indexOf('--tools') + 1]).toBe('');
  expect(args).toEqual(expect.arrayContaining([
    '-p', '--verbose', '--include-partial-messages', '--safe-mode',
    '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence',
  ]));
  expect(args).not.toContain('--dangerously-skip-permissions');
}

/** The per-turn context the transport passes to a definition's `buildArgs`. */
function argsContext(overrides: Partial<CliArgsContext> = {}): CliArgsContext {
  return { models: [], systemPrompt: 'Reader AI prompt.', ...overrides };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const definitions = createCliProviderDefinitions();

function definition(id: string) {
  const found = definitions.find((item) => item.id === id);
  if (!found) throw new Error(`${id} definition missing.`);
  return found;
}

/** A CLI probe: `--version` prints `version`; the auth status prints `auth` on `stream`. */
function probe(auth = 'Logged in using ChatGPT', stream: 'stdout' | 'stderr' = 'stdout', version = 'codex-cli 0.149.1'): CliExecFile {
  const authOutput = stream === 'stdout' ? { stdout: auth, stderr: '' } : { stdout: '', stderr: auth };
  return vi.fn((_binary, args) => Promise.resolve(args[0] === '--version' ? { stdout: version, stderr: '' } : authOutput));
}

/** The Codex provider over a canonical binary and a connected auth probe unless overridden. */
function codexProvider(overrides: Partial<CliAIProviderOptions> = {}): CliAIProvider {
  return new CliAIProvider(definition('codex'), '/safe/chat-root', {
    execFile: probe(),
    resolveBinary: () => Promise.resolve('/canonical/codex'),
    logger: logger(),
    ...overrides,
  });
}

/** A terminator that kills the child with SIGTERM, which a `FakeChild` answers by closing. */
function killingTerminator(): CliProcessTerminator {
  return vi.fn((value) => { value.kill('SIGTERM'); return Promise.resolve(); });
}

function emptyChatDirectory(cleanup: () => Promise<void> = vi.fn(() => Promise.resolve())) {
  return () => Promise.resolve({ path: '/safe/empty-chat', cleanup });
}

function chatRequest(requestId: string) {
  return {
    requestId, modelId: null,
    systemPrompt: 'Use only the supplied reference data.', contextXml: '<document/>',
    history: [], userMessage: 'Hello', sources: [], webSearch: false,
  };
}

async function collectChat(provider: CliAIProvider, requestId: string) {
  const events = [];
  for await (const event of provider.streamChat(chatRequest(requestId))) events.push(event);
  return events;
}

/** Filesystem seam for `resolveBinary`: the resolver output is a file, a directory, or a symlink. */
function fakeFileSystem(kind: 'file' | 'directory' | 'symlink', target?: string) {
  return {
    lstat: vi.fn(() => Promise.resolve({ isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink' })),
    realpath: vi.fn((value: string) => Promise.resolve(target ?? value)),
    stat: vi.fn(() => Promise.resolve({ isFile: () => kind !== 'directory' })),
    access: vi.fn(() => Promise.resolve()),
  };
}

describe('CliAIProvider and definitions', () => {
  it('provides definitions for codex, claude, antigravity, cursor, pi, and omp with safe defaults', () => {
    const ids = definitions.map((d) => d.id);
    expect(ids).toEqual(['codex', 'claude', 'antigravity', 'cursor', 'pi', 'omp']);

    const codex = definition('codex');
    // The codex provider is the ChatGPT subscription binding; its user-facing
    // name must never leak the transport CLI's name.
    expect(codex.name).toBe('ChatGPT (subscription)');
    expect(codex.name).not.toContain('Codex');
    expect(codex.capabilities.toolFreeMode).toBe(false);
    expect(codex.capabilities.streaming).toBe(true);
    expect(codex.model.contextWindow).toBe(128_000);
    expect(codex.chatUnavailableReason).toContain('Sign in with ChatGPT');

    const claude = definition('claude');
    expect(claude.capabilities.toolFreeMode).toBe(true);
    expect(claude.model.contextWindow).toBe(200_000);

    const antigravity = definition('antigravity');
    expect(antigravity.capabilities.toolFreeMode).toBe(false);
    expect(antigravity.chatUnavailableReason).toContain('tool-free chat mode');

    // Cursor is registered for listing completeness only: Reader Chat is
    // permanently unavailable and no argv is ever built for it.
    const cursor = definition('cursor');
    expect(cursor.binary).toBe('cursor-agent');
    expect(cursor.capabilities.toolFreeMode).toBe(false);
    expect(cursor.chatAllowedWhenConnected).toBeUndefined();
    expect(cursor.chatUnavailableReason).toBe(
      'Cursor has no verified tool-free chat mode in Interleaf; it remains available for Agent Mode only.'
    );
    expect(cursor.buildArgs('cursor-default', '/tmp/chat-root', { models: [], systemPrompt: 'x' })).toEqual([]);

    const pi = definition('pi');
    expect(pi.binary).toBe('pi');
    expect(pi.name).toBe('Pi');
    expect(pi.capabilities.toolFreeMode).toBe(true);
    expect(pi.capabilities.hostedWebSearch).toBe(false);
    expect(pi.capabilities.streaming).toBe(true);
    // Pi answers Reader Chat only once its own probe reports a connected
    // model provider; until then the row carries the sign-in reason.
    expect(pi.chatAllowedWhenConnected).toBe(true);
    expect(pi.chatUnavailableReason).toContain('Sign in');
    expect(pi.discoverCatalog).toBeTypeOf('function');
  });

  it('accepts only the ChatGPT subscription auth status', () => {
    expect(parseCodexAuthStatus('Logged in using ChatGPT')).toBe('connected');
    expect(parseCodexAuthStatus('  LOGGED IN USING CHATGPT  ')).toBe('connected');
    expect(parseCodexAuthStatus('Not logged in')).toBe('disconnected');
    expect(parseCodexAuthStatus('Not logged in using ChatGPT')).toBe('unknown');
    expect(parseCodexAuthStatus('Logged in using an API key')).toBe('unknown');
    expect(parseCodexAuthStatus('prefix Logged in using ChatGPT')).toBe('unknown');
    expect(parseCodexAuthStatus('Logged in using ChatGPT suffix')).toBe('unknown');
    expect(parseCodexAuthStatus('Not logged in\nLogged in using ChatGPT')).toBe('unknown');
    expect(parseCodexAuthStatus('Logged in using ChatGPT\nmalicious status injection')).toBe('unknown');
    expect(parseCodexAuthStatus('diagnostic output without an auth result')).toBe('unknown');
  });

  it('accepts the ChatGPT status from either stream without trusting extra output', () => {
    // Codex 0.154 answers on stderr with an empty stdout.
    expect(parseCodexAuthStreams('', 'Logged in using ChatGPT\n')).toBe('connected');
    // Legacy stdout success and the disconnected statuses still classify.
    expect(parseCodexAuthStreams('Logged in using ChatGPT\n', '')).toBe('connected');
    expect(parseCodexAuthStreams('', 'Not logged in\n')).toBe('disconnected');
    expect(parseCodexAuthStreams('Not logged in\n', '')).toBe('disconnected');
    // Neither stream said anything, so nothing is known.
    expect(parseCodexAuthStreams('', '   \n')).toBe('unknown');
    // A diagnostic or conflicting stream can only downgrade the verdict.
    expect(parseCodexAuthStreams('warning: config ignored', 'Logged in using ChatGPT')).toBe('unknown');
    expect(parseCodexAuthStreams('Not logged in', 'Logged in using ChatGPT')).toBe('unknown');
    expect(parseCodexAuthStreams('Logged in using an API key', '')).toBe('unknown');
  });

  // Codex 0.154 reports its ChatGPT login on stderr; 0.149 used stdout.
  it.each([
    ['codex-cli 0.154.0', 'stderr', 'Logged in using ChatGPT\n'],
    ['codex-cli 0.149.1', 'stdout', 'Logged in using ChatGPT'],
  ] as const)('marks %s available for Reader Chat when it reports the login on %s', async (version, stream, auth) => {
    const log = logger();
    const provider = codexProvider({ execFile: probe(auth, stream, version), logger: log });

    await expect(provider.detect()).resolves.toMatchObject({ available: true, authentication: 'connected', errorMessage: null });
    // The probe's raw output never reaches diagnostics.
    const records = [log.debug, log.info, log.warn, log.error].flatMap((method) => vi.mocked(method).mock.calls);
    expect(JSON.stringify(records)).not.toContain('Logged in using ChatGPT');
  });

  it('offers the models the installed CLI lists after its default, and only those', async () => {
    for (const [id, binary] of [['codex', '/canonical/codex'], ['claude', '/canonical/claude']] as const) {
      const cli = definition(id);
      const ids = ['model-a', '--dangerous', cli.model.id, 'model-b'];
      const modelListing = vi.fn(() => Promise.resolve({ models: ids.map((id) => ({ id, reasoning: null })), defaultReasoning: null }));
      const provider = new CliAIProvider(cli, '/safe/chat-root', {
        execFile: probe('Logged in using ChatGPT', 'stdout', '1.0.0'),
        resolveBinary: () => Promise.resolve(binary),
        logger: logger(),
        modelListing,
      });
      const expected = [cli.model.id, 'model-a', 'model-b'];
      expect((await provider.detect()).models.map((model) => model.id)).toEqual(expected);
      expect((await provider.listModels()).map((model) => model.id)).toEqual(expected);
      expect(modelListing).toHaveBeenCalledWith(binary);
      const context: CliArgsContext = { models: await provider.listModels(), systemPrompt: 'prompt' };
      const args = cli.buildArgs('model-b', '/safe/chat-root', context);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'model-b']);
      expect(cli.buildArgs(cli.model.id, '/safe/chat-root', context)).not.toContain('--model');
    }
  });

  it('keeps only the default model when the CLI has no listing answer', async () => {
    const provider = new CliAIProvider(definition('claude'), '/safe/chat-root', {
      execFile: vi.fn(() => Promise.resolve({ stdout: '1.0.0', stderr: '' })),
      resolveBinary: () => Promise.resolve('/canonical/claude'),
      logger: logger(),
      modelListing: () => Promise.resolve(null),
    });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(['claude-default']);
  });

  it('runs ChatGPT login with fixed argv, shell:false, allowlisted env, closed stdin, and no diagnostics', async () => {
    const child = new FakeChild();
    const spawned: { binary: string; args: readonly string[]; options: CliSpawnOptions }[] = [];
    const spawnProcess: CliProcessSpawner = (binary, args, options) => {
      spawned.push({ binary, args, options });
      return childProcess(child);
    };
    const log = logger();
    const provider = codexProvider({ spawnProcess, logger: log });
    const login = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawned).toHaveLength(1); });
    expect(spawned[0]).toMatchObject({ binary: '/canonical/codex', args: ['login'] });
    expect(spawned[0]?.options.shell).toBe(false);
    expect(spawned[0]?.options.cwd).toBe('/safe/chat-root');
    expect(spawned[0]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawned[0]?.options.detached).toBe(process.platform !== 'win32');
    const environment = { ...spawned[0]?.options.env };
    expect(environment.PATH).toBe(buildCliSearchPath());
    expect(environment.INTERLEAF_TEST_SECRET).toBeUndefined();
    child.stdout.write('account-token=must-not-be-forwarded');
    child.stderr.write('secret=must-not-be-forwarded');
    child.close(0);
    const status = await login;
    expect(status.authentication).toBe('connected');
    expect(status.installed).toBe(true);
    expect(status).not.toHaveProperty('binaryPath');
    expect(child.stdin.read()).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent login requests and terminates on timeout without exposing output', async () => {
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(new FakeChild()));
    const terminateProcess = killingTerminator();
    const log = logger();
    const provider = codexProvider({ spawnProcess, terminateProcess, loginTimeoutMs: 10, logger: log });
    const first = provider.signInWithChatGPT();
    const second = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledTimes(1); });
    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(firstStatus.authentication).toBe('connected');
    expect(secondStatus.authentication).toBe('connected');
    expect(terminateProcess).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('ChatGPT sign-in process did not complete', { providerId: 'codex', reason: 'timeout' });
  });

  it('records only a safe diagnostic when the login process cannot be spawned', async () => {
    const log = logger();
    const provider = codexProvider({
      spawnProcess: () => { throw new Error('account-token=secret-value'); },
      logger: log,
    });
    const status = await provider.signInWithChatGPT();
    expect(status.authentication).toBe('connected');
    expect(log.warn).toHaveBeenCalledWith('ChatGPT sign-in process did not start', { providerId: 'codex', reason: 'spawn-failed' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-value');
  });

  it('terminates login when bounded diagnostic output is exceeded and logs only a safe reason', async () => {
    const child = new FakeChild();
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(child));
    const terminateProcess = killingTerminator();
    const log = logger();
    const provider = codexProvider({ spawnProcess, terminateProcess, loginTimeoutMs: 1_000, logger: log });
    const login = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledTimes(1); });
    child.stdout.write('x'.repeat(70_000));
    const status = await login;
    expect(status.authentication).toBe('connected');
    expect(terminateProcess).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('ChatGPT sign-in process did not complete', { providerId: 'codex', reason: 'output-limit' });
  });

  it('stops a delayed login before spawning when shutdown wins the resolve race', async () => {
    const resolver = deferred<string>();
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(new FakeChild()));
    const executeFile = probe();
    const provider = codexProvider({ spawnProcess, execFile: executeFile, resolveBinary: () => resolver.promise });
    const login = provider.signInWithChatGPT();
    const shutdown = provider.shutdown();
    resolver.resolve('/canonical/codex');
    const status = await login;
    await shutdown;
    expect(status.errorMessage).toBe('Application is shutting down.');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it('terminates an active login child during provider shutdown', async () => {
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(new FakeChild()));
    const terminateProcess = killingTerminator();
    const executeFile = probe();
    const provider = codexProvider({ spawnProcess, terminateProcess, execFile: executeFile });
    const login = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledTimes(1); });
    const shutdown = provider.shutdown();
    const [status] = await Promise.all([login, shutdown]);
    expect(status.errorMessage).toBe('Application is shutting down.');
    expect(terminateProcess).toHaveBeenCalledTimes(1);
    expect(executeFile).not.toHaveBeenCalled();
  });

  it('uses a bounded canonical Windows taskkill helper and falls back to direct child kill', async () => {
    const target = new FakeChild();
    const killer = new FakeChild();
    const calls: { binary: string; args: readonly string[]; options: CliSpawnOptions }[] = [];
    const spawnProcess: CliProcessSpawner = (binary, args, options) => {
      calls.push({ binary, args, options });
      queueMicrotask(() => { killer.close(1); });
      return childProcess(killer);
    };
    await terminateProcessTree(childProcess(target), {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      spawnProcess,
      taskkillTimeoutMs: 10,
      gracePeriodMs: 1,
    });
    expect(calls[0]?.binary).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(calls[0]?.args).toEqual(['/PID', '4321', '/T', '/F']);
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.options.env.INTERLEAF_TEST_SECRET).toBeUndefined();
    expect(target.killSignals).toContain('SIGTERM');
    expect(resolveWindowsTaskkillPath('relative\\Windows')).toBeNull();
    expect(resolveWindowsTaskkillPath('C:\\Windows\\..\\Users')).toBeNull();
    expect(resolveWindowsTaskkillPath('\\\\server\\share\\Windows')).toBeNull();
  });

  it('resolves Windows where.exe from System32 and validates canonical executable output', async () => {
    const executeFile: CliExecFile = vi.fn(() => Promise.resolve({ stdout: 'C:\\Program Files\\Codex\\codex.exe\r\n', stderr: '' }));
    const fileSystem = fakeFileSystem('file');
    const resolved = await resolveBinary('codex', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      execFile: executeFile,
      fileSystem,
    });
    expect(resolveWindowsWherePath('C:\\Windows')).toBe('C:\\Windows\\System32\\where.exe');
    expect(executeFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\where.exe',
      ['codex'],
      expect.objectContaining({ shell: false, maxBuffer: 64 * 1024, windowsHide: true }),
    );
    expect(resolved).toBe('C:\\Program Files\\Codex\\codex.exe');
    expect(fileSystem.lstat).toHaveBeenCalledWith(resolved);
    expect(fileSystem.access).toHaveBeenCalledWith(resolved, expect.any(Number));
  });

  it('rejects relative, non-file, and non-canonical resolver output while allowing verified symlinks', async () => {
    const resolveOnDarwin = (stdout: string, fileSystem: ReturnType<typeof fakeFileSystem>) => resolveBinary('codex', {
      platform: 'darwin',
      execFile: () => Promise.resolve({ stdout, stderr: '' }),
      fileSystem,
    });

    const relativeFileSystem = fakeFileSystem('file');
    await expect(resolveOnDarwin('./codex\n', relativeFileSystem)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(relativeFileSystem.lstat).not.toHaveBeenCalled();

    const nonFileSystem = fakeFileSystem('directory');
    await expect(resolveOnDarwin('/tmp/codex-directory\n', nonFileSystem)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(nonFileSystem.realpath).not.toHaveBeenCalled();

    await expect(resolveOnDarwin('/opt/codex/current\n', fakeFileSystem('symlink', '/opt/codex/releases/current/codex')))
      .resolves.toBe('/opt/codex/releases/current/codex');
  });

  it('kills a hung Windows helper within its deadline before direct fallback', async () => {
    const target = new FakeChild();
    const killer = new FakeChild();
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(killer));
    await terminateProcessTree(childProcess(target), {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      spawnProcess,
      taskkillTimeoutMs: 5,
      gracePeriodMs: 1,
    });
    expect(killer.killSignals).toContain('SIGKILL');
    expect(target.killSignals).toContain('SIGTERM');
  });

  it('falls back when direct child kill reports false', async () => {
    const child = new NeverClosingChild();
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
      expect(pid).toBe(4321);
      if (signal === 'SIGTERM') child.close(0);
    });
    await terminateProcessTree(childProcess(child), {
      platform: 'win32',
      systemRoot: '',
      killProcess,
      gracePeriodMs: 1,
    });
    expect(killProcess).toHaveBeenCalledWith(4321, 'SIGTERM');
  });

  it('settles login and shutdown when the child never closes after a failed kill', async () => {
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(new NeverClosingChild()));
    const terminateProcess: CliProcessTerminator = vi.fn(() => Promise.resolve());
    const provider = codexProvider({ spawnProcess, terminateProcess, loginTimeoutMs: 5 });
    const login = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
    const status = await login;
    expect(status.authentication).toBe('connected');
    const second = provider.signInWithChatGPT();
    const third = provider.signInWithChatGPT();
    await expect(second).rejects.toMatchObject({
      code: 'internal',
      message: 'A previous ChatGPT sign-in is still stopping.',
    });
    await expect(third).rejects.toMatchObject({
      code: 'internal',
      message: 'A previous ChatGPT sign-in is still stopping.',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    await provider.shutdown();
    expect(terminateProcess).toHaveBeenCalledTimes(4);
  });

  it('settles a pending login when shutdown requests bounded cancellation', async () => {
    const spawnProcess: CliProcessSpawner = vi.fn(() => childProcess(new NeverClosingChild()));
    const terminateProcess: CliProcessTerminator = vi.fn(() => Promise.resolve());
    const provider = codexProvider({ spawnProcess, terminateProcess, loginTimeoutMs: 60_000 });
    const login = provider.signInWithChatGPT();
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalledOnce(); });
    const shutdown = provider.shutdown();
    const [status] = await Promise.all([login, shutdown]);
    expect(status.errorMessage).toBe('Application is shutting down.');
    expect(terminateProcess).toHaveBeenCalledTimes(3);
  });

  it('maps auth probe failures to unknown and records only redacted diagnostics', async () => {
    let calls = 0;
    const log = logger();
    const executeFile: CliExecFile = vi.fn((_binary, args) => {
      calls += 1;
      if (args[0] === '--version') return Promise.resolve({ stdout: 'codex-cli 0.149.1', stderr: '' });
      return Promise.reject(new Error('account-token=secret-value'));
    });
    const provider = codexProvider({ execFile: executeFile, logger: log });
    const status = await provider.detect();
    expect(calls).toBe(2);
    expect(status.authentication).toBe('unknown');
    expect(log.warn).toHaveBeenCalledWith('Codex auth status probe failed', { providerId: 'codex', reason: 'probe-failed' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-value');
  });

  it('builds tokenized Codex arguments with security flags', () => {
    expect(definition('codex').buildArgs(null, '/safe/empty', argsContext())).toEqual([
      'exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--cd', '/safe/empty',
    ]);
  });

  // Claude Code 2.1.267 refuses `--print` + `--output-format stream-json`
  // without `--verbose` and exits 1 before inference, so Reader Chat fails
  // with a generic provider error. Regression for that exact argv defect.
  it('pairs Claude stream-json with --verbose while keeping every hardening flag', () => {
    const claude = definition('claude');

    expectHardenedClaudeArgs(claude.buildArgs(null, '/tmp/chat', argsContext()));
    const argsModel = claude.buildArgs('claude-3-5-haiku', '/tmp/chat', argsContext());
    expectHardenedClaudeArgs(argsModel);
    expect(argsModel).toContain('--model');
    expect(argsModel).toContain('claude-3-5-haiku');
  });

  it('spawns Claude with --verbose on the real streaming boundary', async () => {
    const child = new FakeChild();
    let spawnedArgs: readonly string[] = [];
    const provider = new CliAIProvider(definition('claude'), '/safe/chat-root', {
      spawnProcess: (binary, args, options) => {
        spawnedArgs = args;
        expect(binary).toBe('/canonical/claude');
        expect(options.shell).toBe(false);
        expect(options.cwd).toBe('/safe/empty-chat');
        setImmediate(() => {
          child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}\n');
          child.stdout.end();
          child.close(0);
        });
        return childProcess(child);
      },
      resolveBinary: () => Promise.resolve('/canonical/claude'),
      prepareChatDirectory: emptyChatDirectory(),
      logger: logger(),
    });
    expect(await collectChat(provider, 'claude-stream')).toEqual([{ type: 'token', token: 'Hi' }, { type: 'done' }]);
    expect(spawnedArgs).toContain('--verbose');
    expect(spawnedArgs[spawnedArgs.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(spawnedArgs).toContain('--safe-mode');
  });

  it('streams Codex JSON through a canonical binary in an app-owned empty workspace', async () => {
    const child = new FakeChild();
    const spawnProcess: CliProcessSpawner = (binary, args, options) => {
      expect(binary).toBe('/canonical/codex');
      expect(args).toContain('--sandbox');
      expect(args).toContain('read-only');
      expect(args).toContain('-c');
      expect(args).toContain('approval_policy="never"');
      expect(options.cwd).toBe('/safe/empty-chat');
      expect(options.shell).toBe(false);
      expect(options.env.PATH).toBe(buildCliSearchPath());
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      setImmediate(() => {
        child.stdout.write('{"type":"item.delta","delta":{"text":"Hello from ChatGPT"}}\n');
        child.stdout.end();
        child.close(0);
      });
      return childProcess(child);
    };
    const provider = codexProvider({ spawnProcess, prepareChatDirectory: emptyChatDirectory() });
    expect(await collectChat(provider, 'codex-stream')).toEqual([{ type: 'token', token: 'Hello from ChatGPT' }, { type: 'done' }]);
  });

  it('keeps the system prompt at the head of stdin for CLIs that receive it no other way', async () => {
    for (const id of ['codex', 'claude'] as const) {
      const child = new FakeChild();
      let stdin = '';
      child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8'); });
      const provider = new CliAIProvider(definition(id), '/safe/chat-root', {
        spawnProcess: () => {
          setImmediate(() => { child.stdout.end(); child.close(0); });
          return childProcess(child);
        },
        resolveBinary: () => Promise.resolve(`/canonical/${id}`),
        prepareChatDirectory: emptyChatDirectory(),
        logger: logger(),
      });

      await expect(collectChat(provider, `${id}-prompt`)).rejects.toThrow();

      // Neither CLI takes a system-prompt argument here, so stdin remains the
      // only place the Reader AI prompt is delivered.
      expect(stdin.startsWith('Use only the supplied reference data.\n\n<document/>')).toBe(true);
      expect(stdin).toContain('Hello');
    }
  });

  it('settles cancellation and timeout when the child never closes', async () => {
    const child = new NeverClosingChild();
    const cleanup = vi.fn(() => Promise.resolve());
    const provider = codexProvider({
      spawnProcess: () => childProcess(child),
      prepareChatDirectory: emptyChatDirectory(cleanup),
      terminateProcess: () => Promise.resolve(), providerTimeoutMs: 10,
    });
    const iterator = provider.streamChat(chatRequest('never-close'))[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await provider.cancel('never-close');
    await expect(pending).rejects.toThrow(/cancelled|closed|terminated/i);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('parses Claude stream-json deltas without duplicating assistant or result payloads', () => {
    const parser = new CliStreamParser('claude');

    const line1 =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}';
    const line2 =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}}';
    const line3 =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world!"}]}}';
    const line4 = '{"type":"result","result":"Hello world!"}';

    expect(parser.parseLine(line1)).toEqual(['Hello ']);
    expect(parser.parseLine(line2)).toEqual(['world!']);
    expect(parser.parseLine(line3)).toEqual([]); // Must be skipped to avoid duplication
    expect(parser.parseLine(line4)).toEqual([]); // Must be skipped to avoid duplication
    expect(parser.finish()).toEqual([]);
  });

  it('falls back to aggregate assistant message when no stream deltas are received', () => {
    const parser = new CliStreamParser('claude');

    const line1 =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Complete fallback text."}]}}';
    expect(parser.parseLine(line1)).toEqual([]);
    expect(parser.finish()).toEqual(['Complete fallback text.']);
  });

  it('handles Codex agent_message and item.delta formats without duplication', () => {
    const parser = new CliStreamParser('codex');

    const line1 = '{"type":"item.delta","delta":{"text":"Codex chunk 1 "}}';
    const line2 = '{"type":"response.text.delta","delta":{"text":"chunk 2"}}';
    const line3 = '{"item":{"type":"agent_message","text":"Codex chunk 1 chunk 2"}}';
    const line4 = '{"type":"result","result":"Codex chunk 1 chunk 2"}';

    expect(parser.parseLine(line1)).toEqual(['Codex chunk 1 ']);
    expect(parser.parseLine(line2)).toEqual(['chunk 2']);
    expect(parser.parseLine(line3)).toEqual([]); // Must be skipped to avoid duplication
    expect(parser.parseLine(line4)).toEqual([]); // Must be skipped to avoid duplication
    expect(parser.finish()).toEqual([]);
  });

  it('rejects every non-passive Codex item event before rendering its payload', () => {
    expect(codexToolActivity('{"item":{"type":"command_execution","command":"cat secret"}}')).toBe(true);
    expect(codexToolActivity('{"item":{"type":"web_search","query":"secret"}}')).toBe(true);
    expect(codexToolActivity('{"item":{"type":"future_tool_event"}}')).toBe(true);
    expect(codexToolActivity('{"item":{"type":"agent_message","text":"safe"}}')).toBe(false);
    expect(codexToolActivity('{"type":"item.delta","delta":{"text":"safe"}}')).toBe(false);
  });

  it('ignores malformed JSON and diagnostic lines in structured output mode', () => {
    const parser = new CliStreamParser('claude');

    expect(parser.parseLine('')).toEqual([]);
    expect(parser.parseLine('   ')).toEqual([]);
    expect(parser.parseLine('[Diagnostic] Loading MCP tools...')).toEqual([]);
    expect(parser.parseLine('Error: ECONNRESET')).toEqual([]);
    expect(parser.parseLine('{"broken json')).toEqual([]);
    expect(parser.parseLine('{"type":"unknown_event_type"}')).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it('splits large output tokens into schema-safe chunks without truncating', () => {
    const hugeToken = 'X'.repeat(70_000);
    const chunks = splitToSafeChunks(hugeToken);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(MAX_SCHEMA_CHUNK_UNITS);
    expect(chunks[1]?.length).toBe(70_000 - MAX_SCHEMA_CHUNK_UNITS);
    expect(chunks.join('')).toBe(hugeToken);

    // Exact boundary
    const exactBoundary = 'Y'.repeat(MAX_SCHEMA_CHUNK_UNITS);
    expect(splitToSafeChunks(exactBoundary)).toEqual([exactBoundary]);

    const overOne = 'Z'.repeat(MAX_SCHEMA_CHUNK_UNITS + 1);
    const overChunks = splitToSafeChunks(overOne);
    expect(overChunks.length).toBe(2);
    expect(overChunks[0]?.length).toBe(MAX_SCHEMA_CHUNK_UNITS);
    expect(overChunks[1]?.length).toBe(1);
    expect(overChunks.join('')).toBe(overOne);
  });
});
