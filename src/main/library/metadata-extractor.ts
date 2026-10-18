import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { DocumentFormat } from '@shared/types/document';
import { extractZipMetadataInWorker } from '../workers/zip-metadata-worker';

export type ExtractedMetadata = {
  readonly title: string;
  readonly author: string | null;
  readonly pageCount: number | null;
};

/**
 * Derives a clean default title from the file's basename.
 */
export function deriveTitleFromFilename(filePath: string): string {
  const rawBase = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = extname(rawBase);
  let nameWithoutExt = ext.length > 0 ? rawBase.slice(0, -ext.length) : rawBase;
  if (nameWithoutExt.startsWith('.')) {
    nameWithoutExt = nameWithoutExt.slice(1);
  }
  const cleaned = nameWithoutExt
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    cleaned.length === 0 ||
    ['pdf', 'epub', 'mobi', 'azw', 'azw3', 'docx', 'pptx', 'md', 'markdown'].includes(cleaned.toLowerCase())
  ) {
    return 'Untitled Document';
  }
  return cleaned;
}

function sanitizeString(
  str: string | null | undefined,
  maxLength: number
): string | null {
  if (!str) return null;
  const cleaned = str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Extracts metadata from a PDF file buffer.
 */
function extractPdfMetadataFromBuffer(buffer: Buffer, fallbackTitle: string): ExtractedMetadata {
  try {
    const text = buffer.toString('latin1');
    let title: string | null = null;
    let author: string | null = null;
    let pageCount: number | null = null;

    // Search for /Title (value) or /Title <hex>
    const titleMatch = /\/Title\s*\(([^)]+)\)/i.exec(text);
    if (titleMatch?.[1]) {
      title = sanitizeString(titleMatch[1], 512);
    }

    // Search for /Author (value)
    const authorMatch = /\/Author\s*\(([^)]+)\)/i.exec(text);
    if (authorMatch?.[1]) {
      author = sanitizeString(authorMatch[1], 256);
    }

    // Search for /Count (number of pages in catalog/pages tree)
    const countMatch = /\/Count\s+(\d+)/i.exec(text);
    if (countMatch?.[1]) {
      const parsedCount = Number.parseInt(countMatch[1], 10);
      if (Number.isSafeInteger(parsedCount) && parsedCount > 0) {
        pageCount = parsedCount;
      }
    }

    return {
      title: title ?? fallbackTitle,
      author,
      pageCount,
    };
  } catch {
    return { title: fallbackTitle, author: null, pageCount: null };
  }
}

/**
 * Extracts metadata from an EPUB, DOCX or PPTX (ZIP-based) buffer.
 */
async function extractZipXmlMetadataFromBuffer(
  buffer: Buffer,
  fallbackTitle: string
): Promise<ExtractedMetadata> {
  try {
    const raw = await extractZipMetadataInWorker(buffer);
    const title = sanitizeString(raw.title, 512);
    const author = sanitizeString(raw.author, 256);

    return {
      title: title ?? fallbackTitle,
      author,
      pageCount: null,
    };
  } catch {
    return { title: fallbackTitle, author: null, pageCount: null };
  }
}

/**
 * Extracts metadata from a MOBI buffer.
 */
function extractMobiMetadataFromBuffer(buffer: Buffer, fallbackTitle: string): ExtractedMetadata {
  try {
    let title: string | null = null;
    let author: string | null = null;

    // Check Palm database record 0 title or EXTH records
    const text = buffer.toString('latin1');
    const authorMatch = /<author[^>]*>([^<]+)<\/author>/i.exec(text);
    if (authorMatch?.[1]) {
      author = sanitizeString(authorMatch[1], 256);
    }

    // Read 32-byte Palm DB name from offset 0
    const palmName = buffer.toString('latin1', 0, 32).replace(/\0.*$/g, '').trim();
    if (palmName.length > 0) {
      title = sanitizeString(palmName, 512);
    }

    return {
      title: title ?? fallbackTitle,
      author,
      pageCount: null,
    };
  } catch {
    return { title: fallbackTitle, author: null, pageCount: null };
  }
}

