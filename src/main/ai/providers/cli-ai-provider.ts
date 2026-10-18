import { errorHasCode } from '@shared/models/caught-error';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, posix, win32 } from 'node:path';
import type { AIModelInfo, AIProviderCapabilities, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import { AI_PROVIDER_DISPLAY_NAMES } from '@shared/constants/ai';
import { type ChatModelListing, listedChatModels, mergeListedReasoning } from '../chat-model-listing';
import { cliReasoningArgs } from './cli-reasoning-args';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { AIProvider, ProviderChatEvent, ProviderChatRequest } from './types';
import type { Logger } from '../../logging/logger';
import { execFileBounded, spawnPiped } from '../../agents/process-runner';
import { relativePathWithin } from '../../security/path-guard';
import {
  buildAllowlistedEnvironment,
  CLI_DIAGNOSTIC_MAX_BYTES,
  splitToSafeChunks,
} from './cli-runtime';
import {
  buildPiChatArgs,
  createPiCatalogProbe,
  piToolActivity,
  PiStreamParser,
  type PiCatalog,
} from './pi-cli';
import {
  buildOmpChatArgs,
  createOmpCatalogProbe,
  OmpStreamParser,
} from './omp-cli';
import { agentJsonToolActivity } from './agent-json-stream';
import { detectClaudeAuth, detectCodexAuth } from './cli-auth-probes';
import type { BinaryResolutionFs, CliChildProcess, CliExecFile, CliProcessSpawner, CliProcessTerminator } from './cli-process-types';
import { type PortableRecord, type PortableValue, parsePortableJson } from '@shared/models/portable';

export { MAX_SCHEMA_CHUNK_UNITS, splitToSafeChunks } from './cli-runtime';
export { parseCodexAuthStatus, parseCodexAuthStreams } from './cli-auth-probes';
export type { CliChildProcess, CliExecFile, CliProcessSpawner, CliProcessTerminator, CliSpawnOptions } from './cli-process-types';

const MAX_PROVIDER_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_STDERR_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 5 * 60 * 1_000;
const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const LOGIN_SHUTDOWN_WAIT_MS = 1_500;
const TASKKILL_TIMEOUT_MS = 2_000;
const PROCESS_TREE_GRACE_MS = 750;
const TERMINATOR_CALL_TIMEOUT_MS = TASKKILL_TIMEOUT_MS + PROCESS_TREE_GRACE_MS + 500;
const TERMINATION_RETRY_COUNT = 2;

const defaultBinaryResolutionFs: BinaryResolutionFs = { access, lstat, realpath, stat };

export type CliAIProviderOptions = {
  /** Main-owned seams for boundary tests; renderer input never reaches these. */
  readonly spawnProcess?: CliProcessSpawner;
  readonly terminateProcess?: CliProcessTerminator;
  readonly execFile?: CliExecFile;
  readonly resolveBinary?: (binary: string) => Promise<string>;
  readonly loginTimeoutMs?: number;
  readonly providerTimeoutMs?: number;
  readonly logger: Logger;
  readonly prepareChatDirectory?: (base: string) => Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }>;
  /**
   * Models and per-model reasoning levels the installed CLI itself reports,
   * from the main-owned bounded listing (`../chat-model-listing.ts`). A CLI
   * whose listing fails keeps its default model with no reasoning control.
   */
  readonly modelListing?: (binaryPath: string) => Promise<ChatModelListing | null>;
};

