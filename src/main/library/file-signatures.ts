import { open, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import type { DocumentFormat } from '@shared/types/document';
import { isParagraphFormat, type ParagraphFormat } from '@shared/document-format-family';

export type SignatureValidationResult =
  | { readonly ok: true; readonly format: DocumentFormat }
  | { readonly ok: false; readonly error: string };

const SUPPORTED_EXTENSIONS: Readonly<Record<string, DocumentFormat>> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.mobi': 'mobi',
  '.azw': 'mobi',
  '.azw3': 'mobi',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

/** Parts every package of the format must hold; the renderer parser checks the rest. */
const OOXML_REQUIRED_ENTRIES: Readonly<Record<ParagraphFormat, readonly string[]>> = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
};

function ooxmlStructureError(format: ParagraphFormat): string {
  return `Invalid ${format.toUpperCase()} package structure.`;
}

function validateOoxmlBuffer(
  buffer: Buffer,
  format: ParagraphFormat,
  tailBuffer: Buffer
): SignatureValidationResult {
  const required = OOXML_REQUIRED_ENTRIES[format];
  if (!isZipLocalHeader(buffer)) {
    return { ok: false, error: ooxmlStructureError(format) };
  }
  const directory = extractZipCentralDirectory(tailBuffer);
  if (
    !directory ||
    !hasSafeRequiredEntries(directory, tailBuffer.length, required) ||
    !requiredLocalHeadersMatchBuffer(tailBuffer, directory, required)
  ) {
    return { ok: false, error: ooxmlStructureError(format) };
  }
  return { ok: true, format };
}

type ZipDirectoryEntry = {
  readonly flags: number;
  readonly versionMadeBy: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
};

type ZipCentralDirectory = {
  readonly entries: ReadonlyMap<string, ZipDirectoryEntry>;
  readonly totalEntries: number;
};

/**
 * Normalizes an extension to a supported DocumentFormat, or null if unsupported.
 */
export function normalizeExtension(filePath: string): DocumentFormat | null {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? null;
}

/**
 * Validates a buffer against the expected format signature.
 */
export function validateFileBufferSignature(
  buffer: Buffer,
  declaredFormat: DocumentFormat,
  tailBuffer: Buffer = buffer
): SignatureValidationResult {
  if (buffer.length === 0) {
    return { ok: false, error: 'File is empty (0 bytes).' };
  }
  if (isParagraphFormat(declaredFormat)) {
    return validateOoxmlBuffer(buffer, declaredFormat, tailBuffer);
  }

  switch (declaredFormat) {
    case 'pdf': {
      // PDF must start with %PDF- (0x25 0x50 0x44 0x46 0x2D)
      // Some PDFs have up to a few bytes of leading BOM/whitespace, but standard %PDF- is at index 0-1024.
      const headerIndex = buffer.indexOf(Buffer.from('%PDF-'));
      if (headerIndex === -1 || headerIndex > 1024) {
        return { ok: false, error: 'Invalid PDF: missing %PDF- header signature.' };
      }
      return { ok: true, format: 'pdf' };
    }

    case 'epub': {
      // EPUB requires the first ZIP member to be an uncompressed `mimetype`
      // entry whose exact bytes are `application/epub+zip`.
      if (!isZipLocalHeader(buffer) || buffer.length < 58) {
        return { ok: false, error: 'Invalid EPUB container signature.' };
      }
      const flags = buffer.readUInt16LE(6);
      const compressionMethod = buffer.readUInt16LE(8);
      const fileNameLength = buffer.readUInt16LE(26);
      const extraLength = buffer.readUInt16LE(28);
      const fileNameStart = 30;
      const fileNameEnd = fileNameStart + fileNameLength;
      const dataStart = fileNameEnd + extraLength;
      const expectedMimeType = Buffer.from('application/epub+zip', 'ascii');
      if (
        (flags & 0x1) !== 0 ||
        compressionMethod !== 0 ||
        fileNameEnd > buffer.length ||
        buffer.toString('utf8', fileNameStart, fileNameEnd) !== 'mimetype' ||
        dataStart + expectedMimeType.length > buffer.length ||
        !buffer.subarray(dataStart, dataStart + expectedMimeType.length).equals(expectedMimeType)
      ) {
        return { ok: false, error: 'Invalid EPUB mimetype entry.' };
      }
      return { ok: true, format: 'epub' };
    }

    case 'mobi': {
      // MOBI/AZW is a PalmDOC database. Offset 60 contains the 8-byte type/creator string (e.g. BOOKMOBI).
      if (buffer.length < 68) {
        return { ok: false, error: 'Invalid MOBI/AZW: file too small for Palm database header.' };
      }
      const idStr = buffer.toString('ascii', 60, 68);
      if (idStr !== 'BOOKMOBI') {
        return {
          ok: false,
          error: 'Invalid MOBI/AZW header signature.',
        };
      }
      return { ok: true, format: 'mobi' };
    }

    case 'markdown': {
      // Markdown is a UTF-8 text file. Reject binary files containing null bytes.
      if (buffer.includes(0x00)) {
        return { ok: false, error: 'Invalid Markdown: binary file detected.' };
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        return { ok: false, error: 'Invalid Markdown: invalid UTF-8 encoding.' };
      }
      return { ok: true, format: 'markdown' };
    }

    default:
      return { ok: false, error: `Unsupported format: ${String(declaredFormat)}` };
  }
}

