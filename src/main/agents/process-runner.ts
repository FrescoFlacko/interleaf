import { execFile, spawn, type ChildProcessByStdio, type ExecFileOptionsWithStringEncoding, type SpawnOptionsWithStdioTuple } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { buildMinimalChildEnvironment } from './child-environment';
import type { ProcessSpawner, RunnerChildProcess } from './runner-child-process';
import { writeChildStdin } from './child-stdin';
import { redactRecord, redactText, type RedactionValue } from './event-redaction';
import { AsyncEventQueue } from './async-event-queue';
import { MAX_EVENT_BYTES, StreamRedactor, type StreamRedactedFrame } from './stream-redactor';
import { type PortableMember, type PortableRecord, type PortableValue, isPortableArray, parsePortableJson } from '@shared/models/portable';
import { errorHasCode } from '@shared/models/caught-error';

export { buildMinimalChildEnvironment };
export type { ProcessSpawner };

export type ProcessRunnerRequest = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly clearEnv?: readonly string[];
  /** Explicitly registered secret values that are never safe to echo.
   * Delivering a value through `env` does not imply secrecy; only this
   * explicit registration opts a value into redaction, on top of the
   * always-on credential-shape detectors. */
  readonly redactValues?: readonly string[];
  /**
   * Explicit finite total runtime timeout. Normal agent start/resume runs
   * omit this and stay alive until the child exits, the caller cancels, or
   * the application shuts down. Bounded probes, tests, and helper runs pass
   * an explicit value, which is enforced exactly.
   */
  readonly timeoutMs?: number;
  readonly stdin?: string;
  /**
   * Hold stdin open after the payload is written. Only a server-style protocol
   * that answers while its input stream stays open needs this; an ordinary run
   * must see EOF so it can finish without waiting for the bounded timeout.
   */
  readonly keepStdinOpen?: boolean;
  /**
   * Opt-in for callers that must never observe a settled run whose child-tree
   * termination was not proven (model discovery). With this flag the runner's
   * `completion` rejects with `ProcessCleanupUnknownError` instead of settling
   * as a success when the tree state is unknown: the POSIX group-reap window
   * closed with the group still present, or the Windows tree helper was
   * unavailable, failed, or stayed unverified after its grace. Ordinary runs
   * keep their existing bounded-stop behaviour.
   */
  readonly strictCleanup?: boolean;
};

/** Main-only allowlisted classification captured from a raw JSON frame. This
 * is deliberately not an arbitrary protocol value and is never copied into a
 * renderer-facing AgentEvent. */
type ProcessStructuredKind = 'structured' | 'changed-files' | 'tests' | 'final';

export type ProcessRunnerEvent =
  | { readonly type: 'started'; readonly runId: string; readonly timestamp: string }
  | { readonly type: 'stdout' | 'stderr'; readonly runId: string; readonly text: string; readonly timestamp: string }
  | { readonly type: 'structured'; readonly runId: string; readonly data: PortableRecord; readonly timestamp: string; readonly structuredKind?: ProcessStructuredKind; readonly structuredFinalText?: string }
  | { readonly type: 'cancelled'; readonly runId: string; readonly timestamp: string }
  | { readonly type: 'ended'; readonly runId: string; readonly exitCode: number | null; readonly signal: string | null; readonly timestamp: string }
  | { readonly type: 'error'; readonly runId: string; readonly message: string; readonly timestamp: string };

export type ProcessRunHandle = {
  readonly runId: string;
  readonly events: AsyncIterable<ProcessRunnerEvent>;
  /** Resolves only after the child emits close and termination cleanup runs. */
  readonly completion: Promise<void>;
  cancel(): void;
};

const defaultSpawner: ProcessSpawner = (file, args, options) => spawn(file, [...args], options);
const execFileAsync = promisify(execFile);

