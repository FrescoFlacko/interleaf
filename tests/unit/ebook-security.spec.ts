// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { EpubAdapter } from '../../src/renderer/features/reader/adapters/epub-adapter';
import { MobiAdapter } from '../../src/renderer/features/reader/adapters/mobi-adapter';
import { readBoundedResponseBytes } from '../../src/renderer/features/reader/adapters/ebook-base-adapter';
import {
  inlineSafeRasterResources,
  MOBI_PARSE_LIMITS,
  parseMobiArchive,
} from '../../src/renderer/features/reader/adapters/foliate/mobi-parse-core';
import { addDecodedLength, huffcdic } from '../../src/renderer/features/reader/adapters/foliate/upstream/mobi.js';
import { sanitizeEbookHtml } from '../../src/renderer/features/reader/adapters/foliate/sanitize';
import { Paginator } from '../../src/renderer/features/reader/adapters/foliate/paginator';
import { inflateZipArchive } from '../../src/renderer/features/reader/adapters/foliate/zip-inflate-core';
import {
  isSafeArchivePath,
  makeFflateZipLoader,
  ZIP_SAFETY_LIMITS,
} from '../../src/renderer/features/reader/adapters/foliate/zip-loader';
import {
  makeEpubFixture,
  makeKf8Fixture,
  makeMalformedZip64Archive,
  makeMobiFixture,
  strBytes,
} from '../fixtures/document-fixtures';
import type { Annotation } from '../../src/shared/types/annotation';
import { testDocumentSource } from '../helpers/document-source';

const testInflate = (bytes: Uint8Array) => Promise.resolve(inflateZipArchive(bytes));

/**
 * Archive inflation is synchronous, so a parser that failed to terminate would
 * block this worker and no timeout declared inside it could preempt the loop.
 * These runs therefore happen in a separate process whose deadline is enforced
 * here, by the parent, which can kill a child that stops making progress.
 */
const CHILD_DEADLINE_MS = 10_000;
const CHILD_HANG_DEADLINE_MS = 1_000;
const CHILD_TEST_TIMEOUT_MS = 30_000;

type ChildInflateResult = {
  readonly timedOut: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly elapsedMs: number;
};

function runInflateChild(
  mode: 'inflate' | 'hang',
  archive: Uint8Array,
  deadlineMs: number = CHILD_DEADLINE_MS
): Promise<ChildInflateResult> {
  const childPath = join(process.cwd(), 'tests', 'fixtures', 'zip-inflate-child.ts');
  const hooksPath = join(process.cwd(), 'tests', 'fixtures', 'ts-extension-hooks.ts');
  return new Promise<ChildInflateResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', hooksPath, childPath, mode],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({ timedOut, code, signal, stdout, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.end(Buffer.from(archive));
  });
}

const parseMobiForTesting = (bytes: Uint8Array) =>
  parseMobiArchive(bytes, { includeResources: false });

function withHuffRecords(source: Buffer, huff: Buffer, cdic: Buffer): Buffer {
  const sourceRecordCount = source.readUInt16BE(76);
  const sourceOffsets = Array.from({ length: sourceRecordCount }, (_, index) =>
    source.readUInt32BE(78 + index * 8)
  );
  const records: Buffer[] = sourceOffsets.map((start, index) =>
    Buffer.from(source.subarray(start, sourceOffsets[index + 1] ?? source.byteLength))
  );
  const recordZero = records[0];
  if (!recordZero) throw new Error('Test fixture is missing record zero');
  const huffRecordIndex = records.length;
  recordZero.writeUInt16BE(17_480, 0);
  recordZero.writeUInt32BE(huffRecordIndex, 112);
  recordZero.writeUInt32BE(2, 116);
  records.push(huff, cdic);

  const recordTableEnd = 78 + records.length * 8 + 2;
  const output = Buffer.alloc(recordTableEnd + records.reduce((sum, record) => sum + record.byteLength, 0));
  source.copy(output, 0, 0, 78);
  output.writeUInt16BE(records.length, 76);
  let outputOffset = recordTableEnd;
  for (const [index, record] of records.entries()) {
    output.writeUInt32BE(outputOffset, 78 + index * 8);
    output.writeUInt32BE(index, 78 + index * 8 + 4);
    record.copy(output, outputOffset);
    outputOffset += record.byteLength;
  }
  return output;
}

