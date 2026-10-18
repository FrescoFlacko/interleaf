import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { DocumentFormat } from '@shared/types/document';

export type PreviewExtractRequest = {
  readonly format: DocumentFormat;
  /** Bounded in-memory source used for text/archive previews. */
  readonly buffer?: Buffer;
  /** Main-authorized canonical source used by PDF cover range extraction. */
  readonly filePath?: string;
  /** Main-authorized root containing filePath; never supplied by renderer. */
  readonly permittedRoot?: string;
  readonly expectedFileSize?: number | undefined;
  readonly expectedFileMtimeMs?: number | undefined;
  readonly expectedFileCtimeMs?: number | undefined;
  readonly expectedFileDevice?: number | undefined;
  readonly expectedFileInode?: number | undefined;
  readonly targetPageIndex?: number | undefined;
  readonly targetBlockIndex?: number | undefined;
  readonly targetParagraphIndex?: number | undefined;
  readonly targetSpineHref?: string | undefined;
  /** Render page one as a bounded PNG instead of only extracting text. */
  readonly renderCover?: boolean | undefined;
};

export type PreviewExtractResult = {
  readonly snippet: string | null;
  readonly actualPageIndex?: number | undefined;
  readonly actualBlockIndex?: number | undefined;
  readonly actualParagraphIndex?: number | undefined;
  readonly matchedSpineHref?: string | undefined;
  readonly isSpineMatched?: boolean | undefined;
  readonly unsupported?: boolean | undefined;
  readonly coverPng?: Uint8Array | undefined;
  /** Internal diagnostic used to prove range extraction stays bounded. */
  readonly sourceBytesRead?: number | undefined;
  /** Internal diagnostic identifying a rejected hostile range workload. */
  readonly rangeFailureReason?: string | undefined;
};

const MAX_WORKERS = 2;
export const MAX_PREVIEW_QUEUE = 8;
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50MB compressed limit
export const DEFAULT_PREVIEW_TIMEOUT_MS = 5000;

// Resolve from the bundled main module, never process.cwd(): an installed app
// is launched from `/`, where the app's node_modules are not reachable.
const requireFromMain = createRequire(__filename);
const fflateModulePath = requireFromMain.resolve('fflate');
const pdfjsModulePath = requireFromMain.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const canvasModulePath = requireFromMain.resolve('@napi-rs/canvas');

export const MAX_COVER_SNAPSHOT_PIXELS = 1_200_000;
export const MAX_COVER_SNAPSHOT_DIMENSION = 2048;
/** Maximum bytes a file-backed PDF preview may read through range requests. */
export const MAX_PDF_SOURCE_BYTES = 64 * 1024 * 1024;
/** Bounds range scheduling before any additional native Buffer is allocated. */
export const MAX_PDF_RANGE_REQUESTS = 2048;
export const MAX_PDF_PENDING_RANGES = 8;
/** Maximum bytes per file read; a larger contiguous range is read in slices. */
export const MAX_PDF_RANGE_BYTES = 256 * 1024;

let activeWorkers = 0;
const waiters: (() => void)[] = [];

const WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { open: openFile, lstat: lstatFile, realpath: realpathFile } = require('node:fs/promises');",
  "const { resolve: resolvePath, relative: relativePath, isAbsolute: isAbsolutePath } = require('node:path');",
  "",
  "async function run() {",
  "  const { format, buffer, filePath, permittedRoot, expectedFileSize, expectedFileMtimeMs, expectedFileCtimeMs, expectedFileDevice, expectedFileInode, targetPageIndex, targetBlockIndex, targetParagraphIndex, targetSpineHref, renderCover, fflatePath, pdfjsPath, canvasPath } = workerData;",
  "  const uint8 = buffer === undefined ? null : new Uint8Array(buffer);",
  "  const MAX_COVER_PIXELS = 1200000;",
  "  const MAX_COVER_DIMENSION = 2048;",
  "  const MAX_PDF_SOURCE_BYTES = 64 * 1024 * 1024;",
  "  const MAX_PDF_RANGE_REQUESTS = 2048;",
  "  const MAX_PDF_PENDING_RANGES = 8;",
  "  const MAX_PDF_RANGE_BYTES = 256 * 1024;",
  "",
  "  if (format === 'mobi') {",
  "    parentPort.postMessage({ ok: true, unsupported: true, snippet: null });",
  "    return;",
  "  }",
  "",
  "  if (format === 'markdown') {",
  "    try {",
  "      if (!uint8) throw new Error('Markdown preview requires an in-memory source.');",
  "      let text = Buffer.from(uint8).toString('utf-8');",
  "      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);",
  "      if (text.startsWith('---')) {",
  "        const end = text.indexOf('\\n---', 3);",
  "        if (end !== -1) text = text.slice(end + 4);",
  "      }",
  "      const blocks = text.split(/\\r?\\n\\s*\\r?\\n/).map(b => b.trim()).filter(b => b.length > 0);",
  "      if (blocks.length === 0) {",
  "        parentPort.postMessage({ ok: true, snippet: null });",
  "        return;",
  "      }",
  "      const targetIdx = typeof targetBlockIndex === 'number'",
  "        ? Math.max(0, Math.min(blocks.length - 1, targetBlockIndex))",
  "        : 0;",
  "      const rawBlock = blocks[targetIdx] || blocks[0] || '';",
  "      const cleaned = rawBlock",
  "        .replace(/^#+\\s+/gm, '')",
  "        .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')",
  "        .replace(/[*_`~]/g, '')",
  "        .replace(/^>\\s+/gm, '')",
  "        .replace(/\\s+/g, ' ')",
  "        .trim();",
  "      const snippet = cleaned.length > 240 ? cleaned.slice(0, 239).trim() + '…' : cleaned;",
  "      parentPort.postMessage({ ok: true, snippet: snippet.length > 0 ? snippet : null, actualBlockIndex: targetIdx });",
  "    } catch {",
  "      parentPort.postMessage({ ok: true, snippet: null });",
  "    }",
  "    return;",
  "  }",
  "",
  "  if (format === 'pdf') {",
  "    let fileHandle = null;",
  "    try {",
  "      const pdfjs = await import(pdfjsPath);",
  "      let rangeTransport = null;",
  "      let sourceBytesRead = 0;",
  "      let reservedRangeBytes = 0;",
  "      let rangeRequestCount = 0;",
  "      let pendingRangeReads = 0;",
  "      let rangeFailed = false;",
  "      const signalRangeFailure = (reason) => { if (!rangeFailed) { rangeFailed = true; parentPort.postMessage({ ok: true, snippet: null, sourceBytesRead, rangeFailureReason: reason }); } };",
  "      if (filePath !== undefined) {",
  "        if (permittedRoot === undefined) throw new Error('PDF source root is required.');",
  "        const requestedPath = resolvePath(filePath);",
  "        const requestedRoot = resolvePath(permittedRoot);",
  "        if (requestedPath !== filePath || requestedRoot !== permittedRoot || !isAbsolutePath(requestedRoot) || requestedPath.includes('\\0') || requestedRoot.includes('\\0')) throw new Error('PDF source descriptor must be canonical.');",
  "        const canonicalRoot = await realpathFile(requestedRoot);",
  "        const leaf = await lstatFile(requestedPath);",
  "        if (leaf.isSymbolicLink() || !leaf.isFile()) throw new Error('PDF source is not a regular file.');",
  "        const canonicalPath = await realpathFile(requestedPath);",
  "        const relative = relativePath(canonicalRoot, canonicalPath);",
  "        if (!relative || relative === '..' || relative.startsWith('..' + require('node:path').sep) || isAbsolutePath(relative)) throw new Error('PDF source is outside its permitted root.');",
  "        if (canonicalPath !== requestedPath) throw new Error('PDF source symlink is not allowed.');",
  "        fileHandle = await openFile(canonicalPath, 'r');",
  "        const opened = await fileHandle.stat();",
  "        if (!opened.isFile() || (typeof expectedFileSize === 'number' && opened.size !== expectedFileSize) || (typeof expectedFileMtimeMs === 'number' && Math.round(opened.mtimeMs) !== expectedFileMtimeMs) || (typeof expectedFileCtimeMs === 'number' && Math.round(opened.ctimeMs) !== expectedFileCtimeMs) || (typeof expectedFileDevice === 'number' && opened.dev !== expectedFileDevice) || (typeof expectedFileInode === 'number' && opened.ino !== expectedFileInode)) throw new Error('PDF source changed before rendering.');",
  "        const initialLength = Math.min(65536, opened.size);",
  "        const initialChunk = Buffer.allocUnsafe(initialLength);",
  "        const initialRead = await fileHandle.read(initialChunk, 0, initialLength, 0);",
  "        if (initialRead.bytesRead !== initialLength) throw new Error('PDF header range ended early.');",
  "        sourceBytesRead += initialRead.bytesRead;",
  "        rangeTransport = new pdfjs.PDFDataRangeTransport(opened.size, new Uint8Array(initialChunk), true);",
  "        rangeTransport.requestDataRange = (begin, end) => {",
  "          const length = end - begin;",
  "          if (rangeFailed) return;",
  "          if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > opened.size) { signalRangeFailure('invalid-range'); return; }",
  "          // PDF.js groups a stream's adjacent missing chunks into one request and",
  "          // accepts exactly one reply for it, so a large cover image arrives as",
  "          // one range. Serve it with bounded file reads, each charged to the",
  "          // read count, while the source byte budget bounds the whole range.",
  "          const reads = Math.ceil(length / MAX_PDF_RANGE_BYTES);",
  "          if (rangeRequestCount + reads > MAX_PDF_RANGE_REQUESTS) { signalRangeFailure('range-request-count'); return; }",
  "          if (pendingRangeReads >= MAX_PDF_PENDING_RANGES) { signalRangeFailure('pending-range-reads'); return; }",
  "          if (sourceBytesRead + reservedRangeBytes + length > MAX_PDF_SOURCE_BYTES) { signalRangeFailure('source-byte-budget'); return; }",
  "          rangeRequestCount += reads;",
  "          pendingRangeReads += 1;",
  "          reservedRangeBytes += length;",
  "          let chunk;",
  "          try { chunk = Buffer.allocUnsafe(length); } catch { reservedRangeBytes -= length; pendingRangeReads -= 1; signalRangeFailure('range-allocation'); return; }",
  "          const readRange = async () => {",
  "            for (let offset = 0; offset < length; offset += MAX_PDF_RANGE_BYTES) {",
  "              const size = Math.min(MAX_PDF_RANGE_BYTES, length - offset);",
  "              const { bytesRead } = await fileHandle.read(chunk, offset, size, begin + offset);",
  "              if (bytesRead !== size) throw new Error('PDF range ended early.');",
  "              if (rangeFailed) return;",
  "            }",
  "            sourceBytesRead += length;",
  "            rangeTransport.onDataRange(begin, new Uint8Array(chunk));",
  "          };",
  "          void readRange().catch(() => { signalRangeFailure('range-read'); }).finally(() => { reservedRangeBytes -= length; pendingRangeReads -= 1; });",
  "        };",
  "      }",
  "      const loadingTask = pdfjs.getDocument({",
  "        ...(rangeTransport ? { range: rangeTransport, rangeChunkSize: 65536 } : { data: uint8 }),",
  "        disableFontFace: true,",
  "        isEvalSupported: false,",
  "        useSystemFonts: false,",
  "        enableXfa: false,",
  "        disableAutoFetch: true,",
  "        disableStream: true,",
  "        maxImageSize: 1200000,",
  "      });",
  "      const doc = await loadingTask.promise;",
  "      const numPages = doc.numPages;",
  "      if (numPages <= 0) {",
  "        parentPort.postMessage({ ok: true, snippet: null });",
  "        return;",
  "      }",
  "      const requested = typeof targetPageIndex === 'number' ? targetPageIndex : 0;",
  "      const targetPage = Math.min(numPages, Math.max(1, requested + 1));",
  "      const page = await doc.getPage(targetPage);",
  "      if (renderCover) {",
  "        const canvasModule = require(canvasPath);",
  "        const rawViewport = page.getViewport({ scale: 1 });",
  "        const rawWidth = Math.ceil(rawViewport.width);",
  "        const rawHeight = Math.ceil(rawViewport.height);",
  "        if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "        let scale = Math.min(2, MAX_COVER_DIMENSION / rawWidth, MAX_COVER_DIMENSION / rawHeight, Math.sqrt(MAX_COVER_PIXELS / (rawWidth * rawHeight)));",
  "        if (!Number.isFinite(scale) || scale <= 0) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "        let viewport = page.getViewport({ scale });",
  "        let width = Math.ceil(viewport.width);",
  "        let height = Math.ceil(viewport.height);",
  "        for (let attempt = 0; attempt < 4 && width * height > MAX_COVER_PIXELS; attempt++) {",
  "          scale *= Math.sqrt(MAX_COVER_PIXELS / (width * height)) * 0.999;",
  "          viewport = page.getViewport({ scale });",
  "          width = Math.ceil(viewport.width);",
  "          height = Math.ceil(viewport.height);",
  "        }",
  "        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > MAX_COVER_DIMENSION || height > MAX_COVER_DIMENSION || width * height > MAX_COVER_PIXELS) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "        const canvas = canvasModule.createCanvas(width, height);",
  "        const context = canvas.getContext('2d');",
  "        context.save();",
  "        context.fillStyle = '#ffffff';",
  "        context.fillRect(0, 0, width, height);",
  "        context.restore();",
  "        await page.render({ canvasContext: context, viewport, intent: 'display', annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise;",
  "        const png = canvas.toBuffer('image/png');",
  "        if (!png || png.length === 0 || png.length > 4 * 1024 * 1024) {",
  "          parentPort.postMessage({ ok: true, snippet: null });",
  "          return;",
  "        }",
  "        parentPort.postMessage({ ok: true, snippet: null, coverPng: png, sourceBytesRead });",
  "        return;",
  "      }",
  "      const textContent = await page.getTextContent();",
  "      const fullText = textContent.items",
  "        .map(item => ('str' in item ? item.str : ''))",
  "        .join(' ')",
  "        .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '')",
  "        .replace(/\\s+/g, ' ')",
  "        .trim();",
  "      const snippet = fullText.length > 240 ? fullText.slice(0, 239).trim() + '…' : fullText;",
  "      parentPort.postMessage({",
  "        ok: true,",
  "        snippet: snippet.length > 0 ? snippet : null,",
  "        actualPageIndex: targetPage - 1,",
  "      });",
  "    } catch {",
  "      parentPort.postMessage({ ok: true, snippet: null });",
  "    } finally {",
  "      await fileHandle?.close().catch(() => undefined);",
  "    }",
  "    return;",
  "  }",
  "",
  "  if (format === 'docx') {",
  "    try {",
  "      const { strFromU8, unzipSync } = require(fflatePath);",
  "      let selectedEntries = 0;",
  "      let totalDecompressed = 0;",
  "      const MAX_ENTRY_BYTES = 2 * 1024 * 1024;",
  "      const MAX_TOTAL_BYTES = 4 * 1024 * 1024;",
  "",
  "      const files = unzipSync(uint8, {",
  "        filter(file) {",
  "          const name = file.name.toLowerCase();",
  "          if (name !== 'word/document.xml') return false;",
  "          if (file.originalSize > MAX_ENTRY_BYTES || totalDecompressed + file.originalSize > MAX_TOTAL_BYTES || selectedEntries >= 2) return false;",
  "          selectedEntries++;",
  "          totalDecompressed += file.originalSize;",
  "          return true;",
  "        }",
  "      });",
  "",
  "      const xmlBuffer = Object.values(files)[0];",
  "      if (!xmlBuffer) {",
  "        parentPort.postMessage({ ok: true, snippet: null });",
  "        return;",
  "      }",
  "",
  "      const xml = strFromU8(xmlBuffer);",
  "      const pMatches = xml.match(/<w:p[\\s>][\\s\\S]*?<\\/w:p>/g) || [];",
  "      if (pMatches.length === 0) {",
  "        parentPort.postMessage({ ok: true, snippet: null });",
  "        return;",
  "      }",
  "",
  "      const targetIdx = typeof targetParagraphIndex === 'number'",
  "        ? Math.max(0, Math.min(pMatches.length - 1, targetParagraphIndex))",
  "        : 0;",
  "      const targetP = pMatches[targetIdx] || pMatches[0] || '';",
  "      const textMatches = targetP.match(/<w:t[^>]*>([^<]+)<\\/w:t>/g) || [];",
  "      const text = textMatches",
  "        .map(t => t.replace(/<[^>]+>/g, ''))",
  "        .join(' ')",
  "        .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '')",
  "        .replace(/\\s+/g, ' ')",
  "        .trim();",
  "",
  "      const snippet = text.length > 240 ? text.slice(0, 239).trim() + '…' : text;",
  "      parentPort.postMessage({",
  "        ok: true,",
  "        snippet: snippet.length > 0 ? snippet : null,",
  "        actualParagraphIndex: targetIdx,",
  "      });",
  "    } catch {",
  "      parentPort.postMessage({ ok: true, snippet: null });",
  "    }",
  "    return;",
  "  }",
  "",
  "  if (format === 'epub') {",
  "    try {",
  "      const { strFromU8, unzipSync } = require(fflatePath);",
  "      const MAX_ENTRY_BYTES = 2 * 1024 * 1024;",
  "      const MAX_METADATA_BYTES = 1024 * 1024;",
  "      const MAX_MANIFEST_ITEMS = 2048;",
  "",
  "      // Zip entry names are untrusted document data.  Canonicalize only",
  "      // relative paths and reject absolute/protocol paths before",
  "      // using them as fflate filters or joining them to the OPF directory.",
  "      function decodePath(value) {",
  "        let decoded = value.trim();",
  "        for (let i = 0; i < 2; i++) {",
  "          let next;",
  "          try { next = decodeURIComponent(decoded); } catch { return null; }",
  "          if (next === decoded) break;",
  "          decoded = next;",
  "        }",
  "        const fragment = decoded.search(/[?#]/);",
  "        if (fragment >= 0) decoded = decoded.slice(0, fragment);",
  "        decoded = decoded.replace(/\\\\/g, '/');",
  "        if (!decoded || decoded.startsWith('/') || decoded.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.includes('\\0')) return null;",
  "        return decoded;",
  "      }",
  "",
  "      function normalizeZipEntry(value) {",
  "        const decoded = decodePath(value);",
  "        if (!decoded) return null;",
  "        const parts = [];",
  "        for (const part of decoded.split('/')) {",
  "          if (!part || part === '.') continue;",
  "          // Parent segments are allowed only when they remain within the",
  "          // archive root; an underflow is an unsafe traversal.",
  "          if (part === '..') {",
  "            if (parts.length === 0) return null;",
  "            parts.pop();",
  "            continue;",
  "          }",
  "          parts.push(part);",
  "        }",
  "        return parts.length > 0 ? parts.join('/') : null;",
  "      }",
  "",
  "      function resolveRelative(baseDir, href) {",
  "        const decoded = decodePath(href);",
  "        if (!decoded) return null;",
  "        return normalizeZipEntry(baseDir + decoded);",
  "      }",
  "",
  "      function decodeXml(value) {",
  "        return value.replace(/&(?:amp|#38);/gi, '&').replace(/&(?:quot|#34);/gi, '\"').replace(/&(?:apos|#39);/gi, \"'\").replace(/&(?:lt|#60);/gi, '<').replace(/&(?:gt|#62);/gi, '>');",
  "      }",
  "",
  "      function attr(attrs, name) {",
  "        const escapedName = name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
  "        const match = new RegExp('(?:^|\\\\s)' + escapedName + '\\\\s*=\\\\s*([\\\"\\\'])(.*?)\\\\1', 'i').exec(attrs);",
  "        return match && match[2] ? decodeXml(match[2].trim()) : null;",
  "      }",
  "",
  "      // Phase 1 decompresses only the exact container entry. This avoids",
  "      // archive-order-dependent OPF selection and never reads chapter HTML.",
  "      const containerFiles = unzipSync(uint8, {",
  "        filter(file) {",
  "          const name = normalizeZipEntry(file.name);",
  "          return name !== null && name.toLowerCase() === 'meta-inf/container.xml' && file.originalSize <= MAX_METADATA_BYTES;",
  "        }",
  "      });",
  "",
  "      const containerEntry = Object.entries(containerFiles)[0];",
  "      let normalizedDeclaredOpf = null;",
  "      if (containerEntry) {",
  "        const containerXml = strFromU8(containerEntry[1]);",
  "        const rootfileTag = /<(?:[a-z0-9_-]+:)?rootfile\\b([^>]*)>/i.exec(containerXml);",
  "        const declaredOpfPath = rootfileTag ? attr(rootfileTag[1] || '', 'full-path') : null;",
  "        normalizedDeclaredOpf = declaredOpfPath ? normalizeZipEntry(declaredOpfPath) : null;",
  "      }",
  "",
  "      // Phase 2 decompresses only the declared OPF. If the container is",
  "      // absent, use a small deterministic conventional-name fallback; do",
  "      // not select an arbitrary OPF based on ZIP archive order.",
  "      const opfCandidates = containerEntry",
  "        ? (normalizedDeclaredOpf ? [normalizedDeclaredOpf] : [])",
  "        : ['OEBPS/content.opf', 'content.opf'];",
  "      const opfCandidateSet = new Set(opfCandidates.map(name => name.toLowerCase()));",
  "      const opfFiles = unzipSync(uint8, {",
  "        filter(file) {",
  "          const name = normalizeZipEntry(file.name);",
  "          return name !== null && opfCandidateSet.has(name.toLowerCase()) && file.originalSize <= MAX_METADATA_BYTES;",
  "        }",
  "      });",
  "      const opfEntry = opfCandidates.reduce((selected, candidate) => selected ?? Object.entries(opfFiles).find(([name]) => normalizeZipEntry(name)?.toLowerCase() === candidate.toLowerCase()), undefined);",
  "      if (!opfEntry) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "",
  "      const opfPath = normalizeZipEntry(opfEntry[0]);",
  "      if (!opfPath) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "      const slash = opfPath.lastIndexOf('/');",
  "      const opfDir = slash >= 0 ? opfPath.slice(0, slash + 1) : '';",
  "      const opfXml = strFromU8(opfEntry[1]);",
  "      const manifest = new Map();",
  "      const itemTagRegex = /<(?:[a-zA-Z0-9_-]+:)?item\\b([^>]*)>/gi;",
  "      let itemMatch;",
  "      let manifestCount = 0;",
  "      while ((itemMatch = itemTagRegex.exec(opfXml)) !== null && manifestCount < MAX_MANIFEST_ITEMS) {",
  "        const attrs = itemMatch[1] || '';",
  "        const id = attr(attrs, 'id');",
  "        const href = attr(attrs, 'href');",
  "        if (id && href) { manifest.set(id, href); manifestCount++; }",
  "      }",
  "      const spineHrefs = [];",
  "      const itemrefTagRegex = /<(?:[a-zA-Z0-9_-]+:)?itemref\\b([^>]*)>/gi;",
  "      let refMatch;",
  "      while ((refMatch = itemrefTagRegex.exec(opfXml)) !== null && spineHrefs.length < MAX_MANIFEST_ITEMS) {",
  "        const idref = attr(refMatch[1] || '', 'idref');",
  "        const href = idref ? manifest.get(idref) : null;",
  "        if (href) { spineHrefs.push({ href, resolved: resolveRelative(opfDir, href) }); }",
  "      }",
  "",
  "      let resolvedEntryName = null;",
  "      let isSpineMatched = false;",
  "      if (typeof targetSpineHref === 'string' && targetSpineHref.length > 0) {",
  "        const targetDecoded = decodePath(targetSpineHref);",
  "        const targetRelative = targetDecoded ? normalizeZipEntry(targetDecoded) : null;",
  "        const targetFromOpf = targetDecoded ? resolveRelative(opfDir, targetDecoded) : null;",
  "        for (const candidate of spineHrefs) {",
  "          if (!candidate.resolved) continue;",
  "          const candidateLower = candidate.resolved.toLowerCase();",
  "          const hrefRelative = normalizeZipEntry(candidate.href);",
  "          if ((targetFromOpf && candidateLower === targetFromOpf.toLowerCase()) || (targetRelative && candidateLower === targetRelative.toLowerCase()) || (targetRelative && hrefRelative && hrefRelative.toLowerCase() === targetRelative.toLowerCase())) {",
  "            resolvedEntryName = candidate.resolved;",
  "            isSpineMatched = true;",
  "            break;",
  "          }",
  "        }",
  "      }",
  "      if (!resolvedEntryName) {",
  "        const first = spineHrefs.find(candidate => candidate.resolved);",
  "        resolvedEntryName = first ? first.resolved : null;",
  "      }",
  "      if (!resolvedEntryName) { parentPort.postMessage({ ok: true, snippet: null }); return; }",
  "",
  "      const targetFiles = unzipSync(uint8, {",
  "        filter(file) {",
  "          const name = normalizeZipEntry(file.name);",
  "          return name !== null && name.toLowerCase() === resolvedEntryName.toLowerCase() && file.originalSize <= MAX_ENTRY_BYTES;",
  "        }",
  "      });",
  "      const targetBuffer = Object.values(targetFiles)[0];",
  "      if (!targetBuffer) {",
  "        parentPort.postMessage({ ok: true, snippet: null });",
  "        return;",
  "      }",
  "",
  "      const html = strFromU8(targetBuffer);",
  "      const text = html",
  "        .replace(/<style[\\s\\S]*?<\\/style>/gi, '')",
  "        .replace(/<script[\\s\\S]*?<\\/script>/gi, '')",
  "        .replace(/<[^>]+>/g, ' ')",
  "        .replace(/&[a-z0-9#]+;/gi, ' ')",
  "        .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '')",
  "        .replace(/\\s+/g, ' ')",
  "        .trim();",
  "",
  "      const snippet = text.length > 240 ? text.slice(0, 239).trim() + '…' : text;",
  "      parentPort.postMessage({",
  "        ok: true,",
  "        snippet: snippet.length > 0 ? snippet : null,",
  "        matchedSpineHref: resolvedEntryName,",
  "        isSpineMatched,",
  "      });",
  "    } catch {",
  "      parentPort.postMessage({ ok: true, snippet: null });",
  "    }",
  "    return;",
  "  }",
  "",
  "  parentPort.postMessage({ ok: true, snippet: null });",
  "}",
  "",
  "run().catch(err => {",
  "  parentPort.postMessage({ ok: false, error: err ? err.name || 'WorkerError' : 'UnknownError' });",
  "});",
].join('\n');

