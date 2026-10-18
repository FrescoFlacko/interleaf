import { DOMParser } from 'linkedom/worker';
import type { OoxmlParseResponse } from './ooxml-worker-pool';
import type { DedicatedWorkerScope } from './worker-scope';

type ParseRequest = { readonly bytes: Uint8Array };

Object.assign(globalThis, { DOMParser });

const workerScope: DedicatedWorkerScope<ParseRequest, OoxmlParseResponse> = globalThis;
workerScope.onmessage = (event): void => {
  void (async () => {
    try {
      const { parsePptxArchive } = await import('./pptx-parse-core');
      const payload = parsePptxArchive(event.data.bytes);
      workerScope.postMessage({ ok: true, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PPTX parsing failed';
      workerScope.postMessage({ ok: false, message: message.slice(0, 512) });
    }
  })();
};