/**
 * A one-shot child that runs to completion: the caller must state a finite
 * timeout and output cap, and a shell is never involved.
 *
 * `env` is required and is the child's whole environment. Node would otherwise
 * hand the child the full parent `process.env`, so every caller states an
 * allowlisted environment (for example `buildMinimalChildEnvironment()`).
 */
export type BoundedExecFileOptions = Omit<ExecFileOptionsWithStringEncoding, 'shell' | 'timeout' | 'maxBuffer' | 'env'> & {
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly env: NodeJS.ProcessEnv;
};

/** Main's only `execFile` entry point: fixed executable, tokenized argv, bounded time and output. */
export async function execFileBounded(
  file: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(file, [...args], { ...options, shell: false });
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * A long-lived piped child whose caller enforces its own output and time
 * bounds. As with `execFileBounded`, `env` is required and is the child's
 * whole environment, never an implicit copy of the parent's.
 */
export type PipedSpawnOptions = Omit<SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>, 'shell' | 'env'> & {
  readonly shell: false;
  readonly env: NodeJS.ProcessEnv;
};

/** Main's only piped `spawn` entry point outside this runner: fixed executable, tokenized argv, no shell. */
export function spawnPiped(
  file: string,
  args: readonly string[],
  options: PipedSpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  return spawn(file, [...args], { ...options, shell: false });
}

export type WindowsTaskkillRunner = (executable: string, args: readonly string[]) => Promise<boolean>;

export type ProcessRunnerOptions = {
  readonly spawnProcess?: ProcessSpawner;
  /** Test seam for selecting the platform without mutating process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Test seam; production defaults to the trusted OS environment. */
  readonly systemRoot?: string | undefined;
  /** Test seam for exact taskkill argv and escalation behavior. */
  readonly windowsTaskkill?: WindowsTaskkillRunner;
  /** Grace period between taskkill /T and taskkill /T /F. */
  readonly windowsTerminationGraceMs?: number;
  /** Maximum time allowed for one taskkill invocation before the tree state is unknown. */
  readonly windowsTaskkillTimeoutMs?: number;
  /** Caller-configured default applied when a request omits `timeoutMs`. The
   * runner itself imposes no built-in total deadline. */
  readonly timeoutMs?: number;
};

/** Thrown (as a `completion` rejection) by a `strictCleanup` run when the
 * child tree's termination could not be proven. The tree may still exist; the
 * caller is told that rather than being told the cleanup succeeded. */
export class ProcessCleanupUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessCleanupUnknownError';
  }
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const MAX_INPUT_BYTES = 256 * 1024;
const WINDOWS_UNKNOWN_TREE_GRACE_MS = 100;

/**
 * The part of the runner a collaborator holds: one bounded run, and nothing
 * about how the child is spawned. An adapter or probe takes this rather than
 * the class so the seam it depends on is the one it uses, and so a test can
 * stand in for it with an object that answers the whole contract.
 */
export type ProcessLauncher = Pick<ProcessRunner, 'run'>;

/**
 * Main-process-only child process boundary. All arguments remain an argv
 * array, shell execution is permanently disabled, and the environment is
 * assembled from a small allowlist instead of inheriting process.env.
 */
