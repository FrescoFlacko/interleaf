import { Worker } from 'node:worker_threads';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { PortableValue } from '@shared/models/portable';

export type HashIdentity = {
  readonly device: number;
  readonly inode: number;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly fileCtimeMs?: number | undefined;
};

export type HashFileWorkerOptions = {
  /** Bounded test seam; production uses the conservative ten-minute limit. */
  readonly timeoutMs?: number;
  /** Safe diagnostic noun; never includes a caller-provided path or content. */
  readonly label?: 'document' | 'executable';
  /** Test-only seam for exercising worker failure handling without a real fault. */
  readonly testWorkerFailure?: 'error' | 'exit';
  /** Test-only seam for exercising worker concurrency and queue scheduling deterministically. */
  readonly testWorkerDelayMs?: number;
};

const MAX_HASH_WORKERS = 2;
/**
 * Keep the main-process backlog bounded. A renderer can request validation
 * repeatedly, but it must not be able to retain an unbounded set of closures
 * waiting for worker slots.
 */
export const MAX_HASH_QUEUE = 8;
const HASH_TIMEOUT_MS = 10 * 60 * 1000;
let activeWorkers = 0;
const waiters: (() => void)[] = [];
const inFlight = new Map<string, Promise<string>>();

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { open, lstat, stat } = require('node:fs/promises');

if (workerData.testWorkerFailure === 'error') throw new Error('test worker failure');
if (workerData.testWorkerFailure === 'exit') process.exit(17);

(async () => {
  if (typeof workerData.testWorkerDelayMs === 'number' && workerData.testWorkerDelayMs > 0) {
    await new Promise((resolve) => { setTimeout(resolve, workerData.testWorkerDelayMs); });
  }
  let handle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await open(workerData.filePath, constants.O_RDONLY | noFollow);
    const [openedBefore, leafBefore, pathBefore] = await Promise.all([
      handle.stat(),
      lstat(workerData.filePath),
      stat(workerData.filePath),
    ]);
    const expected = workerData.expected;
    if (
      !openedBefore.isFile() || leafBefore.isSymbolicLink() ||
      openedBefore.dev !== expected.device || openedBefore.ino !== expected.inode ||
      pathBefore.dev !== expected.device || pathBefore.ino !== expected.inode ||
      openedBefore.size !== expected.fileSize ||
      Math.round(openedBefore.mtimeMs) !== expected.fileMtimeMs ||
      (typeof expected.fileCtimeMs === 'number' && Math.round(openedBefore.ctimeMs) !== expected.fileCtimeMs)
    ) throw new Error('identity');

    const hash = createHash('sha256');
    const stream = handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) hash.update(chunk);

    const [openedAfter, leafAfter, pathAfter] = await Promise.all([
      handle.stat(),
      lstat(workerData.filePath),
      stat(workerData.filePath),
    ]);
    if (
      leafAfter.isSymbolicLink() ||
      openedAfter.dev !== expected.device || openedAfter.ino !== expected.inode ||
      pathAfter.dev !== expected.device || pathAfter.ino !== expected.inode ||
      openedAfter.size !== expected.fileSize ||
      Math.round(openedAfter.mtimeMs) !== expected.fileMtimeMs ||
      (typeof expected.fileCtimeMs === 'number' && Math.round(openedAfter.ctimeMs) !== expected.fileCtimeMs)
    ) throw new Error('changed');
    parentPort.postMessage({ ok: true, digest: hash.digest('hex').toLowerCase() });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
})();
`;

async function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < MAX_HASH_WORKERS) {
    activeWorkers += 1;
    return;
  }
  if (waiters.length >= MAX_HASH_QUEUE) {
    throw new InterleafError('internal', 'File verification is busy; try again shortly.');
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function releaseWorkerSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    activeWorkers -= 1;
  }
}

function hashFileInWorkerUnshared(
  filePath: string,
  expected: HashIdentity,
  options?: HashFileWorkerOptions,
): Promise<string> {
  return (async () => {
    await acquireWorkerSlot();
    try {
      const label = options?.label ?? 'document';
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: {
            filePath,
            expected,
            testWorkerFailure: options?.testWorkerFailure,
            testWorkerDelayMs: options?.testWorkerDelayMs,
          },
        });
        const timeout = setTimeout(() => {
          settled = true;
          void worker.terminate();
          reject(new InterleafError('internal', `${label[0]?.toUpperCase() ?? 'F'}${label.slice(1)} hashing exceeded its safe time limit.`));
        }, options?.timeoutMs ?? HASH_TIMEOUT_MS);
        timeout.unref();
        worker.once('message', (message: PortableValue) => {
          settled = true;
          clearTimeout(timeout);
          void worker.terminate();
          if (
            typeof message === 'object' &&
            message !== null &&
            'ok' in message &&
            message.ok === true &&
            'digest' in message &&
            typeof message.digest === 'string' &&
            /^[a-f0-9]{64}$/.test(message.digest)
          ) {
            resolve(message.digest);
          } else {
            reject(new InterleafError('validation', 'The selected file changed during hashing.'));
          }
        });
        worker.once('error', () => {
          settled = true;
          clearTimeout(timeout);
          reject(new InterleafError('internal', `The ${label} hashing worker failed safely.`));
        });
        worker.once('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(
            new InterleafError(
              'internal',
              `The ${label} hashing worker exited before completion (${String(code)}).`
            )
          );
        });
      });
    } finally {
      releaseWorkerSlot();
    }
  })();
}

function hashIdentityKey(filePath: string, expected: HashIdentity): string {
  return JSON.stringify([
    filePath,
    expected.device,
    expected.inode,
    expected.fileSize,
    expected.fileMtimeMs,
    expected.fileCtimeMs,
  ]);
}

/**
 * Coalesce identical integrity checks so repeated renderer requests share the
 * same bounded worker/queue entry. Distinct checks remain capped by
 * MAX_HASH_QUEUE above.
 */
export function hashFileInWorker(
  filePath: string,
  expected: HashIdentity,
  options?: HashFileWorkerOptions,
): Promise<string> {
  const key = hashIdentityKey(filePath, expected);
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = hashFileInWorkerUnshared(filePath, expected, options);
  inFlight.set(key, pending);
  void pending.then(
    () => { if (inFlight.get(key) === pending) inFlight.delete(key); },
    () => { if (inFlight.get(key) === pending) inFlight.delete(key); },
  );
  return pending;
}