const defaultSpawnProcess: CliProcessSpawner = spawnPiped;
async function createPrivateChatDirectory(base: string): Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(base, 'reader-chat-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
const defaultExecFile: CliExecFile = execFileBounded;

/** What a CLI adapter may consult while composing one turn's argv. */
export type CliArgsContext = {
  /** Models this provider currently exposes; the first is its default. */
  readonly models: readonly AIModelInfo[];
  /** The app-owned Reader AI system prompt selected for this turn. */
  readonly systemPrompt: string;
};

export type CliDefinition = {
  readonly id: Exclude<AIProviderId, 'fake' | 'openrouter'>;
  readonly name: string;
  readonly binary: string;
  readonly model: AIModelInfo;
  readonly capabilities: AIProviderCapabilities;
  readonly buildArgs: (modelId: string | null, chatRoot: string, context: CliArgsContext) => readonly string[];
  readonly detectAuth: (binary: string, executeFile: CliExecFile, log: Logger) => Promise<AIProviderStatus['authentication']>;
  readonly chatUnavailableReason?: string;
  /**
   * The CLI answers Reader Chat once, and only once, its own authentication
   * probe reports a connected subscription; `chatUnavailableReason` explains
   * the state until then.
   */
  readonly chatAllowedWhenConnected?: boolean;
  /**
   * Runtime discovery of this CLI's authentication and model catalog, for CLIs
   * that publish more than one account-dependent model. It replaces
   * `detectAuth` and the single fallback model.
   */
  readonly discoverCatalog?: (binary: string, executeFile: CliExecFile, cwd: string, log: Logger) => Promise<PiCatalog>;
  /** Classifies a structured output line as a tool-use invariant violation. */
  readonly toolActivity?: (line: string) => boolean;
  /** User-safe message for a rejected tool event. */
  readonly toolViolationMessage?: string;
  /** Per-CLI structured output parser; defaults to {@link CliStreamParser}. */
  readonly createParser?: () => CliStreamLineParser;
  /**
   * This CLI installs the Reader AI system prompt itself, as an argv flag, so
   * the shared stdin body omits it. Every other CLI keeps the system prompt at
   * the head of its stdin body, which is the only place those CLIs receive it.
   */
  readonly systemPromptInArgv?: boolean;
};

/** The streaming contract every per-CLI parser satisfies. */
type CliStreamLineParser = {
  parseLine(line: string): readonly string[];
  finish(): readonly string[];
};

export class CliAIProvider implements AIProvider {
  readonly id: CliDefinition['id'];
  readonly name: string;
  readonly capabilities: AIProviderCapabilities;
  private readonly requests = new Map<string, { cancelled: boolean; child: CliChildProcess | null; abort: () => void; abortPromise: Promise<void> }>();
  private chatGptLogin: Promise<AIProviderStatus> | null = null;
  /** Last runtime-discovered catalog, for CLIs that publish one. */
  private discoveredModels: readonly AIModelInfo[] | null = null;
  private loginChild: CliChildProcess | null = null;
  private loginTermination: (() => void) | null = null;
  private isShuttingDown = false;
  private readonly spawnProcess: CliProcessSpawner;
  private readonly terminateProcess: CliProcessTerminator;
  private readonly executeFile: CliExecFile;
  private readonly resolveBinaryPath: (binary: string) => Promise<string>;
  private readonly loginTimeoutMs: number;
  private readonly providerTimeoutMs: number;
  private readonly log: Logger;
  private readonly prepareChatDirectory: NonNullable<CliAIProviderOptions['prepareChatDirectory']>;
  private readonly modelListing: CliAIProviderOptions['modelListing'];

  constructor(
    private readonly definition: CliDefinition,
    private readonly chatRoot: string,
    options: CliAIProviderOptions,
  ) {
    this.id = definition.id;
    this.name = definition.name;
    this.capabilities = definition.capabilities;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.terminateProcess = options.terminateProcess ?? terminateProcessTree;
    this.executeFile = options.execFile ?? defaultExecFile;
    this.resolveBinaryPath = options.resolveBinary ?? resolveBinary;
    this.loginTimeoutMs = options.loginTimeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
    this.providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
    this.log = options.logger;
    this.prepareChatDirectory = options.prepareChatDirectory ?? createPrivateChatDirectory;
    this.modelListing = options.modelListing;
  }

  async detect(): Promise<AIProviderStatus> {
    if (this.hasShutdownStarted()) return this.shutdownStatus();
    try {
      // Resolve once, then use the canonical binary for every subprocess.
      // Never allow a provider probe to inherit the main process environment.
      const binaryPath = await this.resolveBinaryPath(this.definition.binary);
      const versionResult = await this.executeFile(binaryPath, ['--version'], {
        timeout: 5_000,
        maxBuffer: CLI_DIAGNOSTIC_MAX_BYTES,
        encoding: 'utf8',
        shell: false,
        env: buildAllowlistedEnvironment(),
        windowsHide: true,
      });
      const catalog = await this.probeCatalog(binaryPath);
      const unavailableReason = this.definition.chatUnavailableReason ?? null;
      const chatAllowed = this.definition.chatAllowedWhenConnected === true && catalog.authentication === 'connected';
      return {
        id: this.id,
        name: this.name,
        available: unavailableReason === null || chatAllowed,
        installed: true,
        authentication: catalog.authentication,
        version: versionResult.stdout.trim().slice(0, 256),
        errorMessage: chatAllowed ? null : unavailableReason,
        models: [...catalog.models],
        capabilities: this.capabilities,
      };
    } catch (error) {
      const missing = errorHasCode(error instanceof Error ? error : null, 'ENOENT');
      this.log.warn('AI provider capability probe did not complete', {
        providerId: this.id,
        reason: missing ? 'not-installed' : 'probe-failed',
      });
      return {
        id: this.id,
        name: this.name,
        available: false,
        installed: !missing,
        authentication: missing ? 'disconnected' : 'error',
        version: null,
        errorMessage: missing ? 'CLI is not installed.' : 'CLI capability detection failed.',
        models: [...(this.discoveredModels ?? [this.definition.model])],
        capabilities: this.capabilities,
      };
    }
  }

  /**
   * The provider's own authentication and model catalog. A CLI with runtime
   * discovery answers from its bounded probes; every other CLI keeps its
   * single sentinel model and its status-command verdict.
   */
  private async probeCatalog(binaryPath: string): Promise<PiCatalog> {
    const discoverCatalog = this.definition.discoverCatalog;
    if (discoverCatalog !== undefined) {
      const catalog = await discoverCatalog(binaryPath, this.executeFile, this.chatRoot, this.log);
      const models = mergeListedReasoning(catalog.models, (await this.modelListing?.(binaryPath)) ?? null);
      this.discoveredModels = models;
      return { authentication: catalog.authentication, models };
    }
    const authentication = await this.definition.detectAuth(binaryPath, this.executeFile, this.log);
    if (this.modelListing === undefined) return { authentication, models: [this.definition.model] };
    const models = listedChatModels(this.definition.model, await this.modelListing(binaryPath));
    this.discoveredModels = models;
    return { authentication, models };
  }

  async listModels(): Promise<readonly AIModelInfo[]> {
    if (this.definition.discoverCatalog === undefined && this.modelListing === undefined) return [this.definition.model];
    // A discovered catalog is account-dependent, so the first read establishes
    // it rather than reporting a model the CLI may not be able to run.
    this.discoveredModels ??= (await this.detect()).models;
    return this.discoveredModels;
  }

  async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderChatEvent> {
    if (this.definition.chatUnavailableReason && this.definition.chatAllowedWhenConnected !== true) {
      throw new InterleafError('validation', this.definition.chatUnavailableReason);
    }
    const prompt = buildCliPrompt(request, this.definition.systemPromptInArgv !== true);
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => { resolveAbort = resolve; });
    const state = { cancelled: false, child: null as CliChildProcess | null, abort: resolveAbort, abortPromise };
    this.requests.set(request.requestId, state);
    // Read through a call, not the field: cancellation is set by concurrent
    // IPC and by this function's own timers, so the compiler's narrowing of a
    // plain field read would be wrong at every later check.
    const isCancelled = (): boolean => state.cancelled;
    let workspace: { readonly path: string; readonly cleanup: () => Promise<void> };
    try { workspace = await this.prepareChatDirectory(this.chatRoot); }
    catch {
      this.requests.delete(request.requestId);
      throw new InterleafError('internal', `${this.name} chat workspace is unavailable.`);
    }
    if (state.cancelled || this.hasShutdownStarted()) {
      state.cancelled = true; state.abort();
      await workspace.cleanup().catch(() => undefined);
      this.requests.delete(request.requestId);
      throw new InterleafError('validation', 'AI response was cancelled.');
    }
    let child: CliChildProcess | null = null;
    try {
      const binaryPath = await this.resolveBinaryPath(this.definition.binary);
      if (isCancelled() || this.hasShutdownStarted()) {
        throw new InterleafError('validation', 'AI response was cancelled.');
      }
      const models = [...(this.discoveredModels ?? [this.definition.model])];
      const args = [
        ...this.definition.buildArgs(request.modelId, workspace.path, { models, systemPrompt: request.systemPrompt }),
        ...cliReasoningArgs(this.id, request.modelId, models, request.reasoningEffort),
      ];
      child = this.spawnProcess(binaryPath, args, {
      cwd: workspace.path,
      shell: false,
      detached: process.platform !== 'win32',
      env: buildAllowlistedEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      await workspace.cleanup().catch(() => undefined);
      this.requests.delete(request.requestId);
      this.log.warn('AI provider chat process could not start', { providerId: this.id, reason: 'spawn-failed' });
      if (error instanceof InterleafError) throw error;
      throw new InterleafError('internal', `${this.name} could not start its process.`);
    }
    state.child = child;
    if (isCancelled() || this.hasShutdownStarted()) {
      state.abort();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await workspace.cleanup().catch(() => undefined);
      this.requests.delete(request.requestId);
      await terminateWithDeadline(this.terminateProcess, child);
      throw new InterleafError('validation', 'AI response was cancelled.');
    }
    // Create exit promise immediately so early process exit or error cannot be missed
    const exitPromise = waitForExit(child);

    let stderr = '';
    let outputBytes = 0;
    let emittedText = false;
    let rawOutputBytes = 0;
    let rawOutputExceeded = false;
    // Set by the stdout data callback below, for the same reason as isCancelled.
    const outputExceeded = (): boolean => rawOutputExceeded;
    child.stdout.on('data', (chunk: Buffer | string) => {
      rawOutputBytes += Buffer.byteLength(chunk);
      if (rawOutputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
        rawOutputExceeded = true;
        state.cancelled = true;
        state.abort();
        child.stdout.destroy();
      }
    });
    const timer = setTimeout(() => {
      state.cancelled = true; state.abort();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      void terminateWithDeadline(this.terminateProcess, child);
    }, this.providerTimeoutMs);
    timer.unref();
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_PROVIDER_STDERR_BYTES) stderr += chunk.slice(0, MAX_PROVIDER_STDERR_BYTES - stderr.length);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const parser: CliStreamLineParser = this.definition.createParser?.() ?? new CliStreamParser(this.id);
    try {
      child.stdin.end(prompt, 'utf8');
      const lineIterator = lines[Symbol.asyncIterator]();
      const shouldRead = (): boolean => true;
      while (shouldRead()) {
        const next = await Promise.race([
          lineIterator.next(),
          state.abortPromise.then(() => ({ done: true as const, value: undefined })),
        ]);
        if (next.done) break;
        const line = next.value;
        if (outputExceeded()) {
          await terminateWithDeadline(this.terminateProcess, child);
          throw new InterleafError('validation', 'AI provider output exceeded the safe limit.');
        }
        outputBytes += Buffer.byteLength(line, 'utf8');
        if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
          await terminateWithDeadline(this.terminateProcess, child);
          throw new InterleafError('validation', 'AI provider output exceeded the safe limit.');
        }
        if (this.definition.toolActivity?.(line) === true) {
          await terminateWithDeadline(this.terminateProcess, child);
          throw new InterleafError(
            'validation',
            this.definition.toolViolationMessage ?? `${this.name} attempted an unsupported tool operation.`,
          );
        }
        const tokens = parser.parseLine(line);
        for (const token of tokens) {
          if (token.length > 0) {
            emittedText = true;
            yield { type: 'token', token };
          }
        }
      }
      if (isCancelled()) throw new InterleafError('validation', 'AI response was cancelled.');
      const trailing = parser.finish();
      for (const token of trailing) {
        if (token.length > 0) {
          emittedText = true;
          yield { type: 'token', token };
        }
      }
      const exit = await Promise.race([exitPromise, state.abortPromise.then(() => ({ code: null, signal: null, error: null, timedOut: true }))]);
      if ('timedOut' in exit && exit.timedOut) throw new InterleafError('validation', 'AI response was cancelled or timed out.');
      if (exit.error !== null) {
        throw new InterleafError('internal', `${this.name} could not start or maintain its process.`);
      }
      if (exit.code !== 0) {
        throw new InterleafError(
          'internal',
          stderr.trim().length > 0
            ? `${this.name} exited without completing the response.`
            : `${this.name} exited with status ${String(exit.code)}.`
        );
      }
      if (!emittedText) {
        throw new InterleafError('internal', `${this.name} returned no readable response text.`);
      }
      yield { type: 'done' };
    } finally {
      clearTimeout(timer);
      if (isProcessRunning(child)) {
        await terminateWithDeadline(this.terminateProcess, child);
      }
      lines.close();
      this.requests.delete(request.requestId);
      await workspace.cleanup().catch(() => {
        this.log.warn('AI provider chat workspace cleanup did not complete', { providerId: this.id, reason: 'cleanup-failed' });
      });
    }
  }

  async cancel(requestId: string): Promise<void> {
    const state = this.requests.get(requestId);
    if (!state) return;
    state.cancelled = true;
    state.abort();
    const child = state.child;
    if (child) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await terminateWithDeadline(this.terminateProcess, child);
    }
  }

  /**
   * Launch the provider-owned browser login flow from the main process. The
   * renderer never receives a credential or controls argv/cwd/env. This is
   * deliberately limited to the Codex ChatGPT subscription provider; the
   * Reader Chat uses a constrained read-only invocation and remains gated on
   * this authenticated status; the renderer never receives credentials.
   */
  async signInWithChatGPT(): Promise<AIProviderStatus> {
    if (this.id !== 'codex') {
      throw new InterleafError('validation', 'ChatGPT sign-in is available only for Codex.');
    }
    if (this.isShuttingDown) {
      throw new InterleafError('internal', 'Application is shutting down.');
    }
    if (this.chatGptLogin !== null) return this.chatGptLogin;
    // Assign the deduplication promise before awaiting stale-child cleanup so
    // concurrent IPC calls cannot both pass the guard and spawn replacements.
    const operation = this.performChatGptLoginWithLiveGuard();
    this.chatGptLogin = operation;
    try {
      return await operation;
    } finally {
      if (this.chatGptLogin === operation) this.chatGptLogin = null;
    }
  }

  private async performChatGptLoginWithLiveGuard(): Promise<AIProviderStatus> {
    const liveLogin = this.loginChild;
    if (liveLogin !== null && isProcessRunning(liveLogin)) {
      await terminateWithDeadline(this.terminateProcess, liveLogin);
      if (isProcessRunning(liveLogin)) {
        this.log.warn('ChatGPT sign-in process is still stopping', {
          providerId: this.id,
          reason: 'previous-process-alive',
        });
        throw new InterleafError('internal', 'A previous ChatGPT sign-in is still stopping.');
      }
    }
    return this.performChatGptLogin();
  }

  private async performChatGptLogin(): Promise<AIProviderStatus> {
    let binaryPath: string;
    try {
      binaryPath = await this.resolveBinaryPath(this.definition.binary);
    } catch {
      return this.isShuttingDown ? this.shutdownStatus() : this.detect();
    }
    if (this.isShuttingDown) return this.shutdownStatus();
    let child: CliChildProcess;
    try {
      child = this.spawnProcess(binaryPath, ['login'], {
        cwd: this.chatRoot,
        env: buildAllowlistedEnvironment(),
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      this.log.warn('ChatGPT sign-in process did not start', {
        providerId: this.id,
        reason: 'spawn-failed',
      });
      return this.detect();
    }
    this.loginChild = child;
    const clearLoginChild = (): void => {
      if (this.loginChild === child) this.loginChild = null;
    };
    child.once('close', clearLoginChild);
    const exitPromise = waitForExit(child);
    let outputBytes = 0;
    let resolveTermination!: () => void;
    const terminationRequested = new Promise<void>((resolve) => { resolveTermination = resolve; });
    const loginState: {
      terminationReason: 'output-limit' | 'timeout' | 'shutdown' | null;
      terminationOperation: Promise<void> | undefined;
    } = { terminationReason: null, terminationOperation: undefined };
    const requestTermination = (reason: 'output-limit' | 'timeout' | 'shutdown'): void => {
      if (loginState.terminationReason !== null) return;
      loginState.terminationReason = reason;
      resolveTermination();
      loginState.terminationOperation = terminateWithDeadline(this.terminateProcess, child);
    };
    const requestShutdownTermination = (): void => { requestTermination('shutdown'); };
    this.loginTermination = requestShutdownTermination;
    const countOutput = (chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > CLI_DIAGNOSTIC_MAX_BYTES) requestTermination('output-limit');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    const ignoreStdinError = (): void => undefined;
    child.stdin.on('error', ignoreStdinError);
    // The browser flow does not receive renderer-controlled input. Closing
    // stdin prevents a failed browser launch from becoming an interactive
    // arbitrary command channel.
    child.stdin.end();
    const timer = setTimeout(() => {
      requestTermination('timeout');
    }, this.loginTimeoutMs);
    timer.unref();
    try {
      const outcome = await Promise.race([
        exitPromise.then((exit) => ({ kind: 'exit' as const, exit })),
        terminationRequested.then(() => ({ kind: 'termination' as const, exit: null })),
      ]);
      if (outcome.kind === 'termination') {
        // The signal is released before teardown starts, but the operation
        // itself remains bounded so a failed kill cannot leave this promise
        // pending forever.
        await (loginState.terminationOperation ?? Promise.resolve());
        this.log.warn('ChatGPT sign-in process did not complete', {
          providerId: this.id,
          reason: loginState.terminationReason ?? 'timeout',
        });
      }
      // Deliberately discard stdout/stderr and all child diagnostics. A login
      // command can print account data; only the subsequent status probe is
      // safe to represent in the renderer.
      if (outcome.kind === 'exit') {
        const { exit } = outcome;
        const reason = exit.error !== null
          ? 'process-error'
          : exit.code === 0
            ? null
            : 'nonzero-exit';
        if (reason !== null) {
          this.log.warn('ChatGPT sign-in process did not complete', {
            providerId: this.id,
            reason,
          });
        }
      }
    } finally {
      clearTimeout(timer);
      child.stdout.removeListener('data', countOutput);
      child.stderr.removeListener('data', countOutput);
      child.stdin.removeListener('error', ignoreStdinError);
      if (loginState.terminationOperation !== undefined) {
        await loginState.terminationOperation;
      } else if (isProcessRunning(child)) {
        await terminateWithDeadline(this.terminateProcess, child);
      }
      if (!isProcessRunning(child)) clearLoginChild();
      if (this.loginTermination === requestShutdownTermination) this.loginTermination = null;
    }
    if (this.hasShutdownStarted()) {
      return this.shutdownStatus();
    }
    return this.detect();
  }

  private hasShutdownStarted(): boolean {
    return this.isShuttingDown;
  }

  private shutdownStatus(): AIProviderStatus {
    return {
      id: this.id,
      name: this.name,
      available: false,
      installed: false,
      authentication: 'unknown',
      version: null,
      errorMessage: 'Application is shutting down.',
      models: [this.definition.model],
      capabilities: this.capabilities,
    };
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    for (const state of this.requests.values()) { state.cancelled = true; state.abort(); }
    this.loginTermination?.();
    const requests = [...this.requests.keys()];
    await Promise.allSettled(requests.map((requestId) => this.cancel(requestId)));
    const login = this.chatGptLogin;
    if (login !== null) {
      await Promise.race([
        login.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, LOGIN_SHUTDOWN_WAIT_MS)),
      ]);
    }
    const child = this.loginChild;
    if (child !== null && isProcessRunning(child)) {
      for (let attempt = 0; attempt < TERMINATION_RETRY_COUNT && isProcessRunning(child); attempt += 1) {
        await terminateWithDeadline(this.terminateProcess, child);
      }
    }
  }
}