export class ProcessRunner {
  private readonly spawnProcess: ProcessSpawner;
  private readonly platform: NodeJS.Platform;
  private readonly systemRoot: string | undefined;
  private readonly windowsTaskkill: WindowsTaskkillRunner;
  private readonly windowsTerminationGraceMs: number;
  private readonly windowsTaskkillTimeoutMs: number;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(spawnProcessOrOptions: ProcessSpawner | ProcessRunnerOptions = defaultSpawner) {
    if (typeof spawnProcessOrOptions === 'function') {
      this.spawnProcess = spawnProcessOrOptions;
      this.platform = process.platform;
      this.systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      this.windowsTaskkill = createWindowsTaskkillRunner(this.spawnProcess);
    } else {
      this.spawnProcess = spawnProcessOrOptions.spawnProcess ?? defaultSpawner;
      this.platform = spawnProcessOrOptions.platform ?? process.platform;
      this.systemRoot = spawnProcessOrOptions.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
      this.windowsTaskkill = spawnProcessOrOptions.windowsTaskkill ?? createWindowsTaskkillRunner(this.spawnProcess);
    }
    const configuredGraceMs = typeof spawnProcessOrOptions === 'function' ? 2_000 : spawnProcessOrOptions.windowsTerminationGraceMs ?? 2_000;
    this.windowsTerminationGraceMs = Math.max(0, Math.min(configuredGraceMs, 30_000));
    const configuredTaskkillTimeoutMs = typeof spawnProcessOrOptions === 'function' ? 2_000 : spawnProcessOrOptions.windowsTaskkillTimeoutMs ?? 2_000;
    this.windowsTaskkillTimeoutMs = Math.max(0, Math.min(configuredTaskkillTimeoutMs, 30_000));
    const configuredTimeoutMs = typeof spawnProcessOrOptions === 'function' ? undefined : spawnProcessOrOptions.timeoutMs;
    this.defaultTimeoutMs = configuredTimeoutMs !== undefined && Number.isFinite(configuredTimeoutMs)
      ? Math.max(1, Math.trunc(configuredTimeoutMs))
      : undefined;
  }

