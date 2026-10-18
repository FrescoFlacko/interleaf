// Hardened wrapper around foliate-js MOBI/KF8 parser at commit
// 78914aef4466eb960965702401634c2cb348e9b1.

import MobiParseWorker from './mobi-parse.worker?worker';
import type { MobiParseResponse } from './mobi-parse.worker';
import { sanitizeEbookHtml } from './sanitize';
import type { ParsedMobiPayload, ParsedMobiSection } from './mobi-parse-core';
import type { UpstreamMobiTocItem } from './upstream/mobi.js';

const MAX_MOBI_RECORDS = 20_000;
const MIN_MOBI_HEADER_BYTES = 248;

const readUint16 = (data: Uint8Array, offset: number): number =>
  (((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)) >>> 0;

const readUint32 = (data: Uint8Array, offset: number): number =>
  (
    ((data[offset] ?? 0) << 24) |
    ((data[offset + 1] ?? 0) << 16) |
    ((data[offset + 2] ?? 0) << 8) |
    (data[offset + 3] ?? 0)
  ) >>> 0;

const readAscii = (data: Uint8Array, start: number, end: number): string => {
  let value = '';
  for (const byte of data.subarray(start, end)) value += String.fromCharCode(byte);
  return value;
};

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Rejects malformed envelopes, encrypted books, and attacker-controlled record
 * counts before the upstream parser enters any allocation or iteration loops.
 */
function validateMobiEnvelope(data: Uint8Array): void {
  if (data.byteLength < 86 || readAscii(data, 60, 68) !== 'BOOKMOBI') {
    throw new Error('Invalid MOBI: Missing BOOKMOBI signature');
  }

  const recordCount = readUint16(data, 76);
  if (recordCount < 1 || recordCount > MAX_MOBI_RECORDS) {
    throw new Error('Invalid MOBI: Record count is outside the supported safety limits');
  }
  const tableEnd = 78 + recordCount * 8;
  if (tableEnd > data.byteLength) {
    throw new Error('Invalid MOBI: Truncated record table');
  }

  const offsets: number[] = [];
  for (let index = 0; index < recordCount; index++) {
    offsets.push(readUint32(data, 78 + index * 8));
  }
  for (let index = 0; index < offsets.length; index++) {
    const start = offsets[index];
    const end = offsets[index + 1] ?? data.byteLength;
    if (start === undefined || start < tableEnd || start >= end || end > data.byteLength) {
      throw new Error('Invalid MOBI: Record offsets are malformed');
    }
  }
  for (let index = 0; index < offsets.length; index++) {
    const start = offsets[index];
    const end = offsets[index + 1] ?? data.byteLength;
    if (start === undefined) continue;
    const record = data.subarray(start, end);
    if (record.byteLength >= 20 && readAscii(record, 16, 20) === 'MOBI') {
      if (readUint16(record, 12) !== 0) {
        throw new Error(
          'This document appears to be DRM-protected and cannot be opened by Interleaf.'
        );
      }
    }
  }

  const recordZeroStart = offsets[0];
  const recordZeroEnd = offsets[1] ?? data.byteLength;
  if (recordZeroStart === undefined || recordZeroEnd - recordZeroStart < MIN_MOBI_HEADER_BYTES) {
    throw new Error('Invalid MOBI: Truncated MOBI header');
  }
  const recordZero = data.subarray(recordZeroStart, recordZeroEnd);
  if (readAscii(recordZero, 16, 20) !== 'MOBI') {
    throw new Error('Invalid MOBI: Missing MOBI header');
  }

  const compression = readUint16(recordZero, 0);
  if (compression !== 1 && compression !== 2 && compression !== 17_480) {
    throw new Error('This MOBI compression type is not supported.');
  }
  const textRecordCount = readUint16(recordZero, 8);
  if (textRecordCount < 1 || textRecordCount >= recordCount) {
    throw new Error('Invalid MOBI: Text record count is malformed');
  }
  if (readUint16(recordZero, 12) !== 0) {
    throw new Error(
      'This document appears to be DRM-protected and cannot be opened by Interleaf.'
    );
  }

  const headerLength = readUint32(recordZero, 20);
  if (headerLength < 116 || 16 + headerLength > recordZero.byteLength) {
    throw new Error('Invalid MOBI: Header length is malformed');
  }
  const huffRecord = readUint32(recordZero, 112);
  const huffRecordCount = readUint32(recordZero, 116);
  if (
    compression === 17_480 &&
    (huffRecord >= recordCount ||
      huffRecordCount < 2 ||
      huffRecordCount > 1_024 ||
      huffRecord + huffRecordCount > recordCount)
  ) {
    throw new Error('Invalid MOBI: HUFF/CDIC record bounds are malformed');
  }
}

export type MobiSection = {
  readonly id: string;
  readonly index: number;
  readonly size: number;
  readonly linear?: string;
  readonly load: () => Promise<string>;
  readonly unload: () => void;
  readonly createDocument: () => Promise<Document>;
  readonly resolveHref: (href: string) => string;
};

export type MobiTOCItem = {
  readonly label: string;
  readonly href: string;
  readonly subitems?: MobiTOCItem[];
};

type ResolvedTarget = {
  readonly index: number;
  readonly anchor?: (doc: Document) => Element | Range | null;
};

export type MobiParse = (bytes: Uint8Array, signal?: AbortSignal) => Promise<ParsedMobiPayload>;

const MAX_ACTIVE_MOBI_WORKERS = 2;
const MOBI_PARSE_TIMEOUT_MS = 30_000;
let activeMobiWorkers = 0;
type MobiWaiter = {
  resolve(): void;
  reject(error: DOMException): void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};
const mobiWaiters: MobiWaiter[] = [];

async function acquireMobiWorkerSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeMobiWorkers < MAX_ACTIVE_MOBI_WORKERS) {
    activeMobiWorkers += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: MobiWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
    const onAbort = (): void => {
      const index = mobiWaiters.indexOf(waiter);
      if (index >= 0) mobiWaiters.splice(index, 1);
      reject(new DOMException('MOBI parsing was cancelled.', 'AbortError'));
    };
    if (signal) {
      Object.assign(waiter, { onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    mobiWaiters.push(waiter);
  });
}

function releaseMobiWorkerSlot(): void {
  const next = mobiWaiters.shift();
  if (next) {
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve();
  }
  else activeMobiWorkers -= 1;
}

async function parseMobiInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedMobiPayload> {
  await acquireMobiWorkerSlot(signal);
  try {
    if (signal?.aborted) throw new DOMException('MOBI parsing was cancelled.', 'AbortError');
    return await new Promise<ParsedMobiPayload>((resolve, reject) => {
      const worker = new MobiParseWorker();
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
        callback();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(new DOMException('MOBI parsing was cancelled.', 'AbortError'));
        });
      };
      const timeout = window.setTimeout(() => {
        finish(() => {
          reject(new Error('MOBI parsing timed out safely.'));
        });
      }, MOBI_PARSE_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<MobiParseResponse>) => {
        finish(() => {
          if (event.data.ok) resolve(event.data.payload);
          else reject(new Error(event.data.message));
        });
      };
      worker.onerror = () => {
        finish(() => {
          reject(new Error('MOBI parser worker failed safely.'));
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
      worker.postMessage({ bytes: transferable }, [transferable.buffer as ArrayBuffer]);
    });
  } finally {
    releaseMobiWorkerSlot();
  }
}

export class MOBI {
  private readonly data: Uint8Array;
  private readonly hrefTargets = new Map<string, ResolvedTarget>();
  private readonly parseController = new AbortController();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort = (): void => { this.parseController.abort(); };

  sections: MobiSection[] = [];
  toc: MobiTOCItem[] = [];
  metadata: {
    title?: string;
    creator?: string;
    language?: string;
  } = {};

  constructor(
    data: ArrayBuffer | Uint8Array,
    private readonly parse: MobiParse = parseMobiInWorker,
    signal?: AbortSignal
  ) {
    this.data = toUint8Array(data);
    this.externalSignal = signal;
    if (signal?.aborted) this.parseController.abort();
    else signal?.addEventListener('abort', this.onExternalAbort, { once: true });
  }

  async open(): Promise<this> {
    validateMobiEnvelope(this.data);
    const parsed = await this.parse(this.data, this.parseController.signal);
    this.sections = parsed.sections.map((section, index) => this.wrapSection(section, index));
    for (const target of parsed.hrefTargets) this.hrefTargets.set(target.href, { index: target.index });
    this.toc = this.normalizeToc(parsed.toc);
    if (this.toc.length === 0) {
      this.toc = this.sections.map((section) => ({
        label: `Section ${String(section.index + 1)}`,
        href: section.id,
      }));
    }

    const title = parsed.metadata.title;
    const author = parsed.metadata.author;
    const language = parsed.metadata.language;
    this.metadata = {
      ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
      ...(typeof author === 'string' && author.trim()
        ? { creator: author.trim() }
        : Array.isArray(author) && typeof author[0] === 'string' && author[0].trim()
        ? { creator: author[0].trim() }
        : {}),
      ...(typeof language === 'string' && language.trim() ? { language: language.trim() } : {}),
    };
    return this;
  }

  private wrapSection(section: ParsedMobiSection, index: number): MobiSection {
    const id = section.id;
    let sanitizedMarkup: string | null = null;
    const getSanitizedMarkup = (): string => {
      if (sanitizedMarkup !== null) return sanitizedMarkup;
      const sanitized = sanitizeEbookHtml(section.markup);
      const document = new DOMParser().parseFromString(sanitized, 'text/html');
      sanitizedMarkup = `<!doctype html><html><head><meta charset="utf-8"></head><body>${document.body.innerHTML}</body></html>`;
      return sanitizedMarkup;
    };
    const createDocument = async (): Promise<Document> => {
      await Promise.resolve();
      return new DOMParser().parseFromString(getSanitizedMarkup(), 'text/html');
    };

    return {
      id,
      index,
      size: section.size,
      ...(section.linear ? { linear: section.linear } : {}),
      createDocument,
      load: () => Promise.resolve(getSanitizedMarkup()),
      unload: () => undefined,
      resolveHref: (href) => href,
    };
  }

  private normalizeToc(
    items: readonly UpstreamMobiTocItem[]
  ): MobiTOCItem[] {
    const normalized: MobiTOCItem[] = [];
    for (const [ordinal, item] of items.entries()) {
      const href = item.href ?? '';
      const children = item.subitems ?? item.children ?? [];
      const subitems = this.normalizeToc(children);
      const label = item.label?.trim();
      const title = item.title?.trim();
      const displayLabel = label?.length
        ? label
        : title?.length
        ? title
        : `Section ${String(ordinal + 1)}`;
      normalized.push({
        label: displayLabel,
        href,
        ...(subitems.length > 0 ? { subitems } : {}),
      });
    }
    return normalized;
  }

  resolveHref(href: string): ResolvedTarget | null {
    const stored = this.hrefTargets.get(href);
    if (stored) return stored;
    const match = /^mobi-section-(\d+)$/.exec(href);
    const index = match?.[1] ? Number.parseInt(match[1], 10) - 1 : -1;
    return index >= 0 && index < this.sections.length ? { index } : null;
  }

  splitTOCHref(href: string): [string, string?] {
    const target = this.resolveHref(href);
    return [target ? this.sections[target.index]?.id ?? '' : ''];
  }

  getTOCFragment(): Element | null {
    return null;
  }

  destroy(): void {
    this.parseController.abort();
    this.externalSignal?.removeEventListener('abort', this.onExternalAbort);
    this.hrefTargets.clear();
    this.sections = [];
    this.toc = [];
  }
}
