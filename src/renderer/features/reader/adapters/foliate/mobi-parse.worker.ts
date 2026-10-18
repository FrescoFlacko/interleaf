import { CustomEvent, DOMParser, EventTarget } from 'linkedom/worker';

import type { ParsedMobiPayload } from './mobi-parse-core';
import type { DedicatedWorkerScope } from '../worker-scope';

type ParseRequest = { readonly bytes: Uint8Array };

/** What this worker answers with. The MOBI adapter reads the same protocol. */
export type MobiParseResponse =
  | { readonly ok: true; readonly payload: ParsedMobiPayload }
  | { readonly ok: false; readonly message: string };

const baseDocument = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
type WorkerElement = {
  innerHTML: string;
  readonly textContent: string | null;
  toString(): string;
};
const textareaDocument = {
  createElement: (tagName: string): WorkerElement | { innerHTML: string; readonly value: string } => {
    if (tagName.toLowerCase() !== 'textarea') {
      return baseDocument.createElement(tagName, undefined) as WorkerElement;
    }
    const proxy = baseDocument.createElement('p', undefined) as WorkerElement;
    return {
      set innerHTML(value: string) { proxy.innerHTML = value; },
      get value(): string { return proxy.textContent ?? ''; },
    };
  },
};
class WorkerXMLSerializer {
  // linkedom's nodes serialize themselves, which is the whole reason this
  // stand-in exists: the worker has no DOM `XMLSerializer`.
  serializeToString(node: { toString(): string }): string {
    return node.toString();
  }
}

Object.assign(globalThis, {
  DOMParser,
  XMLSerializer: WorkerXMLSerializer,
  CustomEvent,
  EventTarget,
  document: textareaDocument,
  CSS: {
    escape: (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, (character) =>
      `\\${String(character.codePointAt(0)?.toString(16))} `),
  },
});

const workerScope: DedicatedWorkerScope<ParseRequest, MobiParseResponse> = globalThis;
workerScope.onmessage = (event): void => {
  void (async () => {
    try {
      const { parseMobiArchive } = await import('./mobi-parse-core');
      const payload = await parseMobiArchive(event.data.bytes, { includeResources: true });
      workerScope.postMessage({ ok: true, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MOBI parsing failed';
      workerScope.postMessage({ ok: false, message: message.slice(0, 512) });
    }
  })();
};