  run(request: ProcessRunnerRequest): ProcessRunHandle {
    const runId = randomUUID();
    const platform = this.platform;
    const systemRoot = this.systemRoot;
    const windowsTaskkill = this.windowsTaskkill;
    const windowsTerminationGraceMs = this.windowsTerminationGraceMs;
    const windowsTaskkillTimeoutMs = this.windowsTaskkillTimeoutMs;
    const timestamp = (): string => new Date().toISOString();
    const strictCleanup = request.strictCleanup === true;
    const queue = new AsyncEventQueue<ProcessRunnerEvent>(256, (count) => ({
      type: 'structured', runId, data: { kind: 'dropped-events', count }, timestamp: timestamp(),
    }), (event) => event.type === 'error' || event.type === 'cancelled' || event.type === 'ended'
      || (event.type === 'structured' && event.structuredKind === 'final'));
    let child: RunnerChildProcess | null = null;
    let settled = false;
    let closed = false;
    let cancelled = false;
    let terminationPending = false;
    let escalationSent = false;
    let treeTerminationVerified = false;
    let outputBytes = 0;
    let outputCapped = false;
    let timeout: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let reapPollTimer: NodeJS.Timeout | null = null;
    let unknownTreeTimer: NodeJS.Timeout | null = null;
    let treeTerminationUnknown = false;
    let cleanupUnknown = false;
    let resolveChildClosed!: () => void;
    const childClosedPromise = new Promise<void>((resolve) => { resolveChildClosed = resolve; });
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: ProcessCleanupUnknownError) => void;
    const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    const finish = (): void => {
      // A strict run never settles as a success while the tree state is
      // unknown: the caller is told that termination could not be proven.
      if (strictCleanup && cleanupUnknown) {
        if (settled) return;
        if (timeout !== null) { clearTimeout(timeout); timeout = null; }
        if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
        if (unknownTreeTimer !== null) { clearTimeout(unknownTreeTimer); unknownTreeTimer = null; }
        queue.close();
        rejectCompletion(new ProcessCleanupUnknownError(`Agent process tree termination could not be verified. (cwd=${request.cwd} file=${request.file})`));
        return;
      }
      // A direct child `close` event does not prove that descendants in the
      // detached process group have exited. Keep completion behind the TERM →
      // KILL escalation and a short post-KILL reap grace period.
      if (terminationPending && (!escalationSent || (platform === 'win32' && !treeTerminationVerified))) return;
      if (terminationPending && reapPollTimer !== null) return;
      if (timeout !== null) clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      if (unknownTreeTimer !== null) clearTimeout(unknownTreeTimer);
      timeout = null;
      killTimer = null;
      unknownTreeTimer = null;
      if (!settled) {
        settled = true;
        queue.close();
        resolveCompletion();
      }
    };
    // Build the exact environment once. The same object is passed to spawn and
    // its explicitly supplied values are part of the redaction set before any
    // child output can be parsed into structured events.
    const childEnvironment = buildMinimalChildEnvironment(request.env, request.clearEnv);
    const secretValues = buildProcessRedactionValues(request);
    const diagnosticMessage = (message: string): string => `${message} (cwd=${request.cwd} file=${request.file})`;
    const emit = (event: ProcessRunnerEvent): void => { queue.push(redactProcessEvent(event, secretValues)); };
    /** Records that the child tree's termination could not be proven and, in a
     * strict run, turns the next `finish()` into a rejected completion. */
    const failCleanupUnknown = (message: string): void => {
      cleanupUnknown = true;
      emit({ type: 'error', runId, message: diagnosticMessage(message), timestamp: timestamp() });
    };
    if (request.stdin !== undefined && Buffer.byteLength(request.stdin, 'utf8') > MAX_INPUT_BYTES) {
      emit({ type: 'error', runId, message: diagnosticMessage('Agent input exceeds the bounded runtime limit.'), timestamp: timestamp() });
      finish();
      return { runId, events: queue, completion, cancel: () => undefined };
    }
    const decoders: Record<'stdout' | 'stderr', StringDecoder> = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const redactors: Record<'stdout' | 'stderr', StreamRedactor> = {
      stdout: new StreamRedactor(secretValues),
      stderr: new StreamRedactor(secretValues),
    };
    const emitRedactedText = (stream: 'stdout' | 'stderr', frames: readonly StreamRedactedFrame[]): void => {
      for (const frame of frames) {
        const text = frame.redactedText;
        if (text.length === 0) continue;
        emit({ type: stream, runId, text, timestamp: timestamp() });
        // Structured JSON must be parsed from the original bounded completed
        // frame. Redacting the JSON bytes first can corrupt syntax when a
        // short inherited value (for example `1`) appears in quotes, keys,
        // and numeric tokens. The parsed record is redacted by `emit` before
        // it enters the ProcessRunner queue; the renderer-facing text above
        // remains fully redacted.
        if (frame.rawText === null) continue;
        const line = frame.rawText.endsWith('\n') ? frame.rawText.slice(0, -1).replace(/\r$/u, '') : frame.rawText;
        const structured = parseStructuredAgentLine(line);
        if (structured !== null) {
          const structuredKind = classifyStructuredRecord(structured);
          emit({
            type: 'structured',
            runId,
            data: structured,
            timestamp: timestamp(),
            structuredKind,
            ...(structuredKind === 'final' && typeof structured.text === 'string'
              ? { structuredFinalText: structured.text }
              : {}),
          });
        }
      }
    };
    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputCapped || closed) return;
      const currentChild = child;
      if (currentChild === null) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      const accepted = chunk.subarray(0, Math.max(0, remaining));
      outputBytes += accepted.byteLength;
      if (accepted.byteLength === 0 || accepted.byteLength < chunk.byteLength) {
        outputCapped = true;
        emit({ type: 'error', runId, message: diagnosticMessage('Agent output exceeded the bounded runtime limit.'), timestamp: timestamp() });
        requestTermination(currentChild);
      }
      const text = decoders[stream].write(accepted);
      if (text.length === 0) return;
      emitRedactedText(stream, redactors[stream].pushFrames(text));
    };

    try {
      child = this.spawnProcess(request.file, [...request.args], {
        cwd: request.cwd,
        shell: false,
        env: childEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      emit({ type: 'error', runId, message: diagnosticMessage(error instanceof Error ? error.message : 'Could not start agent process.'), timestamp: timestamp() });
      finish();
      return { runId, events: queue, completion, cancel: () => undefined };
    }

    const spawnedChild = child;
    emit({ type: 'started', runId, timestamp: timestamp() });
    spawnedChild.on('error', (error) => {
      emit({ type: 'error', runId, message: diagnosticMessage(error.message), timestamp: timestamp() });
    });
    spawnedChild.on('close', (exitCode, signal) => {
      closed = true;
      resolveChildClosed();
      for (const stream of ['stdout', 'stderr'] as const) {
        emitRedactedText(stream, redactors[stream].pushFrames(decoders[stream].end()));
        emitRedactedText(stream, redactors[stream].finishFrames());
      }
      emit({ type: 'ended', runId, exitCode, signal, timestamp: timestamp() });
      // A test seam (or a process without a usable group identifier) can
      // report child close without leaving a group to reap. In that case the
      // direct close is the complete termination proof; real groups remain
      // behind TERM and continue through the normal KILL/reap path.
      if (terminationPending && !escalationSent && platform !== 'win32' && !hasLiveProcessGroup(spawnedChild.pid)) {
        escalationSent = true;
      }
      if (terminationPending && platform === 'win32' && escalationSent && treeTerminationUnknown && !treeTerminationVerified) {
        scheduleUnknownTreeResolution();
      }
      finish();
    });
    spawnedChild.stdout?.on('data', (chunk: Buffer) => { onChunk('stdout', chunk); });
    spawnedChild.stderr?.on('data', (chunk: Buffer) => { onChunk('stderr', chunk); });
    writeChildStdin(spawnedChild.stdin, request.stdin, request.keepStdinOpen === true);

    // Normal agent runs omit `timeoutMs` and stay alive until the child exits,
    // the caller cancels, or the application shuts down. Only an explicit
    // finite value starts the total-runtime timer; bounded probes, tests, and
    // helper runs rely on exactly that value.
    const requestedTimeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0) {
      timeout = setTimeout(() => {
        if (closed || terminationPending) return;
        emit({ type: 'error', runId, message: diagnosticMessage('Agent process timed out.'), timestamp: timestamp() });
        requestTermination(spawnedChild);
      }, Math.trunc(requestedTimeoutMs));
    }

    return {
      runId,
      events: queue,
      completion,
      cancel: () => {
        if (settled || cancelled) return;
        cancelled = true;
        emit({ type: 'cancelled', runId, timestamp: timestamp() });
        requestTermination(spawnedChild);
      },
    };

    function requestTermination(processHandle: RunnerChildProcess): void {
      if (terminationPending || settled) return;
      terminationPending = true;
      if (platform === 'win32') {
        void requestWindowsTermination(processHandle);
        return;
      }
      terminateProcessTree(processHandle, 'SIGTERM');
      killTimer = setTimeout(() => {
        escalationSent = true;
        terminateProcessTree(processHandle, 'SIGKILL');
        scheduleGroupReap(processHandle.pid);
      }, 2_000);
      killTimer.unref();
    }

    function scheduleGroupReap(pid: number | undefined): void {
      if (pid === undefined) {
        reapPollTimer = setTimeout(() => {
          reapPollTimer = null;
          if (strictCleanup) failCleanupUnknown('No process-group identifier was available to verify termination.');
          finish();
        }, 100);
        reapPollTimer.unref();
        return;
      }
      const deadline = Date.now() + 1_000;
      const poll = (): void => {
        let alive = false;
        // Only a definite `ESRCH` proves the group is gone. Anything else,
        // including a thrown value that is not an error at all, is cleanup
        // uncertainty and keeps the reap window open.
        try { process.kill(-pid, 0); alive = true; } catch (error) {
          if (!errorHasCode(error instanceof Error ? error : null, 'ESRCH')) alive = true;
        }
        if (alive && Date.now() < deadline) {
          reapPollTimer = setTimeout(poll, 25);
          reapPollTimer.unref();
          return;
        }
        reapPollTimer = null;
        // The group was still present when the bounded reap window closed. An
        // ordinary run keeps its bounded-stop behaviour; a strict run records
        // that termination is unproven instead of claiming the tree is reaped.
        if (alive && strictCleanup) {
          failCleanupUnknown('Agent process group was still present after the SIGKILL escalation; termination could not be proven.');
        }
        finish();
      };
      poll();
    }

    function hasLiveProcessGroup(pid: number | undefined): boolean {
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        // Not proven gone, so it is treated as present; see `scheduleGroupReap`.
        return !errorHasCode(error instanceof Error ? error : null, 'ESRCH');
      }
    }

    async function requestWindowsTermination(processHandle: RunnerChildProcess): Promise<void> {
      const pid = processHandle.pid;
      const executable = resolveWindowsTaskkillExecutable(systemRoot);
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || executable === null) {
        emit({ type: 'error', runId, message: diagnosticMessage('Windows process-tree termination helper is unavailable.'), timestamp: timestamp() });
        treeTerminationUnknown = true;
        fallbackWindowsTermination(processHandle);
        return;
      }
      const graceful = await runWindowsTaskkill(executable, buildWindowsTaskkillArgs(pid, false));
      if (graceful) {
        const childClosedDuringGrace = await waitForWindowsEscalationOrClose();
        if (childClosedDuringGrace) {
          treeTerminationVerified = true;
          escalationSent = true;
          if (closed) finish();
          return;
        }
      }
      const forced = await runWindowsTaskkill(executable, buildWindowsTaskkillArgs(pid, true));
      if (!forced) {
        emit({ type: 'error', runId, message: diagnosticMessage('Windows process-tree termination helper failed.'), timestamp: timestamp() });
        treeTerminationUnknown = true;
        try { processHandle.kill('SIGKILL'); } catch { /* process already exited */ }
      } else {
        treeTerminationVerified = true;
      }
      escalationSent = true;
      if (treeTerminationUnknown && closed) scheduleUnknownTreeResolution();
      if (closed) finish();
    }

    function scheduleUnknownTreeResolution(): void {
      if (unknownTreeTimer !== null || treeTerminationVerified) return;
      unknownTreeTimer = setTimeout(() => {
        unknownTreeTimer = null;
        if (strictCleanup) {
          failCleanupUnknown('Windows process-tree termination could not be verified.');
          finish();
          return;
        }
        treeTerminationVerified = true;
        finish();
      }, WINDOWS_UNKNOWN_TREE_GRACE_MS);
    }

    async function runWindowsTaskkill(executable: string, args: readonly string[]): Promise<boolean> {
      let timeoutHandle!: NodeJS.Timeout;
      try {
        const taskkillResult = Promise.resolve()
          .then(() => windowsTaskkill(executable, args))
          .then((result) => result, () => false);
        let resolveTimeout!: (value: boolean) => void;
        const timeoutResult = new Promise<boolean>((resolveResult) => { resolveTimeout = resolveResult; });
        timeoutHandle = setTimeout(() => { resolveTimeout(false); }, windowsTaskkillTimeoutMs);
        timeoutHandle.unref();
        return await Promise.race([taskkillResult, timeoutResult]);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    async function waitForWindowsEscalationOrClose(): Promise<boolean> {
      if (closed) return true;
      let graceTimer!: NodeJS.Timeout;
      try {
        const graceExpired = new Promise<boolean>((resolveWait) => {
          graceTimer = setTimeout(() => { resolveWait(false); }, windowsTerminationGraceMs);
          graceTimer.unref();
        });
        const childClosed = childClosedPromise.then(() => true);
        return await Promise.race([childClosed, graceExpired]);
      } finally {
        clearTimeout(graceTimer);
      }
    }

    function fallbackWindowsTermination(processHandle: RunnerChildProcess): void {
      try { processHandle.kill('SIGTERM'); } catch { /* process already exited */ }
      killTimer = setTimeout(() => {
        killTimer = null;
        try { processHandle.kill('SIGKILL'); } catch { /* process already exited */ }
        escalationSent = true;
        if (treeTerminationUnknown && closed) scheduleUnknownTreeResolution();
        if (closed) finish();
      }, windowsTerminationGraceMs);
      killTimer.unref();
    }
  }
}