/**
 * Extracts metadata from a Markdown buffer (frontmatter or first H1 heading).
 */
function extractMarkdownMetadataFromBuffer(buffer: Buffer, fallbackTitle: string): ExtractedMetadata {
  try {
    let text = buffer.toString('utf-8');
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
    const lines = text.split(/\r?\n/);
    let title: string | null = null;
    let author: string | null = null;

    if (lines[0]?.trim() === '---') {
      let endIdx = -1;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line === '---' || line === '...') {
          endIdx = i;
          break;
        }
      }
      if (endIdx > 0) {
        const frontmatterLines = lines.slice(1, endIdx);
        const hasFrontmatterKeys = frontmatterLines.some((l) => /^[a-zA-Z0-9_-]+:\s*/.test(l.trim()));
        if (hasFrontmatterKeys) {
          for (const fLine of frontmatterLines) {
            const titleMatch = /^title:\s*["']?(.*?)["']?$/i.exec(fLine);
            if (titleMatch?.[1]) {
              title = sanitizeString(titleMatch[1], 512);
            }
            const authorMatch = /^author:\s*["']?(.*?)["']?$/i.exec(fLine);
            if (authorMatch?.[1]) {
              author = sanitizeString(authorMatch[1], 256);
            }
          }
        }
      }
    }

    if (!title) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const trimmed = line.trim();
        const headingMatch = /^#\s+(.*?)(?:\s+#+)?$/.exec(trimmed);
        if (headingMatch?.[1]) {
          title = sanitizeString(headingMatch[1], 512);
          break;
        }
        if (
          trimmed.length > 0 &&
          i + 1 < lines.length &&
          /^={1,}\s*$/.test((lines[i + 1] ?? '').trim()) &&
          !trimmed.startsWith('#') &&
          !trimmed.startsWith('```') &&
          !trimmed.startsWith('~~~') &&
          !trimmed.startsWith('>') &&
          !/^(?:[*_-]\s*){3,}$/.test(trimmed)
        ) {
          title = sanitizeString(trimmed, 512);
          break;
        }
      }
    }

    return {
      title: title ?? fallbackTitle,
      author,
      pageCount: null,
    };
  } catch {
    return { title: fallbackTitle, author: null, pageCount: null };
  }
}

/**
 * Extracts metadata for a document file given its format and path.
 */
export async function extractDocumentMetadata(
  filePath: string,
  format: DocumentFormat,
  fallbackFilePath: string = filePath
): Promise<ExtractedMetadata> {
  const fallbackTitle = deriveTitleFromFilename(fallbackFilePath);
  let handle;

  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    // ZIP metadata extraction is explicitly bounded to prevent archive bombs
    // and large whole-file reads; larger books fall back to the filename until
    // their Phase 4 adapter parses metadata in a worker.
    const archiveMetadataLimit = 8 * 1024 * 1024;
    const readSize =
      (format === 'epub' || format === 'docx' || format === 'pptx') && stats.size <= archiveMetadataLimit
        ? stats.size
        : Math.min(stats.size, 65536);
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
    const sliced = buffer.subarray(0, bytesRead);

    switch (format) {
      case 'pdf':
        return extractPdfMetadataFromBuffer(sliced, fallbackTitle);
      case 'epub':
      case 'docx':
      case 'pptx':
        return await extractZipXmlMetadataFromBuffer(sliced, fallbackTitle);
      case 'mobi':
        return extractMobiMetadataFromBuffer(sliced, fallbackTitle);
      case 'markdown':
        return extractMarkdownMetadataFromBuffer(sliced, fallbackTitle);
      default:
        return { title: fallbackTitle, author: null, pageCount: null };
    }
  } catch {
    return { title: fallbackTitle, author: null, pageCount: null };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}