async function acquireSlot(): Promise<void> {
  if (activeWorkers < MAX_WORKERS) {
    activeWorkers++;
    return;
  }
  if (waiters.length >= MAX_PREVIEW_QUEUE) {
    throw new InterleafError('validation', 'Preview extraction queue limit exceeded.');
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function releaseSlot(): void {
  activeWorkers = Math.max(0, activeWorkers - 1);
  const next = waiters.shift();
  if (next) {
    activeWorkers++;
    next();
  }
}

export async function extractPreviewInWorker(
  request: PreviewExtractRequest,
  options?: { timeoutMs?: number }
): Promise<PreviewExtractResult> {
  const hasBuffer = request.buffer !== undefined;
  const hasFilePath = request.filePath !== undefined;
  if (hasBuffer === hasFilePath) {
    throw new InterleafError('validation', 'Preview extraction requires exactly one source.');
  }
  if (request.buffer !== undefined && request.buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new InterleafError('validation', 'Archive exceeds preview extraction byte limit.');
  }
  if (
    request.filePath !== undefined &&
    (request.filePath.length === 0 ||
      request.permittedRoot === undefined ||
      !isAbsolute(request.filePath) ||
      !isAbsolute(request.permittedRoot) ||
      request.filePath.includes('\0') ||
      request.permittedRoot.includes('\0'))
  ) {
    throw new InterleafError('validation', 'Preview source path must be an absolute canonical path.');
  }

  await acquireSlot();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;

  return new Promise<PreviewExtractResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let worker: Worker | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      releaseSlot();
      if (worker) {
        worker.terminate().catch(() => undefined);
        worker = null;
      }
    };

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
          codeRangeSizeMb: 16,
          stackSizeMb: 4,
        },
        workerData: {
          format: request.format,
          buffer: request.buffer,
          filePath: request.filePath,
          permittedRoot: request.permittedRoot,
          expectedFileSize: request.expectedFileSize,
          expectedFileMtimeMs: request.expectedFileMtimeMs,
          expectedFileCtimeMs: request.expectedFileCtimeMs,
          expectedFileDevice: request.expectedFileDevice,
          expectedFileInode: request.expectedFileInode,
          targetPageIndex: request.targetPageIndex,
          targetBlockIndex: request.targetBlockIndex,
          targetParagraphIndex: request.targetParagraphIndex,
          targetSpineHref: request.targetSpineHref,
          renderCover: request.renderCover === true,
          fflatePath: fflateModulePath,
          pdfjsPath: pdfjsModulePath,
          canvasPath: canvasModulePath,
        },
      });

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new InterleafError('internal', 'Preview worker extraction timed out.'));
        }
      }, timeoutMs);

      worker.on('message', (msg: {
        ok: boolean;
        snippet?: string | null;
        actualPageIndex?: number;
        actualBlockIndex?: number;
        actualParagraphIndex?: number;
        matchedSpineHref?: string;
        isSpineMatched?: boolean;
        unsupported?: boolean;
        coverPng?: Uint8Array;
        sourceBytesRead?: number;
        error?: string;
        rangeFailureReason?: string;
      }) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (msg.ok) {
          resolve({
            snippet: msg.snippet ?? null,
            actualPageIndex: msg.actualPageIndex,
            actualBlockIndex: msg.actualBlockIndex,
            actualParagraphIndex: msg.actualParagraphIndex,
            matchedSpineHref: msg.matchedSpineHref,
            isSpineMatched: msg.isSpineMatched,
            unsupported: msg.unsupported,
            coverPng: msg.coverPng,
            sourceBytesRead: msg.sourceBytesRead,
            rangeFailureReason: msg.rangeFailureReason,
          });
        } else {
          reject(new InterleafError('internal', `Worker extraction failed: ${msg.error ?? 'ExtractionError'}`));
        }
      });

      worker.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new InterleafError('internal', `Worker crashed: ${err.name}`));
      });

      worker.on('exit', (code: number) => {
        if (!settled) {
          settled = true;
          cleanup();
          if (code !== 0) {
            reject(new InterleafError('internal', `Worker exited with status ${String(code)}`));
          } else {
            resolve({ snippet: null });
          }
        }
      });
    } catch (err) {
      settled = true;
      cleanup();
      reject(new InterleafError('internal', `Failed to spawn preview worker: ${err instanceof Error ? err.name : 'SpawnError'}`));
    }
  });
}