/**
 * Validates the file signature of a file on disk by reading its header bytes.
 */
export async function validateFileSignature(filePath: string): Promise<SignatureValidationResult> {
  const format = normalizeExtension(filePath);
  if (!format) {
    const ext = extname(filePath);
    return {
      ok: false,
      error: `Unsupported file extension: '${ext}'. Supported extensions are .pdf, .epub, .mobi, .azw, .azw3, .docx, .pptx, .md, .markdown.`,
    };
  }

  let handle;
  try {
    handle = await open(filePath, 'r');
    const fileStats = await handle.stat();
    const headerSize = Math.min(fileStats.size, 4096);
    const tailSize = Math.min(fileStats.size, 128 * 1024);
    const headerBuffer = Buffer.alloc(headerSize);
    const tailBuffer = Buffer.alloc(tailSize);
    const [{ bytesRead: headerBytes }, { bytesRead: tailBytes }] = await Promise.all([
      handle.read(headerBuffer, 0, headerSize, 0),
      handle.read(tailBuffer, 0, tailSize, Math.max(0, fileStats.size - tailSize)),
    ]);
    const headerSlice = headerBuffer.subarray(0, headerBytes);
    const tailSlice = tailBuffer.subarray(0, tailBytes);

    if (isParagraphFormat(format)) {
      const required = OOXML_REQUIRED_ENTRIES[format];
      if (!isZipLocalHeader(headerSlice)) {
        return { ok: false, error: ooxmlStructureError(format) };
      }
      let directory = extractZipCentralDirectory(tailSlice, fileStats.size);
      if (!directory) {
        const eocdOffset = findEocdOffset(tailSlice);
        if (eocdOffset !== -1) {
          const cdSize = tailSlice.readUInt32LE(eocdOffset + 12);
          const cdOffset = tailSlice.readUInt32LE(eocdOffset + 16);
          const diskEntries = tailSlice.readUInt16LE(eocdOffset + 8);
          const totalEntries = tailSlice.readUInt16LE(eocdOffset + 10);
          if (
            cdSize > 0 &&
            cdSize <= MAX_ZIP_CENTRAL_DIRECTORY_BYTES &&
            diskEntries === totalEntries &&
            totalEntries <= MAX_ZIP_ENTRIES &&
            cdOffset + cdSize <= fileStats.size
          ) {
            const cdBuf = Buffer.alloc(cdSize);
            const { bytesRead } = await handle.read(cdBuf, 0, cdSize, cdOffset);
            if (bytesRead === cdSize) {
              directory = parseCentralDirectory(cdBuf, totalEntries);
            }
          }
        }
      }
      if (
        !directory ||
        !hasSafeRequiredEntries(directory, fileStats.size, required) ||
        !(await requiredLocalHeadersMatch(handle, directory, required))
      ) {
        return { ok: false, error: ooxmlStructureError(format) };
      }
      return { ok: true, format };
    }

    return validateFileBufferSignature(headerSlice, format, tailSlice);
  } catch {
    return { ok: false, error: 'The selected file could not be inspected safely.' };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function findEocdOffset(tailBuffer: Buffer): number {
  const minOffset = Math.max(0, tailBuffer.length - 65557);
  for (let i = tailBuffer.length - 22; i >= minOffset; i--) {
    if (tailBuffer.readUInt32LE(i) === 0x06054b50) {
      const commentLength = tailBuffer.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tailBuffer.length) {
        return i;
      }
    }
  }
  return -1;
}

function parseCentralDirectory(
  cdBuffer: Buffer,
  expectedEntries: number
): ZipCentralDirectory | null {
  const entries = new Map<string, ZipDirectoryEntry>();
  let offset = 0;
  let count = 0;
  while (offset + 46 <= cdBuffer.length && count < expectedEntries) {
    const signature = cdBuffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) {
      return null;
    }
    const fileNameLength = cdBuffer.readUInt16LE(offset + 28);
    const extraLength = cdBuffer.readUInt16LE(offset + 30);
    const commentLength = cdBuffer.readUInt16LE(offset + 32);
    const entryHeaderEnd = offset + 46;
    const fileNameEnd = entryHeaderEnd + fileNameLength;
    if (fileNameEnd > cdBuffer.length) {
      return null;
    }
    const name = cdBuffer.toString('utf8', entryHeaderEnd, fileNameEnd);
    const nextOffset = fileNameEnd + extraLength + commentLength;
    if (nextOffset > cdBuffer.length || entries.has(name)) {
      return null;
    }
    entries.set(name, {
      versionMadeBy: cdBuffer.readUInt16LE(offset + 4),
      flags: cdBuffer.readUInt16LE(offset + 8),
      compressedSize: cdBuffer.readUInt32LE(offset + 20),
      uncompressedSize: cdBuffer.readUInt32LE(offset + 24),
      externalAttributes: cdBuffer.readUInt32LE(offset + 38),
      localHeaderOffset: cdBuffer.readUInt32LE(offset + 42),
    });
    offset = nextOffset;
    count++;
  }
  if (count !== expectedEntries || offset !== cdBuffer.length) {
    return null;
  }
  return { entries, totalEntries: expectedEntries };
}

