/**
 * Main-owned scheduling for diagram rendering.
 *
 * Every decision that bounds a render lives here, on the privileged side: which
 * source is even dispatched, how long it may run, how many may be queued, and
 * whether the markup that comes back is shown at all. The process that actually
 * runs the diagram library is the one thing in this path that has touched
 * document-controlled input, so nothing it reports is taken as authority — not
 * its success, not its dimensions, not its claim that it sanitized its own
 * output.
 *
 * Cancellation is real. The deadline does not resolve a race and leave a
 * runaway render burning a core behind a settled promise; it destroys the
 * renderer's operating-system process. A later reply from a job that was
 * already abandoned is dropped by job identity, not by hoping it never arrives.
 *
 * The isolation this buys is Chromium's renderer sandbox and a network-denied,
 * API-free session. It is a strong boundary against the diagram library
 * mis-handling hostile input. It is not a claim of isolation from a hostile
 * process already running as this user.
 */
import { randomUUID } from 'node:crypto';
import {
  MERMAID_LIMITS,
  applyMermaidSourcePolicy,
  mermaidSandboxResultSchema,
} from '@shared/schemas/mermaid';
import type {
  MermaidFailureReason,
  MermaidRenderRequest,
  MermaidRenderResult,
  MermaidSandboxJob,
} from '@shared/types/mermaid';
import type { Logger } from '../../logging/logger';
import { assertInertSvg } from './svg-output-guard';
import { describeError } from '@shared/models/caught-error';
import type { CloneableValue } from '@shared/models/portable';

/**
 * The terminable unit main drives.
 *
 * `run` hands one job to the isolated process and resolves with whatever it
 * said. `destroy` ends that process; it must be safe to call while a `run` is
 * outstanding, and the abandoned promise may settle, never settle, or reject.
 */
export type MermaidSandbox = {
  /** Resolves once the isolated page is loaded and able to accept a job. */
  ready(): Promise<void>;
  run(job: MermaidSandboxJob): Promise<CloneableValue>;
  destroy(): void;
};

export type MermaidRenderServiceOptions = {
  /** Creates a fresh isolated renderer. Called lazily and after termination. */
  readonly createSandbox: () => MermaidSandbox;
  readonly log: Logger;
  /** Test seam for the deadline; never allowed to exceed the fixed bound. */
  readonly timeoutMs?: number;
};

function failed(reason: MermaidFailureReason): MermaidRenderResult {
  return { status: 'failed', reason };
}

type QueueEntry = {
  readonly request: MermaidRenderRequest;
  readonly resolve: (result: MermaidRenderResult) => void;
};

export class MermaidRenderService {
  readonly #createSandbox: () => MermaidSandbox;
  readonly #log: Logger;
  readonly #timeoutMs: number;
  readonly #queue: QueueEntry[] = [];

  #sandbox: MermaidSandbox | null = null;
  #draining = false;
  #disposed = false;

  constructor(options: MermaidRenderServiceOptions) {
    this.#createSandbox = options.createSandbox;
    this.#log = options.log;
    // A caller may shorten the budget but never extend it.
    const requested = options.timeoutMs;
    this.#timeoutMs =
      requested === undefined || !Number.isFinite(requested)
        ? MERMAID_LIMITS.renderTimeoutMs
        : Math.max(1, Math.min(Math.floor(requested), MERMAID_LIMITS.renderTimeoutMs));
  }

  /**
   * Draws one diagram, or explains why it was not drawn.
   *
   * Never rejects: a diagram that cannot be rendered is a typed failure the
   * reader shows next to the original source, not an error that could take a
   * document's rendering down with it.
   */
  async render(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
    if (this.#disposed) return failed('unavailable');
    if (this.#queue.length >= MERMAID_LIMITS.maxQueuedJobs) {
      this.#log.warn('mermaid render queue full', { queued: this.#queue.length });
      return failed('unavailable');
    }
    return new Promise<MermaidRenderResult>((resolve) => {
      this.#queue.push({ request, resolve });
      void this.#drain();
    });
  }

  /**
   * Ends the isolated process and fails everything still waiting.
   *
   * Called on shutdown. Queued callers are answered rather than abandoned, so
   * no reader is left waiting on a diagram that will never arrive.
   */
  dispose(): void {
    this.#disposed = true;
    this.#destroySandbox('dispose');
    const pending = this.#queue.splice(0, this.#queue.length);
    for (const entry of pending) entry.resolve(failed('unavailable'));
  }

  /** Runs queued jobs one at a time; concurrency here is a resource bound. */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const entry = this.#queue.shift();
        if (entry === undefined) return;
        const result = this.#disposed
          ? failed('unavailable')
          : await this.#renderOne(entry.request);
        entry.resolve(result);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #renderOne(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
    const policy = applyMermaidSourcePolicy(request.source);
    if (policy.status === 'rejected') {
      return failed(policy.reason === 'empty' ? 'invalid-syntax' : 'source-too-large');
    }

    const jobId = randomUUID();
    const job: MermaidSandboxJob = {
      jobId,
      source: policy.source,
      appearance: request.appearance,
      maxSvgBytes: MERMAID_LIMITS.maxSvgLength,
      maxDimension: MERMAID_LIMITS.maxDimension,
    };

    const sandbox = this.#ensureSandbox();
    if (sandbox === null) return failed('unavailable');

    const raw = await this.#runBounded(sandbox, job);
    if (raw.status === 'terminated') return failed(raw.reason);
    return this.#acceptOutput(raw.value, jobId);
  }