export function codexToolActivity(line: string): boolean {
  try {
    const value: PortableValue = parsePortableJson(line);
    if (!value || typeof value !== 'object') return true;
    const record = value as PortableRecord;
    const item = record.item;
    if (item && typeof item === 'object') {
      const itemType = (item as PortableRecord).type;
      return typeof itemType !== 'string' || !new Set(['agent_message', 'reasoning']).has(itemType);
    }
    const type = typeof record.type === 'string' ? record.type : '';
    return !new Set(['thread.started', 'turn.started', 'turn.completed', 'item.delta', 'response.text.delta', 'response.output_text.delta', 'error']).has(type);
  } catch {
    return true;
  }
}

export function createCliProviderDefinitions(): readonly CliDefinition[] {
  // One probe instance per registry so each CLI's bounded discovery is shared
  // and cached across that provider's own status refreshes.
  const piCatalog = createPiCatalogProbe();
  const ompCatalog = createOmpCatalogProbe();
  return [
    {
      id: 'codex',
      // User-facing subscription label. The `codex` binary below is the
      // transport; Settings explains the CLI, the Chat surfaces name the
      // ChatGPT subscription the user actually selected.
      name: AI_PROVIDER_DISPLAY_NAMES.codex,
      binary: 'codex',
      model: defaultModel('codex-default', 'ChatGPT default', 128_000),
      capabilities: capabilities(false),
      buildArgs: (modelId, chatRoot) => [
        'exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
        '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--cd', chatRoot,
        ...(modelId && modelId !== 'codex-default' ? ['--model', modelId] : []),
      ],
      detectAuth: detectCodexAuth,
      chatUnavailableReason: 'Sign in with ChatGPT in Settings to use your subscription for AI Chat.',
      chatAllowedWhenConnected: true,
      toolActivity: codexToolActivity,
      toolViolationMessage: 'Codex attempted an unsupported tool operation.',
    },
    {
      id: 'claude',
      name: 'Claude Code CLI',
      binary: 'claude',
      model: defaultModel('claude-default', 'Claude CLI default', 200_000),
      capabilities: capabilities(true),
      // `--verbose` is mandatory, not cosmetic: Claude Code 2.1.267 rejects
      // `--print` with `--output-format stream-json` unless it is present and
      // exits 1 before any inference. Removing it breaks Reader Chat outright.
      buildArgs: (modelId) => [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config',
        '--no-session-persistence',
        ...(modelId && modelId !== 'claude-default' ? ['--model', modelId] : [])
      ],
      detectAuth: detectClaudeAuth,
    },
    {
      id: 'antigravity',
      name: 'Antigravity CLI',
      binary: 'agy',
      model: defaultModel('antigravity-default', 'Antigravity CLI default', 128_000),
      capabilities: capabilities(false),
      buildArgs: () => [],
      detectAuth: () => Promise.resolve('unknown'),
      chatUnavailableReason: 'This Antigravity CLI version has no verified tool-free chat mode; it remains available for Agent Mode only.',
    },
    {
      // Registered so the provider listing is complete, and permanently
      // chat-unavailable. `cursor-agent` was wired from Cursor's published CLI
      // documentation and has NOT been verified against an installed binary,
      // so no tool-free invocation can be claimed here; `buildArgs` returns
      // nothing and this CLI is never spawned for Reader Chat.
      id: 'cursor',
      name: 'Cursor CLI',
      binary: 'cursor-agent',
      model: defaultModel('cursor-default', 'Cursor CLI default', 128_000),
      capabilities: capabilities(false),
      buildArgs: () => [],
      detectAuth: () => Promise.resolve('unknown'),
      chatUnavailableReason: 'Cursor has no verified tool-free chat mode in Interleaf; it remains available for Agent Mode only.',
    },
    {
      id: 'pi',
      name: AI_PROVIDER_DISPLAY_NAMES.pi,
      binary: 'pi',
      // Sentinel only: Pi's real catalog is discovered at runtime, and a turn
      // never runs against an identifier the CLI did not publish.
      model: defaultModel('pi-default', 'Pi CLI default', 128_000),
      capabilities: capabilities(true),
      buildArgs: (modelId, _chatRoot, context) => buildPiChatArgs({
        modelId,
        models: context.models,
        systemPrompt: context.systemPrompt,
      }),
      detectAuth: () => Promise.resolve('unknown'),
      discoverCatalog: (binary, executeFile, cwd, log) => piCatalog({ binary, executeFile, cwd, log }),
      chatUnavailableReason: 'Sign in to a Pi model provider to use Pi for AI Chat.',
      chatAllowedWhenConnected: true,
      toolActivity: piToolActivity,
      toolViolationMessage: 'Pi attempted an unsupported tool operation.',
      createParser: () => new PiStreamParser(),
      // Pi receives the Reader AI prompt through `--system-prompt`.
      systemPromptInArgv: true,
    },
    {
      id: 'omp',
      name: AI_PROVIDER_DISPLAY_NAMES.omp,
      binary: 'omp',
      // Sentinel only: Omp's real catalog is discovered at runtime, and a turn
      // never runs against a selector the CLI did not publish.
      model: defaultModel('omp-default', 'Omp CLI default', 128_000),
      capabilities: capabilities(true),
      buildArgs: (modelId, chatRoot, context) => buildOmpChatArgs({
        modelId,
        models: context.models,
        systemPrompt: context.systemPrompt,
        chatRoot,
      }),
      detectAuth: () => Promise.resolve('unknown'),
      discoverCatalog: (binary, executeFile, cwd, log) => ompCatalog({ binary, executeFile, cwd, log }),
      chatUnavailableReason: 'Sign in to an Omp model provider to use Omp for AI Chat.',
      chatAllowedWhenConnected: true,
      // Omp emits Pi's event vocabulary, so the shared structural detector
      // covers both; it additionally rejects OpenAI-shaped `function_call`
      // events, which Omp's upstream providers can produce.
      toolActivity: agentJsonToolActivity,
      toolViolationMessage: 'Omp attempted an unsupported tool operation.',
      createParser: () => new OmpStreamParser(),
      // Omp receives the Reader AI prompt through `--system-prompt`.
      systemPromptInArgv: true,
    },
  ];
}

