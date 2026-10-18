import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { PortableValue } from '@shared/models/portable';

export type RawZipMetadata = {
  readonly title: string | null;
  readonly author: string | null;
};

const MAX_WORKERS = 2;
const fflateModulePath = createRequire(__filename).resolve('fflate');
let activeWorkers = 0;
const waiters: (() => void)[] = [];

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { strFromU8, unzipSync } = require(workerData.fflateModulePath);
try {
  let selectedEntries = 0;
  let selectedOriginalBytes = 0;
  const files = unzipSync(new Uint8Array(workerData.buffer), {
    filter(file) {
      const name = file.name.toLowerCase();
      const metadata = name.endsWith('.opf') || name === 'docprops/core.xml';
      if (!metadata || file.originalSize > 1024 * 1024 || selectedEntries >= 4 ||
          selectedOriginalBytes + file.originalSize > 2 * 1024 * 1024) return false;
      selectedEntries += 1;
      selectedOriginalBytes += file.originalSize;
      return true;
    }
  });
  const text = Object.values(files).map((value) => strFromU8(value)).join('\n');
  const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/i.exec(text)?.[1] ?? null;
  const author = /<dc:creator[^>]*>([^<]+)<\/dc:creator>/i.exec(text)?.[1] ?? null;
  parentPort.postMessage({
    ok: true,
    title: title === null ? null : title.slice(0, 2048),
    author: author === null ? null : author.slice(0, 2048),
  });
} catch {
  parentPort.postMessage({ ok: false });
}
`;

async function acquire(): Promise<void> {
  if (activeWorkers < MAX_WORKERS) {
    activeWorkers += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    activeWorkers -= 1;
  }
}

export async function extractZipMetadataInWorker(buffer: Buffer): Promise<RawZipMetadata> {
  await acquire();
  try {
    return await new Promise<RawZipMetadata>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { buffer, fflateModulePath },
      });
      const timeout = setTimeout(() => {
        settled = true;
        void worker.terminate();
        reject(new InterleafError('internal', 'Archive metadata parsing timed out safely.'));
      }, 30_000);
      timeout.unref();
      worker.once('message', (message: PortableValue) => {
        settled = true;
        clearTimeout(timeout);
        void worker.terminate();
        if (typeof message === 'object' && message !== null && 'ok' in message && message.ok === true) {
          const title = 'title' in message && typeof message.title === 'string' ? message.title : null;
          const author = 'author' in message && typeof message.author === 'string' ? message.author : null;
          resolve({ title, author });
        } else {
          resolve({ title: null, author: null });
        }
      });
      worker.once('error', () => {
        settled = true;
        clearTimeout(timeout);
        reject(new InterleafError('internal', 'Archive metadata parsing failed safely.'));
      });
      worker.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new InterleafError(
            'internal',
            `Archive metadata worker exited before completion (${String(code)}).`
          )
        );
      });
    });
  } finally {
    release();
  }
}