function extractZipCentralDirectory(
  tailBuffer: Buffer,
  totalFileSize?: number
): ZipCentralDirectory | null {
  const eocdOffset = findEocdOffset(tailBuffer);
  if (eocdOffset === -1) return null;

  const diskNumber = tailBuffer.readUInt16LE(eocdOffset + 4);
  const cdDiskNumber = tailBuffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = tailBuffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = tailBuffer.readUInt16LE(eocdOffset + 10);
  if (
    diskNumber !== 0 ||
    cdDiskNumber !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries > MAX_ZIP_ENTRIES ||
    totalEntries === 0xffff
  ) {
    return null;
  }

  const cdSize = tailBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = tailBuffer.readUInt32LE(eocdOffset + 16);
  if (
    cdSize === 0 ||
    cdSize > MAX_ZIP_CENTRAL_DIRECTORY_BYTES ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    return null;
  }

  const fileSize =
    totalFileSize ??
    (eocdOffset + 22 + tailBuffer.readUInt16LE(eocdOffset + 20) <= tailBuffer.length
      ? tailBuffer.length
      : undefined);
  if (fileSize !== undefined) {
    const tailBaseOffset = Math.max(0, fileSize - tailBuffer.length);
    if (cdOffset >= tailBaseOffset && cdOffset + cdSize <= fileSize) {
      const cdStartInTail = cdOffset - tailBaseOffset;
      const cdEndInTail = cdStartInTail + cdSize;
      if (cdEndInTail <= tailBuffer.length) {
        return parseCentralDirectory(tailBuffer.subarray(cdStartInTail, cdEndInTail), totalEntries);
      }
    }
  } else if (cdOffset + cdSize <= tailBuffer.length) {
    return parseCentralDirectory(tailBuffer.subarray(cdOffset, cdOffset + cdSize), totalEntries);
  }

  return null;
}