function defaultModel(id: string, name: string, contextWindow: number): AIModelInfo {
  return { id, name, contextWindow, maxOutputTokens: 4_096, supportsStreaming: true };
}

function capabilities(toolFreeMode: boolean): AIProviderCapabilities {
  return {
    streaming: true,
    subscriptionAuth: true,
    apiKeyAuth: false,
    persistentSessions: false,
    toolFreeMode,
    // Never true for a local CLI. Reaching the web through Claude Code or
    // Codex means enabling their local tool surface, which would give
    // untrusted document text a path to the filesystem and the shell. The
    // constrained tool-free invocation in ADR 0005 stays the only CLI path.
    hostedWebSearch: false,
  };
}

function buildCliPrompt(request: ProviderChatRequest, includeSystemPrompt: boolean): string {
  const history = request.history.map((message) => ({ role: message.role, content: message.content }));
  return [
    // Omitted for a CLI that already received it as a system-prompt argument:
    // repeating it there would send the same instructions twice, once as
    // system text and once as part of the turn's data.
    ...(includeSystemPrompt ? [request.systemPrompt, ''] : []),
    request.contextXml,
    '',
    'Conversation history (JSON data):',
    JSON.stringify(history),
    '',
    'User question:',
    request.userMessage,
  ].join('\n');
}