  #ensureSandbox(): MermaidSandbox | null {
    if (this.#sandbox !== null) return this.#sandbox;
    try {
      this.#sandbox = this.#createSandbox();
      return this.#sandbox;
    } catch (error) {
      this.#log.error('mermaid sandbox could not start', { error: errorName(error instanceof Error ? error : null) });
      this.#sandbox = null;
      return null;
    }
  }

  /**
   * Runs one job under a wall-clock deadline enforced by process termination.
   *
   * The timer does not race the render; when it fires, the isolated process is
   * destroyed, which is what actually stops the work. The next job lazily
   * creates a fresh one, so a single hostile diagram costs one process, not the
   * feature.
   */
  async #runBounded(
    sandbox: MermaidSandbox,
    job: MermaidSandboxJob
  ): Promise<{ status: 'settled'; value: CloneableValue } | { status: 'terminated'; reason: MermaidFailureReason }> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ status: 'terminated'; reason: MermaidFailureReason }>(
      (resolve) => {
        timer = setTimeout(() => {
          this.#log.warn('mermaid render exceeded its deadline; terminating renderer', {
            timeoutMs: this.#timeoutMs,
          });
          this.#destroySandbox('timeout');
          resolve({ status: 'terminated', reason: 'timeout' });
        }, this.#timeoutMs);
        timer.unref();
      }
    );

    const attempt = (async (): Promise<
      { status: 'settled'; value: CloneableValue } | { status: 'terminated'; reason: MermaidFailureReason }
    > => {
      try {
        await sandbox.ready();
        return { status: 'settled', value: await sandbox.run(job) };
      } catch (error) {
        // A destroyed window rejects here too; the deadline branch has already
        // decided that outcome, and `Promise.race` keeps whichever came first.
        this.#log.warn('mermaid render failed inside the isolated renderer', {
          error: errorName(error instanceof Error ? error : null),
        });
        this.#destroySandbox('error');
        return { status: 'terminated', reason: 'unavailable' };
      }
    })();

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Re-checks everything the isolated renderer asserted.
   *
   * Identity first: a reply carrying another job's id is a reply to a job this
   * side already abandoned, and it is discarded rather than shown against the
   * wrong diagram.
   */
  #acceptOutput(value: CloneableValue, expectedJobId: string): MermaidRenderResult {
    const parsed = mermaidSandboxResultSchema.safeParse(value);
    if (!parsed.success) {
      this.#log.warn('mermaid renderer returned an unrecognized result');
      return failed('rejected-output');
    }
    const result = parsed.data;
    if (result.jobId !== expectedJobId) {
      this.#log.warn('mermaid renderer returned a stale job result');
      return failed('rejected-output');
    }
    if (result.status === 'failed') return failed(result.reason);

    const width = Math.ceil(result.width);
    const height = Math.ceil(result.height);
    if (
      width < 1 ||
      height < 1 ||
      width > MERMAID_LIMITS.maxDimension ||
      height > MERMAID_LIMITS.maxDimension
    ) {
      return failed('output-too-large');
    }
    if (result.svg.length > MERMAID_LIMITS.maxSvgLength) return failed('output-too-large');

    const verdict = assertInertSvg(result.svg, { maxLength: MERMAID_LIMITS.maxSvgLength });
    if (!verdict.ok) {
      // The rule name is Interleaf's own vocabulary, never renderer output.
      this.#log.warn('mermaid output rejected by the inert-SVG guard', {
        violation: verdict.violation,
      });
      return failed('rejected-output');
    }

    return { status: 'rendered', svg: result.svg, width, height };
  }

  #destroySandbox(cause: 'timeout' | 'error' | 'dispose'): void {
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    if (sandbox === null) return;
    try {
      sandbox.destroy();
    } catch (error) {
      this.#log.warn('mermaid sandbox teardown failed', { cause, error: errorName(error instanceof Error ? error : null) });
    }
  }
}

/** Error text for the log: a class name, never a message that quotes input. */
function errorName(error: Error | null): string {
  return describeError(error).name;
}
