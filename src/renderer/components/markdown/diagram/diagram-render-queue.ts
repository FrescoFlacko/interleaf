import type { CloneableValue } from '@shared/models/portable';
import {
  DIAGRAM_RENDER_TIMEOUT_MS,
  MAX_QUEUED_DIAGRAM_RENDERS,
  parseDiagramResponse,
  sourceLimitFailure,
  type DiagramFailure,
  type DiagramRenderRequest,
  type DiagramRenderSuccess,
} from './diagram-protocol';

type DiagramRenderOutcome =
  | { readonly ok: true; readonly svg: string; readonly width: number; readonly height: number; readonly kind: string }
  | { readonly ok: false; readonly failure: DiagramFailure };

/** The part of a `Worker` the queue uses, so tests can supply their own. */
export type DiagramWorker = {
  onmessage: ((event: MessageEvent<CloneableValue>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DiagramRenderRequest): void;
  terminate(): void;
};

export type DiagramRenderQueueOptions = {
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
  /** A worker left idle this long is terminated; the next render starts a new one. */
  readonly idleMs?: number;
};

type Job = {
  readonly id: number;
  readonly source: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (outcome: DiagramRenderOutcome) => void;
  readonly onAbort: () => void;
};

export type DiagramRenderQueue = {
  render(source: string, signal?: AbortSignal): Promise<DiagramRenderOutcome>;
  /** Terminates the worker and settles every pending render as cancelled. */
  dispose(): void;
};

const DEFAULT_IDLE_MS = 30_000;

function success(response: DiagramRenderSuccess): DiagramRenderOutcome {
  return { ok: true, svg: response.svg, width: response.width, height: response.height, kind: response.kind };
}

/**
 * Runs diagram renders one at a time on a single dedicated worker.
 *
 * A render that outlives its timeout, or whose caller cancels it while it is
 * running, terminates the worker — a parser stuck on hostile input cannot be
 * interrupted any other way — and the next render starts a fresh one. Requests
 * wait in a bounded queue; beyond it they are refused as `busy` rather than
 * piling up. Each response is matched to its request id and validated, so a
 * late answer from a replaced worker is ignored.
 */
export function createDiagramRenderQueue(
  createWorker: () => DiagramWorker,
  options: DiagramRenderQueueOptions = {},
): DiagramRenderQueue {
  const timeoutMs = options.timeoutMs ?? DIAGRAM_RENDER_TIMEOUT_MS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED_DIAGRAM_RENDERS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const waiting: Job[] = [];
  let worker: DiagramWorker | null = null;
  let active: Job | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;

  const stopWorker = (): void => {
    globalThis.clearTimeout(idleTimer);
    idleTimer = undefined;
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  };

  const finish = (job: Job, outcome: DiagramRenderOutcome): void => {
    job.signal?.removeEventListener('abort', job.onAbort);
    job.resolve(outcome);
  };

  const settleActive = (outcome: DiagramRenderOutcome, terminate: boolean): void => {
    const job = active;
    if (job === null) return;
    active = null;
    globalThis.clearTimeout(activeTimer);
    if (terminate) stopWorker();
    finish(job, outcome);
    pump();
  };

  const ensureWorker = (): DiagramWorker => {
    if (worker !== null) return worker;
    const created = createWorker();
    created.onmessage = (event): void => {
      if (active === null) return;
      const response = parseDiagramResponse(event.data, active.id);
      if (response === null) return;
      settleActive(response.ok ? success(response) : { ok: false, failure: response.failure }, false);
    };
    created.onerror = (): void => {
      settleActive({ ok: false, failure: 'failed' }, true);
    };
    worker = created;
    return created;
  };

  function pump(): void {
    if (active !== null) return;
    const job = waiting.shift();
    if (job === undefined) {
      globalThis.clearTimeout(idleTimer);
      if (worker !== null) idleTimer = globalThis.setTimeout(stopWorker, idleMs);
      return;
    }
    globalThis.clearTimeout(idleTimer);
    active = job;
    activeTimer = globalThis.setTimeout(() => {
      settleActive({ ok: false, failure: 'timeout' }, true);
    }, timeoutMs);
    try {
      ensureWorker().postMessage({ id: job.id, source: job.source });
    } catch {
      settleActive({ ok: false, failure: 'failed' }, true);
    }
  }

  const cancelled: DiagramRenderOutcome = { ok: false, failure: 'failed' };

  return {
    render(source, signal) {
      const limited = sourceLimitFailure(source);
      if (limited !== null) return Promise.resolve({ ok: false, failure: limited });
      if (signal?.aborted === true) return Promise.resolve(cancelled);
      if (waiting.length >= maxQueued) return Promise.resolve({ ok: false, failure: 'busy' });
      return new Promise<DiagramRenderOutcome>((resolve) => {
        const job: Job = {
          id: nextId++,
          source,
          signal,
          resolve,
          onAbort: () => {
            if (active === job) {
              settleActive(cancelled, true);
              return;
            }
            const index = waiting.indexOf(job);
            if (index >= 0) waiting.splice(index, 1);
            finish(job, cancelled);
          },
        };
        signal?.addEventListener('abort', job.onAbort, { once: true });
        waiting.push(job);
        pump();
      });
    },
    dispose() {
      const pending = active === null ? [...waiting] : [active, ...waiting];
      waiting.length = 0;
      active = null;
      globalThis.clearTimeout(activeTimer);
      stopWorker();
      for (const job of pending) finish(job, cancelled);
    },
  };
}
