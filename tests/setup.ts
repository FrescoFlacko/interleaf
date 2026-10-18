import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { installTestBridge } from './helpers/interleaf-api';
import { installFramePlatform, installRendererPlatform } from './helpers/renderer-platform';
import { resetAgentFollowUps } from '../src/renderer/stores/agent-follow-up-drafts';

// Production always runs with the preload bridge, so every test does too.
installTestBridge();

// A jsdom file renders as Electron's renderer would, so it has the browser
// APIs that renderer always has. Each test starts with no painted highlights,
// as a freshly loaded page does. Frame windows get the same APIs.
if (typeof window !== 'undefined') {
  installRendererPlatform(window);
  installFramePlatform(window);
  afterEach(() => {
    window.CSS.highlights.clear();
    // A run's follow-up draft lives for the window, as a fresh window's does.
    resetAgentFollowUps();
  });
}

// pdf.js' browser build initializes an identity DOMMatrix at module load time.
// jsdom does not provide the geometry API, while Electron's renderer does.
if (typeof globalThis.DOMMatrix === 'undefined') {
  class TestDOMMatrix {
    readonly a = 1;
    readonly b = 0;
    readonly c = 0;
    readonly d = 1;
    readonly e = 0;
    readonly f = 0;
  }
  Object.defineProperty(globalThis, 'DOMMatrix', {
    configurable: true,
    value: TestDOMMatrix,
  });
}

// Node 22.18 satisfies pdfjs-dist's declared engine range but predates
// Promise.try; Electron 43's Chromium runtime provides it.
/**
 * What pdf.js hands to `Promise.try`: a worker message payload or a stream
 * sink. Naming the argument domain keeps the polyfill's declared arity equal to
 * the arity it is called with, so the forwarded tuple is checked rather than
 * declared impossible.
 */
type PromiseTryArgument = string | number | boolean | null | object;

if (!('try' in Promise)) {
  Object.defineProperty(Promise, 'try', {
    configurable: true,
    value: <TResult, TArgs extends readonly PromiseTryArgument[]>(
      callback: (...args: TArgs) => TResult | PromiseLike<TResult>,
      ...args: TArgs
    ) =>
      new Promise<TResult>((resolve) => {
        resolve(callback(...args));
      }),
  });
}

if (!('toHex' in Uint8Array.prototype)) {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    configurable: true,
    value(this: Uint8Array): string {
      return Array.from(this, (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  });
}
if (!('getOrInsertComputed' in Map.prototype)) {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    configurable: true,
    value<K, V>(this: Map<K, V>, key: K, callback: (key: K) => V): V {
      if (this.has(key)) {
        return this.get(key)!;
      }
      const value = callback(key);
      this.set(key, value);
      return value;
    },
  });
}

if (!('getOrInsert' in Map.prototype)) {
  Object.defineProperty(Map.prototype, 'getOrInsert', {
    configurable: true,
    value<K, V>(this: Map<K, V>, key: K, defaultValue: V): V {
      if (this.has(key)) {
        return this.get(key)!;
      }
      this.set(key, defaultValue);
      return defaultValue;
    },
  });
}

if (typeof globalThis.HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  });
}

// JSDOM does not provide URL.createObjectURL or URL.revokeObjectURL
let blobCounter = 1;
if (typeof globalThis.URL !== 'undefined') {
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:jsdom-blob-${String(blobCounter++)}`,
    });
  }
  if (typeof globalThis.URL.revokeObjectURL !== 'function') {
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: (): void => undefined,
    });
  }
}
if (typeof window !== 'undefined') {
  if (typeof window.URL.createObjectURL !== 'function') {
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:jsdom-blob-${String(blobCounter++)}`,
    });
  }
  if (typeof window.URL.revokeObjectURL !== 'function') {
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: (): void => undefined,
    });
  }
}
