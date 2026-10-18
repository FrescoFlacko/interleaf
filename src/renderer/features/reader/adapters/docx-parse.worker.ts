import { DOMParser } from 'linkedom/worker';
import type { ParsedDocxPayload } from './docx-parse-core';
import type { DedicatedWorkerScope } from './worker-scope';

type ParseRequest = { readonly bytes: Uint8Array };

/** What this worker answers with. The adapter reads the same protocol. */
type DocxParseResponse =
  | { readonly ok: true; readonly payload: ParsedDocxPayload }
  | { readonly ok: false; readonly message: string };

Object.assign(globalThis, { DOMParser });

const workerScope: DedicatedWorkerScope<ParseRequest, DocxParseResponse> = globalThis;
workerScope.onmessage = (event): void => {
  void (async () => {
    try {
      const { parseDocxArchive } = await import('./docx-parse-core');
      const payload = parseDocxArchive(event.data.bytes);
      workerScope.postMessage({ ok: true, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DOCX parsing failed';
      workerScope.postMessage({ ok: false, message: message.slice(0, 512) });
    }
  })();
};