export class CliStreamParser {
  private hasEmittedDeltas = false;
  private pendingFullText = '';

  constructor(readonly providerId: AIProviderId = 'claude') {}

  parseLine(line: string): readonly string[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    let value: PortableValue;
    try {
      value = parsePortableJson(trimmed);
    } catch {
      // Structured JSONL mode: malformed JSON or diagnostic lines MUST NOT become assistant text.
      return [];
    }
    if (typeof value !== 'object' || value === null) return [];

    // Claude provider-specific event parsing
    if (this.providerId === 'claude') {
      // 1. stream_event wrapper
      if ('type' in value && value.type === 'stream_event' && 'event' in value) {
        const delta = extractTextFromEvent(value.event);
        if (delta.length > 0) {
          this.hasEmittedDeltas = true;
          return splitToSafeChunks(delta);
        }
        return [];
      }

      // 2. content_block_delta or text_delta
      if ('type' in value && (value.type === 'content_block_delta' || value.type === 'text_delta')) {
        const delta = extractTextFromEvent(value);
        if (delta.length > 0) {
          this.hasEmittedDeltas = true;
          return splitToSafeChunks(delta);
        }
        return [];
      }

      // 3. assistant aggregate message (ignore if deltas were emitted to prevent duplication)
      if ('type' in value && value.type === 'assistant' && 'message' in value) {
        if (this.hasEmittedDeltas) return [];
        const fullText = extractAssistantMessage(value.message);
        if (fullText.length > 0) {
          this.pendingFullText = fullText;
        }
        return [];
      }

      // 4. result string (ignore if deltas were emitted)
      if ('type' in value && value.type === 'result' && 'result' in value && typeof value.result === 'string') {
        if (this.hasEmittedDeltas) return [];
        if (value.result.length > 0) {
          this.pendingFullText = value.result;
        }
        return [];
      }
      return [];
    }

    // Codex provider-specific event parsing
    if (this.providerId === 'codex') {
      if ('type' in value && (value.type === 'item.delta' || value.type === 'response.text.delta') && 'delta' in value) {
        const delta = extractTextFromEvent(value);
        if (delta.length > 0) {
          this.hasEmittedDeltas = true;
          return splitToSafeChunks(delta);
        }
        return [];
      }
      if ('item' in value && typeof value.item === 'object' && value.item !== null) {
        const item = value.item;
        if ('type' in item && item.type === 'agent_message' && 'text' in item && typeof item.text === 'string') {
          if (this.hasEmittedDeltas) return [];
          this.hasEmittedDeltas = true;
          return splitToSafeChunks(item.text);
        }
      }
      if ('type' in value && value.type === 'result' && 'result' in value && typeof value.result === 'string') {
        if (this.hasEmittedDeltas) return [];
        this.pendingFullText = value.result;
        return [];
      }
      return [];
    }

    // Generic / Fallback JSON parsing
    if ('type' in value && (value.type === 'content_block_delta' || value.type === 'text_delta' || value.type === 'item.delta')) {
      const delta = extractTextFromEvent(value);
      if (delta.length > 0) {
        this.hasEmittedDeltas = true;
        return splitToSafeChunks(delta);
      }
    }

    return [];
  }