function hasSafeRequiredEntries(
  directory: ZipCentralDirectory,
  totalFileSize: number,
  required: readonly string[]
): boolean {
  return required.every((name) => {
    const entry = directory.entries.get(name);
    if (!entry) return false;
    const creatorSystem = entry.versionMadeBy >>> 8;
    const unixType = (entry.externalAttributes >>> 16) & 0xf000;
    const isUnixNonRegular = creatorSystem === 3 && unixType !== 0 && unixType !== 0x8000;
    const isDosDirectory = (entry.externalAttributes & 0x10) !== 0;
    return (
      (entry.flags & 0x41) === 0 &&
      !isUnixNonRegular &&
      !isDosDirectory &&
      entry.compressedSize !== 0xffffffff &&
      entry.uncompressedSize !== 0xffffffff &&
      entry.localHeaderOffset !== 0xffffffff &&
      entry.localHeaderOffset + 30 <= totalFileSize
    );
  });
}

async function requiredLocalHeadersMatch(
  handle: FileHandle,
  directory: ZipCentralDirectory,
  required: readonly string[]
): Promise<boolean> {
  for (const name of required) {
    const entry = directory.entries.get(name);
    if (!entry) return false;
    const fixedHeader = Buffer.alloc(30);
    const { bytesRead } = await handle.read(fixedHeader, 0, fixedHeader.length, entry.localHeaderOffset);
    if (bytesRead !== fixedHeader.length || fixedHeader.readUInt32LE(0) !== 0x04034b50) {
      return false;
    }
    const flags = fixedHeader.readUInt16LE(6);
    const fileNameLength = fixedHeader.readUInt16LE(26);
    const extraLength = fixedHeader.readUInt16LE(28);
    if ((flags & 0x41) !== 0 || fileNameLength !== Buffer.byteLength(name)) {
      return false;
    }
    const variableHeader = Buffer.alloc(fileNameLength + extraLength);
    const variableRead = await handle.read(
      variableHeader,
      0,
      variableHeader.length,
      entry.localHeaderOffset + fixedHeader.length
    );
    if (
      variableRead.bytesRead !== variableHeader.length ||
      !variableHeader.subarray(0, fileNameLength).equals(Buffer.from(name, 'ascii'))
    ) {
      return false;
    }
  }
  return true;
}

function requiredLocalHeadersMatchBuffer(
  archive: Buffer,
  directory: ZipCentralDirectory,
  required: readonly string[]
): boolean {
  for (const name of required) {
    const entry = directory.entries.get(name);
    if (!entry || entry.localHeaderOffset + 30 > archive.length) return false;
    const offset = entry.localHeaderOffset;
    if (archive.readUInt32LE(offset) !== 0x04034b50) return false;
    const flags = archive.readUInt16LE(offset + 6);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    if (
      (flags & 0x41) !== 0 ||
      nameEnd + extraLength > archive.length ||
      !archive.subarray(nameStart, nameEnd).equals(Buffer.from(name, 'ascii'))
    ) {
      return false;
    }
  }
  return true;
}
function isZipLocalHeader(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}