export function resolveWindowsTaskkillExecutable(systemRoot: string | undefined): string | null {
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) return null;
  const executable = win32.normalize(win32.join(systemRoot, 'System32', 'taskkill.exe'));
  return win32.isAbsolute(executable) && win32.basename(executable).toLowerCase() === 'taskkill.exe' ? executable : null;
}

export function buildWindowsTaskkillArgs(pid: number, force: boolean): readonly string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process identifier.');
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
}

function createWindowsTaskkillRunner(spawnProcess: ProcessSpawner): WindowsTaskkillRunner {
  return (executable, args) => new Promise<boolean>((resolveResult) => {
    let command: RunnerChildProcess;
    try {
      command = spawnProcess(executable, [...args], {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
      });
    } catch {
      resolveResult(false);
      return;
    }
    let settledResult = false;
    const settle = (success: boolean): void => {
      if (settledResult) return;
      settledResult = true;
      resolveResult(success);
    };
    command.once('error', () => { settle(false); });
    command.once('close', (code) => { settle(code === 0); });
  });
}

function redactProcessEvent(event: ProcessRunnerEvent, secretValues: readonly RedactionValue[]): ProcessRunnerEvent {
  if (event.type === 'stdout' || event.type === 'stderr' || event.type === 'error') {
    return { ...event, ...(event.type === 'error' ? { message: redactText(event.message, secretValues) } : { text: redactText(event.text, secretValues) }) };
  }
  // Preserve only the bounded internal classification. The record itself is
  // still fully redacted, including any kind/type discriminator characters.
  if (event.type === 'structured') {
    return {
      ...event,
      data: redactRecord(event.data, secretValues),
      ...(event.structuredFinalText !== undefined ? { structuredFinalText: redactText(event.structuredFinalText, secretValues) } : {}),
    };
  }
  return event;
}