  finish(): readonly string[] {
    if (!this.hasEmittedDeltas && this.pendingFullText.length > 0) {
      const text = this.pendingFullText;
      this.pendingFullText = '';
      return splitToSafeChunks(text);
    }
    return [];
  }
}

function extractTextFromEvent(value: PortableValue): string {
  if (typeof value !== 'object' || value === null) return '';
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('delta' in value && typeof value.delta === 'object' && value.delta !== null) {
    if ('text' in value.delta && typeof value.delta.text === 'string') return value.delta.text;
  }
  if ('delta' in value && typeof value.delta === 'string') return value.delta;
  return '';
}

function extractAssistantMessage(value: PortableValue): string {
  if (typeof value !== 'object' || value === null || !('content' in value) || !Array.isArray(value.content)) return '';
  const content = value.content as PortableValue[];
  return content
    .map((part: PortableValue) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : ''
    )
    .join('');
}
export type BinaryResolutionOptions = {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly execFile?: CliExecFile;
  readonly fileSystem?: BinaryResolutionFs;
};

export async function resolveBinary(binary: string, options: BinaryResolutionOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const environment = buildAllowlistedEnvironment();
  const command = platform === 'win32'
    ? resolveWindowsWherePath(options.systemRoot ?? environment.SystemRoot ?? environment.WINDIR)
    : '/usr/bin/which';
  if (command === null) throw Object.assign(new Error('Windows resolver is unavailable'), { code: 'ENOENT' });
  const executeFile = options.execFile ?? defaultExecFile;
  let result: Awaited<ReturnType<typeof executeFile>>;
  try {
    result = await executeFile(command, [binary], {
      timeout: 5_000,
      maxBuffer: CLI_DIAGNOSTIC_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
      env: environment,
      windowsHide: true,
    });
  } catch (error) {
    // `which` and `where.exe` both exit 1, on their own, when nothing on PATH
    // matches. That is an absent CLI, not a failed probe; anything else
    // (timeout, signal, output bound) stays a probe failure.
    if (isResolverNotFound(error instanceof Error ? error : null)) throw Object.assign(new Error('binary not found'), { code: 'ENOENT' });
    throw error;
  }
  const first = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!first) throw Object.assign(new Error('binary not found'), { code: 'ENOENT' });
  return validateResolvedBinary(first, platform, options.fileSystem ?? defaultBinaryResolutionFs);
}