describe('Ebook Security & Adversarial Hardening (ADR-0002, docs/SECURITY.md)', () => {
  it('injects the independent reader background/text pair into the sandboxed iframe', async () => {
    const paginator = new Paginator();
    paginator.element.style.setProperty('--reader-background-override', '#09090b');
    paginator.element.style.setProperty('--reader-foreground-override', '#fafafa');
    const iframe = paginator.element.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const frameDocument = document.implementation.createHTMLDocument('Reader section');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frameDocument });
    await paginator.open({ sections: [{
      id: 'theme-section',
      index: 0,
      load: () => Promise.resolve('<html><head></head><body><p>Theme test</p></body></html>'),
      unload: () => undefined,
    }] });
    const injected = frameDocument.getElementById('interleaf-injected-styles')?.textContent ?? '';
    expect(injected).toContain('background: #09090b !important');
    expect(injected).toContain('color: #fafafa !important');
    paginator.destroy();
  });

  it('reanchors and reports an EPUB highlight inside the script-disabled content document', async () => {
    const adapter = new EpubAdapter(testInflate);
    const container = document.createElement('div');
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-epub-annotation',
      assetUrl: `data:application/epub+zip;base64,${makeEpubFixture().toString('base64')}`,
    }));
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    const frameDocument = document.implementation.createHTMLDocument('EPUB annotation');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frameDocument });
    const body = frameDocument.body;
    body.textContent = 'Before selected ebook quote after.';
    const highlight: Annotation = {
      id: 'epub-highlight',
      documentId: 'doc-epub-annotation',
      documentHash: 'hash',
      type: 'highlight',
      anchor: {
        format: 'epub',
        cfi: 'epubcfi(/6/2)',
        quote: { exact: 'selected ebook quote', prefix: 'Before ', suffix: ' after.' },
        textStart: 0,
        textEnd: 2,
      },
      selectedText: 'selected ebook quote',
      note: null,
      label: null,
      color: 'purple',
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const resolutions = await adapter.setAnnotations([highlight]);
    expect(resolutions[0]).toMatchObject({
      annotationId: 'epub-highlight',
      status: 'anchored',
      stage: 'quote',
      anchor: { textStart: 7, textEnd: 27 },
    });
    await adapter.close();
  });

  it('reanchors and reports a MOBI highlight by section-local text offsets', async () => {
    const adapter = new MobiAdapter(parseMobiForTesting);
    const container = document.createElement('div');
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-mobi-annotation',
      assetUrl: `data:application/x-mobipocket-ebook;base64,${makeMobiFixture().toString('base64')}`,
    }));
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    const frameDocument = document.implementation.createHTMLDocument('MOBI annotation');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frameDocument });
    frameDocument.body.textContent = 'Before selected mobi quote after.';
    const highlight: Annotation = {
      id: 'mobi-highlight',
      documentId: 'doc-mobi-annotation',
      documentHash: 'hash',
      type: 'highlight',
      anchor: {
        format: 'mobi',
        sectionIndex: 0,
        quote: { exact: 'selected mobi quote', prefix: 'Before ', suffix: ' after.' },
        textStart: 0,
        textEnd: 2,
      },
      selectedText: 'selected mobi quote',
      note: null,
      label: null,
      color: 'green',
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const resolutions = await adapter.setAnnotations([highlight]);
    expect(resolutions[0]).toMatchObject({
      annotationId: 'mobi-highlight',
      status: 'anchored',
      stage: 'quote',
      anchor: { sectionIndex: 0, textStart: 7, textEnd: 26 },
    });
    await adapter.close();
  });

  it('marks annotations unanchored when a revised ebook removes their spine item or section', async () => {
    const epub = new EpubAdapter(testInflate);
    const epubContainer = document.createElement('div');
    await epub.open(epubContainer, testDocumentSource({
      documentId: 'doc-epub-shrunk',
      assetUrl: `data:application/epub+zip;base64,${makeEpubFixture().toString('base64')}`,
    }));
    const epubIframe = epubContainer.querySelector('iframe');
    const epubDocument = document.implementation.createHTMLDocument('Shrunk EPUB');
    Object.defineProperty(epubIframe, 'contentDocument', { configurable: true, value: epubDocument });
    const staleEpub: Annotation = {
      id: 'stale-epub',
      documentId: 'doc-epub-shrunk',
      documentHash: 'older-hash',
      type: 'bookmark',
      anchor: {
        format: 'epub',
        cfi: 'epubcfi(/6/2)',
        spineHref: 'removed-chapter.xhtml',
        quote: { exact: '', prefix: '', suffix: '' },
      },
      selectedText: null,
      note: null,
      label: null,
      color: null,
      isLocationNote: false,
      status: 'anchored',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    expect(await epub.setAnnotations([staleEpub])).toEqual([expect.objectContaining({
      annotationId: 'stale-epub',
      status: 'unanchored',
    })]);
    await epub.close();

    const mobi = new MobiAdapter(parseMobiForTesting);
    const mobiContainer = document.createElement('div');
    await mobi.open(mobiContainer, testDocumentSource({
      documentId: 'doc-mobi-shrunk',
      assetUrl: `data:application/x-mobipocket-ebook;base64,${makeMobiFixture().toString('base64')}`,
    }));
    const mobiIframe = mobiContainer.querySelector('iframe');
    const mobiDocument = document.implementation.createHTMLDocument('Shrunk MOBI');
    Object.defineProperty(mobiIframe, 'contentDocument', { configurable: true, value: mobiDocument });
    const staleMobi: Annotation = {
      ...staleEpub,
      id: 'stale-mobi',
      documentId: 'doc-mobi-shrunk',
      anchor: {
        format: 'mobi',
        sectionIndex: 99,
        quote: { exact: '', prefix: '', suffix: '' },
      },
    };
    expect(await mobi.setAnnotations([staleMobi])).toEqual([expect.objectContaining({
      annotationId: 'stale-mobi',
      status: 'unanchored',
    })]);
    await mobi.close();
  });

  it('strips inline <script> tags and blocks script execution in EPUB', async () => {
    const actionMarker = '__interleafEpubScriptExecuted';
    Object.defineProperty(window, actionMarker, {
      value: false,
      writable: true,
      configurable: true,
    });

    const epubBinary = makeEpubFixture({
      title: 'Hostile Script Book',
      maliciousScript: `window.${actionMarker} = true; document.body.setAttribute('data-hacked', 'true');`,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new EpubAdapter(testInflate);

    const dataUrl = `data:application/epub+zip;base64,${epubBinary.toString('base64')}`;
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-epub-malicious-script',
      assetUrl: dataUrl,
    }));

    // Verify script never executed
    expect(window.__interleafEpubScriptExecuted).toBe(false);

    // Verify iframe sandbox does NOT contain allow-scripts
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const sandbox = iframe?.getAttribute('sandbox');
    expect(sandbox).toBe('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    expect(iframe?.srcdoc).toContain('Interleaf ebook reader');
    expect(iframe?.srcdoc).not.toContain('<script');

    await adapter.close();
    document.body.removeChild(container);
    Reflect.deleteProperty(window, actionMarker);
  });

  it('strips inline on* event handlers from EPUB HTML', () => {
    const rawHtml = `
      <div>
        <p>Safe text</p>
        <img src="blob:image" onerror="alert(1)" onload="window.hacked=true" />
        <button onclick="window.hacked=true" onmouseover="window.hacked=true">Click</button>
        <svg onload="alert(1)"><circle r="10"/></svg>
      </div>
    `;

    const sanitized = sanitizeEbookHtml(rawHtml);
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).not.toContain('onload');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('onmouseover');
    expect(sanitized).not.toContain('<button'); // buttons are forbidden tags
  });

  it('neutralizes javascript: and data:text/html URIs in links', () => {
    const rawHtml = `
      <div>
        <a href="javascript:alert(1)">Malicious Link</a>
        <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data link</a>
        <a href="https://example.com/legit">External Link</a>
      </div>
    `;

    const sanitized = sanitizeEbookHtml(rawHtml);
    expect(sanitized).not.toContain('javascript:alert(1)');
    expect(sanitized).not.toContain('data:text/html');
    expect(sanitized).not.toContain('href=');
  });

  it('removes arbitrary CSS, SVG, forms, and SVG data-image payloads', () => {
    const sanitized = sanitizeEbookHtml(`
      <style>@import url(https://attacker.invalid/book.css); body { display:none }</style>
      <p style="background:url(https://attacker.invalid/pixel)">Readable text</p>
      <svg><script>alert(1)</script><foreignObject>active</foreignObject></svg>
      <img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" />
      <form action="https://attacker.invalid"><input name="secret" /></form>
    `);

    expect(sanitized).toContain('Readable text');
    expect(sanitized).not.toContain('<style');
    expect(sanitized).not.toContain('style=');
    expect(sanitized).not.toContain('<svg');
    expect(sanitized).not.toContain('image/svg+xml');
    expect(sanitized).not.toContain('<form');
    expect(sanitized).not.toContain('<input');
    expect(sanitized).not.toContain('attacker.invalid');
  });

  it('permanently strips interactive document media and its resource URLs', () => {
    const sanitized = sanitizeEbookHtml(`
      <p>Readable introduction</p>
      <audio controls src="https://attacker.invalid/audio.mp3">Audio transcript</audio>
      <video controls src="blob:video"><source src="blob:source"><track src="blob:track">Video transcript</video>
      <iframe src="https://attacker.invalid/frame">Frame description</iframe>
      <object data="https://attacker.invalid/object">Object description</object>
      <embed src="https://attacker.invalid/embed">
      <canvas>Canvas description</canvas>
    `);

    expect(sanitized).toContain('Readable introduction');
    for (const tag of ['audio', 'video', 'source', 'track', 'iframe', 'object', 'embed', 'canvas']) {
      expect(sanitized).not.toContain(`<${tag}`);
    }
    expect(sanitized).not.toContain('attacker.invalid');
    expect(sanitized).not.toContain('blob:');
  });

  it('strips remote tracking pixels and external HTTP/HTTPS image sources', () => {
    const rawHtml = `
      <div>
        <p>Book content</p>
        <img src="https://telemetry.attacker.com/tracking-pixel.png" alt="Tracking" />
        <img src="http://insecure.tracker.com/beacon.gif" alt="Beacon" />
        <img src="blob:safe-local-image" alt="Local" />
      </div>
    `;

    const sanitized = sanitizeEbookHtml(rawHtml);
    expect(sanitized).not.toContain('https://telemetry.attacker.com');
    expect(sanitized).not.toContain('http://insecure.tracker.com');
    expect(sanitized).toContain('src="blob:safe-local-image"');
  });

  it('rejects DRM-protected EPUB files with a clear, user-safe error', async () => {
    const drmEpub = makeEpubFixture({
      title: 'DRM Protected EPUB',
      isDrmEncrypted: true,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new EpubAdapter(testInflate);

    const dataUrl = `data:application/epub+zip;base64,${drmEpub.toString('base64')}`;
    await expect(
      adapter.open(container, testDocumentSource({
        documentId: 'doc-epub-drm',
        assetUrl: dataUrl,
      }))
    ).rejects.toThrow('This document appears to be DRM-protected and cannot be opened by Interleaf.');

    await adapter.close();
    document.body.removeChild(container);
  });

  it('fails closed for malformed or font-disguised EPUB encryption descriptors', async () => {
    const descriptors = [
      '<encryption><broken>',
      `<?xml version="1.0"?><encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
        <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
        <enc:CipherData><enc:CipherReference URI="OEBPS/chapter1.xhtml"/></enc:CipherData>
        </enc:EncryptedData></encryption>`,
    ];
    for (const [index, encryptionXml] of descriptors.entries()) {
      const adapter = new EpubAdapter(testInflate);
      const container = document.createElement('div');
      await expect(adapter.open(container, testDocumentSource({
        documentId: `doc-epub-encryption-${String(index)}`,
        assetUrl: `data:application/epub+zip;base64,${makeEpubFixture({ encryptionXml }).toString('base64')}`,
      }))).rejects.toThrow('This document appears to be DRM-protected');
      await adapter.close();
    }
  });

  it('rejects a malformed additional encryption entry beside a valid obfuscated font', async () => {
    const encryptionXml = `<?xml version="1.0"?>
      <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
        xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
        <enc:EncryptedData>
          <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
          <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/reader.ttf"/></enc:CipherData>
        </enc:EncryptedData>
        <EncryptedData>
          <EncryptionMethod Algorithm="unknown"/>
          <CipherData><CipherReference URI="OEBPS/chapter1.xhtml"/></CipherData>
        </EncryptedData>
      </encryption>`;
    const adapter = new EpubAdapter(testInflate);
    await expect(adapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'doc-epub-mixed-encryption',
      assetUrl: `data:application/epub+zip;base64,${makeEpubFixture({
        encryptionXml,
        includeFontResource: true,
      }).toString('base64')}`,
    }))).rejects.toThrow('This document appears to be DRM-protected');
    await adapter.close();

    const validFontOnly = encryptionXml.replace(/\s*<EncryptedData>[\s\S]*?<\/EncryptedData>/, '');
    const malformedNesting = validFontOnly.replace(
      '<enc:CipherData><enc:CipherReference URI="OEBPS/fonts/reader.ttf"/></enc:CipherData>',
      '<enc:CipherData></enc:CipherData><enc:CipherReference URI="OEBPS/fonts/reader.ttf"/>'
    );
    const malformedNestingAdapter = new EpubAdapter(testInflate);
    await expect(malformedNestingAdapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'doc-epub-malformed-encryption-nesting',
      assetUrl: `data:application/epub+zip;base64,${makeEpubFixture({
        encryptionXml: malformedNesting,
        includeFontResource: true,
      }).toString('base64')}`,
    }))).rejects.toThrow('This document appears to be DRM-protected');
    await malformedNestingAdapter.close();

    const validAdapter = new EpubAdapter(testInflate);
    await expect(validAdapter.open(document.createElement('div'), testDocumentSource({
      documentId: 'doc-epub-valid-font-obfuscation',
      assetUrl: `data:application/epub+zip;base64,${makeEpubFixture({
        encryptionXml: validFontOnly,
        includeFontResource: true,
      }).toString('base64')}`,
    }))).resolves.toBeUndefined();
    await validAdapter.close();
  });

  it('rejects DRM-protected MOBI files with a clear, user-safe error', async () => {
    const drmMobi = makeMobiFixture({
      title: 'DRM Protected MOBI',
      isDrmEncrypted: true,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new MobiAdapter(parseMobiForTesting);

    const dataUrl = `data:application/x-mobipocket-ebook;base64,${drmMobi.toString('base64')}`;
    await expect(
      adapter.open(container, testDocumentSource({
        documentId: 'doc-mobi-drm',
        assetUrl: dataUrl,
      }))
    ).rejects.toThrow('This document appears to be DRM-protected and cannot be opened by Interleaf.');

    await adapter.close();
    document.body.removeChild(container);
  });

  it('detects and rejects archive path traversal entries', async () => {
    expect(isSafeArchivePath('OEBPS/chapter1.xhtml')).toBe(true);
    expect(isSafeArchivePath('styles/main.css')).toBe(true);
    expect(isSafeArchivePath('../escape.txt')).toBe(false);
    expect(isSafeArchivePath('OEBPS/../../etc/passwd')).toBe(false);
    expect(isSafeArchivePath('/root/file.txt')).toBe(false);
    expect(isSafeArchivePath('..')).toBe(false);

    const traversalEpub = makeEpubFixture({
      includePathTraversalEntry: true,
    });

    await expect(makeFflateZipLoader(traversalEpub, testInflate)).rejects.toThrow(
      'Archive contains an unsafe entry path'
    );
  });

  it('rejects a declared zip bomb before inflating the entry', async () => {
    const archive = Buffer.from(zipSync({ 'large.bin': strBytes('x') }, { level: 0 }));
    const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const centralDirectoryOffset = archive.indexOf(centralDirectorySignature);
    expect(centralDirectoryOffset).toBeGreaterThanOrEqual(0);
    archive.writeUInt32LE(
      ZIP_SAFETY_LIMITS.maxSingleEntryBytes + 1,
      centralDirectoryOffset + 24
    );

    await expect(makeFflateZipLoader(archive, testInflate)).rejects.toThrow(
      'Archive entry exceeds the maximum uncompressed size'
    );
  });

  it('terminates on a malformed ZIP64 archive instead of looping (GHSA-px8p-9vwx-vf98)', async () => {
    const result = await runInflateChild('inflate', makeMalformedZip64Archive());

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout.trim())).toEqual({
      outcome: 'threw',
      message: expect.stringContaining('Failed to unzip archive'),
    });
  }, CHILD_TEST_TIMEOUT_MS);

  it('inflates a valid archive through the same isolated child harness', async () => {
    const result = await runInflateChild('inflate', zipSync({ 'a.txt': strBytes('hi') }));

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      outcome: 'returned',
      filenames: ['a.txt'],
    });
  }, CHILD_TEST_TIMEOUT_MS);

  it('kills a child that never returns within the parent-enforced deadline', async () => {
    // Proves the bound belongs to the parent rather than to the blocked child:
    // this fixture spins without yielding, exactly as a non-terminating parser
    // would, so an in-worker timeout could never fire.
    const result = await runInflateChild('hang', new Uint8Array(), CHILD_HANG_DEADLINE_MS);

    expect(result.stdout.trim()).toBe(JSON.stringify({ outcome: 'hanging' }));
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
    expect(result.elapsedMs).toBeLessThan(CHILD_DEADLINE_MS);
  }, CHILD_TEST_TIMEOUT_MS);

  it('strips scripts and event handlers in MOBI documents', async () => {
    const mobiBinary = makeMobiFixture({
      title: 'Hostile MOBI',
      maliciousScript: 'window.__mobiHacked = true;',
      maliciousEventHandler: 'onload="window.__mobiHacked = true"',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const adapter = new MobiAdapter(parseMobiForTesting);

    const dataUrl = `data:application/x-mobipocket-ebook;base64,${mobiBinary.toString('base64')}`;
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-mobi-malicious',
      assetUrl: dataUrl,
    }));

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(iframe?.srcdoc).toContain('Adversarial MOBI Event Handler');
    expect(iframe?.srcdoc).not.toContain('<script');
    expect(iframe?.srcdoc).not.toContain('onload=');
    expect(iframe?.srcdoc).not.toContain('__mobiHacked');
    await adapter.close();
    document.body.removeChild(container);
  });

  it('DOMPurifies a MOBI worker payload before assigning active-section srcdoc', async () => {
    const unsafeParse = () => Promise.resolve({
      sections: [{
        id: 'hostile-worker-section',
        size: 128,
        markup: '<html><body><p onmouseover="window.__workerPayloadEscape=true">Worker payload</p><script>window.__workerPayloadEscape=true</script></body></html>',
      }],
      toc: [],
      metadata: {},
      hrefTargets: [],
    });
    const adapter = new MobiAdapter(unsafeParse);
    const container = document.createElement('div');
    await adapter.open(container, testDocumentSource({
      documentId: 'doc-mobi-worker-payload',
      assetUrl: `data:application/x-mobipocket-ebook;base64,${makeMobiFixture().toString('base64')}`,
    }));
    const srcdoc = container.querySelector('iframe')?.srcdoc ?? '';
    expect(srcdoc).toContain('Worker payload');
    expect(srcdoc).not.toContain('<script');
    expect(srcdoc).not.toContain('onmouseover');
    expect(srcdoc).not.toContain('__workerPayloadEscape');
    await adapter.close();
  });

  it('rejects malformed HUFF tables and active zero-mask definitions in a real KF8 TAGX', async () => {
    const huff = Buffer.alloc(16);
    huff.write('HUFF', 0, 'ascii');
    huff.writeUInt32BE(0xfffffff0, 8);
    huff.writeUInt32BE(0xfffffff0, 12);
    const cdic = Buffer.alloc(16);
    cdic.write('CDIC', 0, 'ascii');
    const badHuff = withHuffRecords(makeMobiFixture({ title: 'Malformed HUFF MOBI' }), huff, cdic);
    await expect(parseMobiForTesting(new Uint8Array(badHuff))).rejects.toThrow(
      'Invalid HUFF table bounds'
    );

    const badTagx = makeKf8Fixture();
    let searchOffset = 0;
    let mutatedDefinitions = 0;
    while (searchOffset < badTagx.byteLength) {
      const tagxOffset = badTagx.indexOf(Buffer.from('TAGX'), searchOffset);
      if (tagxOffset < 0) break;
      const tagxLength = badTagx.readUInt32BE(tagxOffset + 4);
      if (
        tagxLength >= 12 &&
        tagxLength <= 16_396 &&
        tagxOffset + tagxLength <= badTagx.byteLength &&
        (tagxLength - 12) % 4 === 0
      ) {
        for (let entry = tagxOffset + 12; entry < tagxOffset + tagxLength; entry += 4) {
          if (((badTagx[entry + 3] ?? 1) & 1) === 0) {
            badTagx[entry + 2] = 0;
            mutatedDefinitions += 1;
          }
        }
      }
      searchOffset = tagxOffset + 4;
    }
    expect(mutatedDefinitions).toBeGreaterThan(0);
    await expect(parseMobiForTesting(new Uint8Array(badTagx))).rejects.toThrow(
      'Invalid TAGX tag definition'
    );
  });

  it('rejects malformed CDIC and declared KF8 FDST structures', async () => {
    const validTables = Buffer.alloc(1_296);
    validTables.write('HUFF', 0, 'ascii');
    validTables.writeUInt32BE(16, 8);
    validTables.writeUInt32BE(1_040, 12);
    const badCdic = Buffer.alloc(16);
    badCdic.write('CDIC', 0, 'ascii');
    badCdic.writeUInt32BE(16, 4);
    badCdic.writeUInt32BE(1, 8);
    badCdic.writeUInt32BE(0, 12);
    const malformedDictionary = withHuffRecords(
      makeMobiFixture({ title: 'Malformed CDIC MOBI' }),
      validTables,
      badCdic
    );
    await expect(parseMobiForTesting(new Uint8Array(malformedDictionary))).rejects.toThrow(
      'Invalid CDIC bounds'
    );

    const badFdst = makeKf8Fixture();
    const fdstOffset = badFdst.indexOf(Buffer.from('FDST'));
    expect(fdstOffset).toBeGreaterThanOrEqual(0);
    badFdst.writeUInt32BE(0xfffffff, fdstOffset + 8);
    await expect(parseMobiForTesting(new Uint8Array(badFdst))).rejects.toThrow(
      'FDST table exceeds safety limit'
    );
  });

  it('caps per-record HUFF expansion and cumulative decoded MOBI output', async () => {
    const huff = Buffer.alloc(1_296);
    huff.write('HUFF', 0, 'ascii');
    huff.writeUInt32BE(16, 8);
    huff.writeUInt32BE(1_040, 12);
    for (let offset = 16; offset < 1_040; offset += 4) {
      huff.writeUInt32BE(0x81, offset); // found, one-bit code, dictionary entry zero
    }
    const dictionaryValueLength = 0x7fff;
    const cdic = Buffer.alloc(16 + 2 + 2 + dictionaryValueLength);
    cdic.write('CDIC', 0, 'ascii');
    cdic.writeUInt32BE(16, 4);
    cdic.writeUInt32BE(1, 8);
    cdic.writeUInt32BE(1, 12);
    cdic.writeUInt16BE(2, 16);
    cdic.writeUInt16BE(0x8000 | dictionaryValueLength, 18);

    const exactBuffer = (buffer: Buffer): ArrayBuffer =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const decompress = await huffcdic(
      { huffcdic: 0, numHuffcdic: 2 },
      (index) => Promise.resolve(exactBuffer(index === 0 ? huff : cdic))
    );
    expect(() => decompress(new Uint8Array(33))).toThrow('Decoded MOBI record exceeds safety limit');
    expect(() => addDecodedLength(128 * 1024 * 1024 - 4, 5)).toThrow(
      'Decoded MOBI data exceeds safety limit'
    );
  });

  it('removes MOBI image sources whose resource bytes are not a safe raster format', async () => {
    const payload = await parseMobiArchive(
      makeMobiFixture({
        title: 'Disguised MOBI Image',
        rasterResource: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      }),
      { includeResources: true }
    );
    const parsed = new DOMParser().parseFromString(payload.sections[0]?.markup ?? '', 'text/html');
    const image = parsed.querySelector('img[alt="Embedded MOBI raster"]');
    expect(image).not.toBeNull();
    expect(image?.hasAttribute('src')).toBe(false);
  });

  it('materializes KF8 kindle:embed rasters and enforces resource and aggregate image caps', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const loadResource = vi.fn(() => Promise.resolve(new Uint8Array(png)));
    const safeMarkup = await inlineSafeRasterResources(
      '<html><body><img src="kindle:embed:1" alt="KF8 raster"></body></html>',
      { rasterBytes: 0 },
      loadResource
    );
    expect(loadResource).toHaveBeenCalledWith(0);
    expect(safeMarkup).toContain('src="data:image/png;base64,');

    const directBudget = { rasterBytes: 0 };
    const directSafeMarkup = await inlineSafeRasterResources(
      `<html><body><img src="data:image/png;base64,${png.toString('base64')}" alt="direct safe"></body></html>`,
      directBudget
    );
    expect(directSafeMarkup).toContain('src="data:image/png;base64,');
    expect(directBudget.rasterBytes).toBe(png.byteLength);

    const disguisedMarkup = await inlineSafeRasterResources(
      '<html><body><img src="data:image/png;base64,PHN2Zy8+" alt="disguised SVG"></body></html>',
      { rasterBytes: 0 }
    );
    expect(new DOMParser().parseFromString(disguisedMarkup, 'text/html').querySelector('img')?.hasAttribute('src'))
      .toBe(false);

    const oversizedMarkup = await inlineSafeRasterResources(
      '<html><body><img src="kindle:embed:1" alt="oversized"></body></html>',
      { rasterBytes: 0 },
      () => Promise.resolve(new Uint8Array(MOBI_PARSE_LIMITS.maxResourceBytes + 1))
    );
    expect(new DOMParser().parseFromString(oversizedMarkup, 'text/html').querySelector('img')?.hasAttribute('src'))
      .toBe(false);

    const exhaustedMarkup = await inlineSafeRasterResources(
      '<html><body><img src="kindle:embed:1" alt="aggregate"></body></html>',
      { rasterBytes: MOBI_PARSE_LIMITS.maxBookRasterBytes },
      loadResource
    );
    expect(new DOMParser().parseFromString(exhaustedMarkup, 'text/html').querySelector('img')?.hasAttribute('src'))
      .toBe(false);

    const imageFlood = `<html><body>${Array.from(
      { length: 257 },
      (_, index) => index === 256
        ? `<img src="data:image/png;base64,${png.toString('base64')}" alt="overflow">`
        : '<img alt="bounded">'
    ).join('')}</body></html>`;
    const boundedImages = new DOMParser().parseFromString(
      await inlineSafeRasterResources(imageFlood, { rasterBytes: 0 }),
      'text/html'
    ).querySelectorAll('img');
    expect(boundedImages).toHaveLength(257);
    expect(boundedImages[256]?.hasAttribute('src')).toBe(false);
  });

  it('aborts a superseded EPUB inflation before starting the replacement open', async () => {
    const epubBytes = makeEpubFixture({ title: 'Abortable EPUB' });
    let calls = 0;
    let firstAborted = false;
    const controlledInflate = (bytes: Uint8Array, signal?: AbortSignal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(inflateZipArchive(bytes));
      return new Promise<ReturnType<typeof inflateZipArchive>>((_, reject) => {
        const abort = (): void => {
          firstAborted = true;
          reject(new DOMException('cancelled', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };
    const adapter = new EpubAdapter(controlledInflate);
    const container = document.createElement('div');
    const assetUrl = `data:application/epub+zip;base64,${epubBytes.toString('base64')}`;
    const staleOpen = adapter.open(container, testDocumentSource({ documentId: 'stale-epub', assetUrl }));
    await vi.waitFor(() => { expect(calls).toBe(1); });
    const currentOpen = adapter.open(container, testDocumentSource({ documentId: 'current-epub', assetUrl }));
    await Promise.all([staleOpen, currentOpen]);
    expect(firstAborted).toBe(true);
    expect(adapter.getPageCount()).toBeGreaterThan(0);
    await adapter.close();
  });

  it('aborts a superseded MOBI parse and an in-progress parse on close', async () => {
    const mobiBytes = makeMobiFixture({ title: 'Abortable MOBI' });
    let calls = 0;
    let abortedJobs = 0;
    const controlledParse = (bytes: Uint8Array, signal?: AbortSignal) => {
      calls += 1;
      if (calls === 2) return parseMobiArchive(bytes, { includeResources: false });
      return new Promise<Awaited<ReturnType<typeof parseMobiArchive>>>((_, reject) => {
        const abort = (): void => {
          abortedJobs += 1;
          reject(new DOMException('cancelled', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };
    const adapter = new MobiAdapter(controlledParse);
    const container = document.createElement('div');
    const assetUrl = `data:application/x-mobipocket-ebook;base64,${mobiBytes.toString('base64')}`;
    const staleOpen = adapter.open(container, testDocumentSource({ documentId: 'stale-mobi', assetUrl }));
    await vi.waitFor(() => { expect(calls).toBe(1); });
    const currentOpen = adapter.open(container, testDocumentSource({ documentId: 'current-mobi', assetUrl }));
    await Promise.all([staleOpen, currentOpen]);
    expect(abortedJobs).toBe(1);

    const closingOpen = adapter.open(container, testDocumentSource({ documentId: 'closing-mobi', assetUrl }));
    await vi.waitFor(() => { expect(calls).toBe(3); });
    await adapter.close();
    await closingOpen;
    expect(abortedJobs).toBe(2);
  });

  it('loads real scoped interleaf-media ebook URLs instead of treating them as data URLs', async () => {
    const mobiBinary = makeMobiFixture({ title: 'Scoped Media MOBI' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(mobiBinary), {
        headers: { 'content-length': String(mobiBinary.byteLength) },
      })
    );
    const container = document.createElement('div');
    const adapter = new MobiAdapter(parseMobiForTesting);

    await adapter.open(container, testDocumentSource({
      documentId: 'doc-mobi-scoped-media',
      assetUrl: 'interleaf-media://asset/opaque-capability',
    }));

    expect(fetchMock).toHaveBeenCalledWith(
      'interleaf-media://asset/opaque-capability',
      expect.objectContaining({ cache: 'no-store', credentials: 'omit' })
    );
    expect(adapter.getPageCount()).toBeGreaterThan(0);
    await adapter.close();
    fetchMock.mockRestore();
  });

  it('cancels a streamed ebook response as soon as its byte cap is crossed', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(readBoundedResponseBytes(response, 4)).rejects.toThrow(
      'This ebook is too large to open safely.'
    );
  });
});
