import { Worker } from 'node:worker_threads';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { RasterLimits } from '../net/raster-image';
import { RASTER_WORKER_SOURCE } from './raster-container';
import type { PortableValue } from '@shared/models/portable';

export type RasterDecodeResult = {
  /** What the archived bytes are: canonical PNG for every accepted format. */
  readonly mimeType: string;
  /** What the submitted bytes were, decided by the decoder, not by a header. */
  readonly sourceMimeType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly safeBytes: Buffer;
};

export type RasterDecodeWorkerOptions = {
  readonly timeoutMs?: number | undefined;
  readonly deadline?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Test seam: force worker to throw. */
  readonly testWorkerFailure?: boolean | undefined;
  /** Test seam: keep worker alive and idle to exercise timeout and abort. */
  readonly testWorkerHang?: boolean | undefined;
};

const MAX_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_WORKERS = 2;
const MAX_QUEUE = 8;
const DEFAULT_TIMEOUT_MS = 15_000;

type AdmissionWaiter = {
  readonly id: symbol;
  readonly grant: () => void;
};

let activeWorkers = 0;
const waiters: AdmissionWaiter[] = [];
const liveWorkers = new Set<Worker>();

export function rasterDecoderState(): {
  readonly active: number;
  readonly queued: number;
  readonly workers: number;
} {
  return { active: activeWorkers, queued: waiters.length, workers: liveWorkers.size };
}

function cancelledError(): InterleafError {
  return new InterleafError('validation', 'That import was cancelled.');
}

function deadlineError(): InterleafError {
  return new InterleafError(
    'validation',
    'That image took too long to respond, so Interleaf stopped waiting.'
  );
}

function timeoutError(): InterleafError {
  return new InterleafError('internal', 'Image decoding timed out safely.');
}
async function acquire(
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  isDeadline = false
): Promise<void> {
  if (signal?.aborted === true) throw cancelledError();
  if (activeWorkers < MAX_WORKERS) {
    activeWorkers += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUE) {
    throw new InterleafError('internal', 'Image decoding queue is full; retry shortly.');
  }

  await new Promise<void>((resolve, reject) => {
    const id = Symbol('raster-decode-waiter');
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      const idx = waiters.findIndex((w) => w.id === id);
      if (idx !== -1) waiters.splice(idx, 1);
      cleanup();
      reject(cancelledError());
    };

    timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.id === id);
      if (idx !== -1) waiters.splice(idx, 1);
      cleanup();
      reject(isDeadline ? deadlineError() : timeoutError());
    }, timeoutMs);
    timer.unref();

    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push({
      id,
      grant: () => {
        cleanup();
        resolve();
      },
    });
  });
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next.grant();
  } else {
    activeWorkers = Math.max(0, activeWorkers - 1);
  }
}

export async function decodeRasterInWorker(
  buffer: Buffer,
  limits: RasterLimits,
  options: RasterDecodeWorkerOptions = {}
): Promise<RasterDecodeResult | null> {
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_INPUT_BYTES) {
    return null;
  }
  // Nothing here short-circuits on a signature: the isolated worker judges
  // the container by structure before sharp is involved at all
  // (raster-container.ts), so every format is held to the same pre-admission
  // walk, and only the admission bookkeeping lives on this side.

  const signal = options.signal;
  const isCancelled = (): boolean => signal?.aborted === true;
  if (isCancelled()) {
    throw cancelledError();
  }
  const now = Date.now();
  const isDeadline = options.deadline !== undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stopTime =
    options.deadline !== undefined ? Math.min(options.deadline, now + timeoutMs) : now + timeoutMs;

  const remainingForQueue = stopTime - Date.now();
  if (remainingForQueue <= 0) {
    throw isDeadline ? deadlineError() : timeoutError();
  }

  await acquire(signal, remainingForQueue, isDeadline);
  try {
    if (isCancelled()) {
      throw cancelledError();
    }
    const remainingForWorker = stopTime - Date.now();
    if (remainingForWorker <= 0) {
      throw isDeadline ? deadlineError() : timeoutError();
    }
    return await runWorker(buffer, limits, options, remainingForWorker, isDeadline);
  } finally {
    release();
  }
}

function runWorker(
  buffer: Buffer,
  limits: RasterLimits,
  options: RasterDecodeWorkerOptions,
  timeoutMs: number,
  isDeadline: boolean
): Promise<RasterDecodeResult | null> {
  const signal = options.signal;
  const maxDecompressedBytes = limits.maxDecompressedBytes ?? MAX_IMAGE_DECOMPRESSED_BYTES;
  const maxOutputBytes = Math.min(
    options.maxOutputBytes ?? maxDecompressedBytes,
    maxDecompressedBytes
  );

  return new Promise<RasterDecodeResult | null>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelledError());
      return;
    }

    let settled = false;
    const worker = new Worker(RASTER_WORKER_SOURCE, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
      },
      workerData: {
        buffer,
        limits: {
          ...limits,
          maxDecompressedBytes,
        },
        maxInputBytes: MAX_IMAGE_INPUT_BYTES,
        maxOutputBytes,
        testWorkerFailure: options.testWorkerFailure === true,
        testWorkerHang: options.testWorkerHang === true,
      },
    });

    liveWorkers.add(worker);
    worker.once('exit', () => {
      liveWorkers.delete(worker);
    });

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      // The admission slot this request holds is not free until the worker is
      // really gone: the promise settles only after terminate() completes and
      // the exit event confirms the thread is gone, so a timed-out or
      // cancelled decode can never hand its slot to a queued one while the
      // old thread is still dying. The exit listener attaches before
      // terminate() starts, because the event may otherwise fire first.
      const gone = new Promise<void>((exitDone) => {
        worker.once('exit', () => {
          exitDone();
        });
      });
      void worker.terminate().then(() => gone).then(finish, finish);
    };

    const timeout = setTimeout(() => {
      settle(() => {
        reject(isDeadline ? deadlineError() : timeoutError());
      });
    }, timeoutMs);

    const onAbort = (): void => {
      settle(() => {
        reject(cancelledError());
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message: PortableValue) => {
      settle(() => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'ok' in message &&
          message.ok === true &&
          'sourceMimeType' in message &&
          typeof message.sourceMimeType === 'string' &&
          'width' in message &&
          typeof message.width === 'number' &&
          'height' in message &&
          typeof message.height === 'number' &&
          'frameCount' in message &&
          message.frameCount === 1 &&
          'safeBytes' in message &&
          message.safeBytes instanceof Uint8Array
        ) {
          // The archive identity is what this side owns: canonical PNG, one
          // frame, and the source format the decoder reported.
          resolve({
            mimeType: 'image/png',
            sourceMimeType: message.sourceMimeType,
            extension: '.png',
            width: message.width,
            height: message.height,
            frameCount: 1,
            safeBytes: Buffer.from(message.safeBytes),
          });
        } else {
          resolve(null);
        }
      });
    });

    worker.once('error', (error: Error) => {
      settle(() => {
        reject(
          new InterleafError(
            'internal',
            `Raster decode worker failed: ${error.message || 'unknown error'}`
          )
        );
      });
    });
  });
}