async function validateResolvedBinary(
  value: string,
  platform: NodeJS.Platform,
  fileSystem: BinaryResolutionFs,
): Promise<string> {
  const candidate = value.normalize('NFKC').trim();
  if (candidate.length === 0 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw Object.assign(new Error('binary resolver returned an invalid path'), { code: 'EINVAL' });
  }
  const absolute = platform === 'win32' ? win32.isAbsolute(candidate) : posix.isAbsolute(candidate);
  if (!absolute) throw Object.assign(new Error('binary resolver returned a relative path'), { code: 'EINVAL' });

  // Symlink wrappers are common for installed CLIs. Resolve them once, then
  // validate and execute the canonical target so a cwd/PATH change cannot
  // redirect a later login/status invocation. The target itself must be a
  // regular, executable file; directories and special files fail closed.
  const entry = await fileSystem.lstat(candidate);
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw Object.assign(new Error('binary resolver returned a non-file'), { code: 'EINVAL' });
  }
  const canonical = (await fileSystem.realpath(candidate)).normalize('NFKC').trim();
  const canonicalAbsolute = platform === 'win32' ? win32.isAbsolute(canonical) : posix.isAbsolute(canonical);
  if (canonical.length === 0 || !canonicalAbsolute || /[\u0000-\u001f\u007f]/u.test(canonical)) {
    throw Object.assign(new Error('binary resolver returned an invalid canonical path'), { code: 'EINVAL' });
  }
  const target = await fileSystem.stat(canonical);
  if (!target.isFile()) throw Object.assign(new Error('binary resolver target is not a regular file'), { code: 'EINVAL' });
  await fileSystem.access(canonical, fsConstants.X_OK);
  return canonical;
}

function waitForExit(child: CliChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | null;
}> {
  return new Promise((resolve) => {
    let processError: Error | null = null;
    child.once('error', (error) => { processError = error; });
    child.once('close', (code, signal) => { resolve({ code, signal, error: processError }); });
  });
}

export type ProcessTerminationOptions = {
  readonly platform?: NodeJS.Platform;
  /** Test seam; production derives this only from SystemRoot/WINDIR. */
  readonly systemRoot?: string;
  readonly spawnProcess?: CliProcessSpawner;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly taskkillTimeoutMs?: number;
  readonly gracePeriodMs?: number;
};

