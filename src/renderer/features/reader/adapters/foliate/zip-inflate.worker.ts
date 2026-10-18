import { inflateZipArchive } from './zip-inflate-core';
import type { DedicatedWorkerScope } from '../worker-scope';

type InflateRequest = { readonly bytes: Uint8Array };
type InflateResponse =
  | { readonly ok: true; readonly entries: ReturnType<typeof inflateZipArchive> }
  | { readonly ok: false; readonly message: string };

const workerScope: DedicatedWorkerScope<InflateRequest, InflateResponse> = globalThis;

workerScope.onmessage = (event): void => {
  try {
    const entries = inflateZipArchive(event.data.bytes);
    const transfer = entries.map((entry) => entry.bytes.buffer as ArrayBuffer);
    workerScope.postMessage({ ok: true, entries }, transfer);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Archive parsing failed';
    workerScope.postMessage({ ok: false, message: rawMessage.slice(0, 512) });
  }
};
