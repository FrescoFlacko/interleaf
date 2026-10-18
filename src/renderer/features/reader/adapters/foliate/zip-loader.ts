import ZipInflateWorker from './zip-inflate.worker?worker';
import type { InflatedZipEntry } from './zip-inflate-core';
export { isSafeArchivePath, ZIP_SAFETY_LIMITS } from './zip-loader-limits';

type ZipEntryInfo = {
  readonly filename: string;
  readonly uncompressedSize: number;
};

export type ZipLoader = {
  readonly entries: readonly ZipEntryInfo[];
  loadText(filename: string): Promise<string | null>;
  loadBlob(filename: string, mimeType?: string): Promise<Blob | null>;
  getSize(filename: string): number;
  destroy(): void;
};

export type ZipInflate = (bytes: Uint8Array, signal?: AbortSignal) => Promise<InflatedZipEntry[]>;

/**
 * Converts arbitrary binary input into a Uint8Array view without copying.
 *
 * Uses brand checks (`ArrayBuffer.isView`, byteLength duck-typing) instead of
 * `instanceof` so it stays correct across realms (jsdom tests, worker
 * boundaries) and never references Node Buffer in renderer code.
 */
function toUint8Array(data: Uint8Array | ArrayBuffer | ArrayBufferView | ArrayLike<number>): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if ('byteLength' in data) {
    const ab = data;
    return new Uint8Array(ab, 0, ab.byteLength);
  }
  return Uint8Array.from(data);
}

/**
 * Creates an in-memory ZipLoader after bounded inflation in a dedicated worker.
 */
export async function makeFflateZipLoader(
  data: Uint8Array | ArrayBuffer | ArrayBufferView,
  inflate: ZipInflate = inflateZipArchiveInWorker,
  signal?: AbortSignal
): Promise<ZipLoader> {
  const bytes = toUint8Array(data);
  signal?.throwIfAborted();
  const inflatedEntries = await inflate(bytes, signal);
  signal?.throwIfAborted();

  const entriesMap = new Map<string, Uint8Array>();
  const entriesByLowercasePath = new Map<string, Uint8Array>();
  const entryInfos: ZipEntryInfo[] = [];

  for (const { filename, bytes: entryData } of inflatedEntries) {
    const normalizedKey = filename.replace(/^\.?\//, '');
    entriesMap.set(normalizedKey, entryData);
    entriesByLowercasePath.set(normalizedKey.toLowerCase(), entryData);
    entryInfos.push({
      filename: normalizedKey,
      uncompressedSize: entryData.byteLength,
    });
  }

  const decoder = new TextDecoder('utf-8');

  function findEntryData(filename: string): Uint8Array | undefined {
    const normalizedKey = filename.replace(/^\.?\//, '');
    return entriesMap.get(normalizedKey) ?? entriesByLowercasePath.get(normalizedKey.toLowerCase());
  }

  return {
    entries: entryInfos,

    loadText(filename: string): Promise<string | null> {
      const entryData = findEntryData(filename);
      if (!entryData) return Promise.resolve(null);
      try {
        return Promise.resolve(decoder.decode(entryData));
      } catch {
        return Promise.resolve(null);
      }
    },

    loadBlob(filename: string, mimeType?: string): Promise<Blob | null> {
      const entryData = findEntryData(filename);
      if (!entryData) return Promise.resolve(null);
      return Promise.resolve(
        new Blob([entryData as Uint8Array<ArrayBuffer>], mimeType ? { type: mimeType } : undefined)
      );
    },

    getSize(filename: string): number {
      const entryData = findEntryData(filename);
      return entryData?.byteLength ?? 0;
    },

    destroy(): void {
      entriesMap.clear();
      entriesByLowercasePath.clear();
      entryInfos.length = 0;
    },
  };
}

const MAX_ACTIVE_INFLATE_WORKERS = 2;
const INFLATE_TIMEOUT_MS = 30_000;
let activeInflateWorkers = 0;
type InflateWaiter = {
  resolve(): void;
  reject(error: DOMException): void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};
const inflateWaiters: InflateWaiter[] = [];

async function acquireInflateSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeInflateWorkers < MAX_ACTIVE_INFLATE_WORKERS) {
    activeInflateWorkers += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: InflateWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
    const onAbort = (): void => {
      const index = inflateWaiters.indexOf(waiter);
      if (index >= 0) inflateWaiters.splice(index, 1);
      reject(new DOMException('EPUB archive parsing was cancelled.', 'AbortError'));
    };
    if (signal) {
      Object.assign(waiter, { onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    inflateWaiters.push(waiter);
  });
}

function releaseInflateSlot(): void {
  const next = inflateWaiters.shift();
  if (next) {
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve();
  }
  else activeInflateWorkers -= 1;
}

async function inflateZipArchiveInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<InflatedZipEntry[]> {
  await acquireInflateSlot(signal);
  try {
    signal?.throwIfAborted();
    return await new Promise<InflatedZipEntry[]>((resolve, reject) => {
      const worker = new ZipInflateWorker();
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        callback();
      };
      const timeout = setTimeout(() => {
        finish(() => {
          reject(new Error('EPUB archive parsing timed out safely.'));
        });
      }, INFLATE_TIMEOUT_MS);
      const onAbort = (): void => {
        finish(() => {
          reject(new DOMException('EPUB archive parsing was cancelled.', 'AbortError'));
        });
      };

      worker.onmessage = (event: MessageEvent<
        | { readonly ok: true; readonly entries: InflatedZipEntry[] }
        | { readonly ok: false; readonly message: string }
      >) => {
        finish(() => {
          if (event.data.ok) resolve(event.data.entries);
          else reject(new Error(event.data.message));
        });
      };
      worker.onerror = () => {
        finish(() => {
          reject(new Error('EPUB archive worker failed safely.'));
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
      worker.postMessage({ bytes: transferable }, [transferable.buffer as ArrayBuffer]);
    });
  } finally {
    releaseInflateSlot();
  }
}