/**
 * Resolve the Windows helper from an OS-owned root, never from renderer input
 * or PATH lookup. Reject relative, UNC, traversal, and control-character
 * values before constructing the canonical System32 target.
 */
function resolveWindowsSystemHelper(systemRoot: string | undefined, helperName: 'taskkill.exe' | 'where.exe'): string | null {
  if (systemRoot === undefined) return null;
  const candidate = systemRoot.normalize('NFKC').trim();
  if (
    candidate.length === 0 ||
    candidate.length > 240 ||
    /[\u0000-\u001f]/u.test(candidate) ||
    !/^[A-Za-z]:[\\/]/u.test(candidate) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(candidate)
  ) return null;
  const normalizedRoot = win32.normalize(candidate);
  const helper = win32.join(normalizedRoot, 'System32', helperName);
  if (relativePathWithin(normalizedRoot, helper, win32) === null) return null;
  return helper;
}

export function resolveWindowsTaskkillPath(systemRoot: string | undefined): string | null {
  return resolveWindowsSystemHelper(systemRoot, 'taskkill.exe');
}

export function resolveWindowsWherePath(systemRoot: string | undefined): string | null {
  return resolveWindowsSystemHelper(systemRoot, 'where.exe');
}

export async function terminateProcessTree(
  child: CliChildProcess,
  options: ProcessTerminationOptions = {},
): Promise<void> {
  if (!isProcessRunning(child)) return;
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? ((pid, signal) => { process.kill(pid, signal); });
  const gracePeriodMs = options.gracePeriodMs ?? PROCESS_TREE_GRACE_MS;
  if (platform === 'win32' && child.pid !== undefined) {
    const environment = buildAllowlistedEnvironment();
    const systemRoot = options.systemRoot ?? environment.SystemRoot ?? environment.WINDIR;
    const helper = resolveWindowsTaskkillPath(systemRoot);
    if (helper !== null) {
      const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
      let killer: CliChildProcess | null = null;
      try {
        killer = spawnProcess(helper, ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          detached: false,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        killer.stdin.end();
        const helperOutput = trackBoundedOutput(killer);
        const result = await waitForExitWithTimeout(killer, options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS);
        if (result.timedOut || helperOutput.exceeded) {
          try { killer.kill('SIGKILL'); } catch { /* helper already exited */ }
        }
        if (!result.timedOut && !helperOutput.exceeded && result.error === null && result.code === 0) return;
      } catch {
        // Fall through to direct child termination below. The helper is never
        // allowed to make shutdown wait indefinitely or orphan the child.
        if (killer !== null && isProcessRunning(killer)) {
          try { killer.kill('SIGKILL'); } catch { /* helper already exited */ }
        }
      }
    }
    await terminateDirectChild(child, killProcess, gracePeriodMs);
    return;
  }
  if (child.pid === undefined) {
    await terminateDirectChild(child, killProcess, gracePeriodMs);
    return;
  }
  try {
    killProcess(-child.pid, 'SIGTERM');
  } catch {
    await terminateDirectChild(child, killProcess, gracePeriodMs);
    return;
  }
  await waitForProcessExit(child, gracePeriodMs);
  if (isProcessRunning(child)) {
    try {
      killProcess(-child.pid, 'SIGKILL');
    } catch {
      await terminateDirectChild(child, killProcess, gracePeriodMs);
    }
  }
}

async function terminateDirectChild(
  child: CliChildProcess,
  killProcess: (pid: number, signal: NodeJS.Signals) => void,
  gracePeriodMs: number,
): Promise<void> {
  let termDelivered = false;
  try {
    termDelivered = child.kill('SIGTERM');
  } catch {
    // A child can exit between the status check and kill; continue to the
    // bounded grace period and final best-effort SIGKILL.
  }
  if (!termDelivered && child.pid !== undefined) {
    try { killProcess(child.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  await waitForProcessExit(child, gracePeriodMs);
  if (isProcessRunning(child)) {
    let killDelivered = false;
    try {
      killDelivered = child.kill('SIGKILL');
    } catch {
      // Fall through to the injected/direct fallback below.
    }
    if (!killDelivered && child.pid !== undefined) {
      try { killProcess(child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
}

function waitForProcessExit(child: CliChildProcess, timeoutMs: number): Promise<void> {
  if (!isProcessRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

function waitForExitWithTimeout(
  child: CliChildProcess,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error: Error | null; readonly timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, error: null, timedOut: true });
    }, timeoutMs);
    void waitForExit(child).then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut: false });
    });
  });
}

async function terminateWithDeadline(
  terminator: CliProcessTerminator,
  child: CliChildProcess,
): Promise<void> {
  let resolveTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => { resolveTimeout = resolve; });
  const timer = setTimeout(resolveTimeout, TERMINATOR_CALL_TIMEOUT_MS);
  try {
    await Promise.race([terminator(child), timeout]);
  } catch {
    // Process teardown is best effort; callers must continue their own
    // bounded cleanup and never surface provider diagnostics to the renderer.
  } finally {
    clearTimeout(timer);
  }
}

function trackBoundedOutput(child: CliChildProcess): { readonly exceeded: boolean } {
  let exceeded = false;
  let outputBytes = 0;
  const count = (chunk: string): void => {
    outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (outputBytes > CLI_DIAGNOSTIC_MAX_BYTES) exceeded = true;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  return { get exceeded() { return exceeded; } };
}

function isProcessRunning(child: CliChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function isResolverNotFound(error: Error | null): boolean {
  if (error === null || !('code' in error) || error.code !== 1) return false;
  const killed = 'killed' in error && error.killed === true;
  const signalled = 'signal' in error && error.signal !== null && error.signal !== undefined;
  return !killed && !signalled;
}
