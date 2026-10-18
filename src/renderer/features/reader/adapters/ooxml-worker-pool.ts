import type { ParsedDocxPayload } from './docx-parse-core';

/**
 * DOCX and PPTX packages are parsed in short-lived dedicated workers. Both
 * formats share one slot pool so opening several Office documents at once
 * never runs more than two decompress-and-parse jobs concurrently.
 */
const MAX_ACTIVE_OOXML_WORKERS = 2;
const OOXML_PARSE_TIMEOUT_MS = 30_000;

export type OoxmlParseResponse =
  | { readonly ok: true; readonly payload: ParsedDocxPayload }
  | { readonly ok: false; readonly message: string };

type OoxmlWaiter = {
  resolve(): void;
  reject(error: DOMException): void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

let activeWorkers = 0;
const waiters: OoxmlWaiter[] = [];

async function acquireSlot(label: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeWorkers < MAX_ACTIVE_OOXML_WORKERS) {
    activeWorkers += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: OoxmlWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
    const onAbort = (): void => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new DOMException(`${label} parsing was cancelled.`, 'AbortError'));
    };
    if (signal) {
      Object.assign(waiter, { onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve();
  } else {
    activeWorkers -= 1;
  }
}

export async function parseOoxmlInWorker(
  createWorker: () => Worker,
  label: 'DOCX' | 'PPTX',
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<ParsedDocxPayload> {
  await acquireSlot(label, signal);
  try {
    signal?.throwIfAborted();
    return await new Promise<ParsedDocxPayload>((resolve, reject) => {
      const worker = createWorker();
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        callback();
      };
      const timeout = globalThis.setTimeout(() => {
        finish(() => {
          reject(new Error(`${label} parsing timed out safely.`));
        });
      }, OOXML_PARSE_TIMEOUT_MS);
      const onAbort = (): void => {
        finish(() => {
          reject(new DOMException(`${label} parsing was cancelled.`, 'AbortError'));
        });
      };
      worker.onmessage = (event: MessageEvent<OoxmlParseResponse>): void => {
        finish(() => {
          if (event.data.ok) resolve(event.data.payload);
          else reject(new Error(event.data.message));
        });
      };
      worker.onerror = (): void => {
        finish(() => {
          reject(new Error(`${label} parser worker failed safely.`));
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const transferable =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();
      worker.postMessage({ bytes: transferable }, [transferable.buffer as ArrayBuffer]);
    });
  } finally {
    releaseSlot();
  }
}