function classifyStructuredRecord(data: PortableRecord): ProcessStructuredKind {
  const discriminator = data.kind ?? data.type;
  return discriminator === 'changed-files' || discriminator === 'tests' || discriminator === 'final'
    ? discriminator
    : 'structured';
}

/** Signal the child's whole detached process group, falling back to the child
 * alone when no group is available. */
function terminateProcessTree(child: RunnerChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

/**
 * Explicitly registered secret values for one run — exactly the caller's
 * `redactValues`. Delivering a value through `request.env` does not by itself
 * make it secret: inherited ambient values, profile overrides, and the
 * expert-shell `INTERLEAF_*` metadata are ordinary local diagnostics. Only a
 * caller that explicitly registers a value opts it into redaction, on top of
 * the always-on credential/private-key/token/secret-assignment detectors.
 */
export function buildProcessRedactionValues(
  request: Pick<ProcessRunnerRequest, 'redactValues'>,
): readonly RedactionValue[] {
  const values: RedactionValue[] = [];
  for (const value of request.redactValues ?? []) {
    if (value.length > 0 && !values.some((candidate) => candidate.value === value)) {
      values.push({ value, kind: 'generic' });
    }
  }
  return values;
}

export function parseStructuredAgentLine(line: string): PortableRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_EVENT_BYTES || !trimmed.startsWith('{')) return null;
  try {
    const parsed: PortableValue = parsePortableJson(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if (!isBoundedStructuredValue(parsed, 0)) return null;
    return parsed as PortableRecord;
  } catch {
    return null;
  }
}

function isBoundedStructuredValue(value: PortableMember, depth: number): boolean {
  if (depth > 5) return false;
  if (value === null || typeof value !== 'object') return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  if (isPortableArray(value)) return value.length <= 128 && value.every((entry) => isBoundedStructuredValue(entry, depth + 1));
  const record: PortableRecord = value;
  return Object.keys(record).length <= 128 && Object.keys(record).every((key) => key.length <= 256 && isBoundedStructuredValue(record[key], depth + 1));
}
