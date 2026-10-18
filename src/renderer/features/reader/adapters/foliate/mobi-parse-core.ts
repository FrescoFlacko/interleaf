import { unzlibSync } from 'fflate';
import type { PortableRecord } from '@shared/models/portable';
import type {
  UpstreamMobiBook,
  UpstreamMobiSection,
  UpstreamMobiTocItem,
} from './upstream/mobi.js';

const MAX_ZLIB_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SECTION_MARKUP_BYTES = 8 * 1024 * 1024;
const MAX_BOOK_MARKUP_BYTES = 32 * 1024 * 1024;
const MAX_BOOK_RASTER_BYTES = 64 * 1024 * 1024;
const MAX_SECTION_RASTERS = 256;

export const MOBI_PARSE_LIMITS = Object.freeze({
  maxResourceBytes: MAX_ZLIB_RESOURCE_BYTES,
  maxBookRasterBytes: MAX_BOOK_RASTER_BYTES,
});

const ALLOWED_MARKUP_TAGS = new Set([
  'a', 'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'i', 'strong', 'em', 'u', 's', 'strike', 'sub', 'sup',
  'blockquote', 'pre', 'code', 'table', 'caption', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'hr', 'br', 'img',
]);
const ALLOWED_MARKUP_ATTRS = new Set([
  'id', 'name', 'class', 'src', 'alt', 'title', 'width', 'height',
  'lang', 'dir', 'colspan', 'rowspan', 'scope', 'data-anchor', 'data-page',
]);
const DROP_WITH_CONTENT_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'frame', 'object', 'embed',
  'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'option',
  'link', 'meta', 'base', 'audio', 'video', 'source', 'canvas',
]);
const SAFE_RASTER_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,/i;

export type ParsedMobiSection = {
  readonly id: string;
  readonly size: number;
  readonly linear?: string;
  readonly markup: string;
};

export type ParsedMobiPayload = {
  readonly sections: readonly ParsedMobiSection[];
  readonly toc: readonly UpstreamMobiTocItem[];
  readonly metadata: PortableRecord;
  readonly hrefTargets: readonly { readonly href: string; readonly index: number }[];
};

const readAscii = (data: Uint8Array, start: number, end: number): string => {
  let value = '';
  for (const byte of data.subarray(start, end)) value += String.fromCharCode(byte);
  return value;
};

function sniffRasterMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && readAscii(bytes, 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const gif = readAscii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (readAscii(bytes, 4, 8) === 'ftyp') {
    const brands = readAscii(bytes, 8, Math.min(bytes.length, 32));
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  return null;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('MOBI resource exceeds safety limit');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('MOBI resource exceeds safety limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('MOBI resource exceeds safety limit');
        throw new Error('MOBI resource exceeds safety limit');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBoundedRasterDataUrl(source: string, maxBytes: number): Uint8Array {
  const match = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,([a-z\d+/]+={0,2})$/i.exec(source);
  const encoded = match?.[1];
  if (!encoded || Math.ceil(encoded.length * 3 / 4) > maxBytes) {
    throw new Error('MOBI data image exceeds safety limit');
  }
  const binary = atob(encoded);
  if (binary.length > maxBytes) throw new Error('MOBI data image exceeds safety limit');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Strict worker-side allowlist. Output is safe to assign to scriptless srcdoc. */
function sanitizeMobiMarkup(markup: string): string {
  const initial = new DOMParser().parseFromString(markup, 'text/html');
  // linkedom intentionally follows document parsing rules: MOBI sections after
  // the first are often HTML fragments, so normalize them into an explicit body
  // before walking the allowlist.
  const fragment = initial.body.innerHTML.trim() ? initial.body.innerHTML : markup;
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${fragment}</body></html>`,
    'text/html'
  );
  const elements = Array.from(doc.body.querySelectorAll('*')).reverse();
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    if (!ALLOWED_MARKUP_TAGS.has(tagName)) {
      if (DROP_WITH_CONTENT_TAGS.has(tagName)) element.remove();
      else element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_MARKUP_ATTRS.has(name) || name.startsWith('on') || name === 'style' || name === 'srcset') {
        element.removeAttribute(attribute.name);
      }
    }
    if (tagName === 'img') {
      const source = element.getAttribute('src')?.trim();
      if (source && !SAFE_RASTER_DATA_URL.test(source)) element.removeAttribute('src');
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${doc.body.innerHTML}</body></html>`;
}

export async function inlineSafeRasterResources(
  markup: string,
  budget: { rasterBytes: number },
  loadResource?: (index: number) => Promise<ArrayBuffer | Uint8Array>
): Promise<string> {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const allImages = Array.from(doc.querySelectorAll('img'));
  const images = allImages.slice(0, MAX_SECTION_RASTERS);
  for (const overflowImage of allImages.slice(MAX_SECTION_RASTERS)) {
    overflowImage.removeAttribute('src');
  }
  for (const image of images) {
    const source = image.getAttribute('src');
    try {
      const remaining = MAX_BOOK_RASTER_BYTES - budget.rasterBytes;
      if (remaining <= 0) throw new Error('MOBI image budget exceeded');
      let bytes: Uint8Array;
      const recindex = image.getAttribute('recindex');
      const kindleMatch = source ? /^kindle:embed:(\w+)/i.exec(source) : null;
      if (recindex && loadResource) {
        const index = Number.parseInt(recindex, 10) - 1;
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid MOBI image index');
        bytes = new Uint8Array(await loadResource(index));
      } else if (kindleMatch?.[1] && loadResource) {
        const index = Number.parseInt(kindleMatch[1], 32) - 1;
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid KF8 image index');
        bytes = new Uint8Array(await loadResource(index));
      } else if (source?.startsWith('blob:')) {
        const response = await fetch(source, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Failed to load MOBI image');
        bytes = await readBoundedBytes(response, Math.min(MAX_ZLIB_RESOURCE_BYTES, remaining));
      } else if (source?.startsWith('data:')) {
        bytes = decodeBoundedRasterDataUrl(
          source,
          Math.min(MAX_ZLIB_RESOURCE_BYTES, remaining)
        );
      } else {
        image.removeAttribute('src');
        continue;
      }
      if (bytes.byteLength > Math.min(MAX_ZLIB_RESOURCE_BYTES, remaining)) {
        throw new Error('MOBI image exceeds safety limit');
      }
      const mimeType = sniffRasterMimeType(bytes);
      if (!mimeType) throw new Error('Unsupported MOBI image type');
      budget.rasterBytes += bytes.byteLength;
      image.setAttribute('src', `data:${mimeType};base64,${bytesToBase64(bytes)}`);
    } catch {
      image.removeAttribute('src');
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

async function loadSectionMarkup(
  section: UpstreamMobiSection,
  includeResources: boolean,
  rasterBudget: { rasterBytes: number },
  loadResource?: (index: number) => Promise<ArrayBuffer | Uint8Array>
): Promise<string> {
  if (!section.createDocument) return '<html><body></body></html>';
  const doc = await section.createDocument();
  const markup = new XMLSerializer().serializeToString(doc);
  return includeResources
    ? inlineSafeRasterResources(markup, rasterBudget, loadResource)
    : markup;
}

export async function parseMobiArchive(
  bytes: Uint8Array,
  options: { readonly includeResources: boolean }
): Promise<ParsedMobiPayload> {
  const { MOBI: UpstreamMOBI } = await import('./upstream/mobi.js');
  const parser = new UpstreamMOBI({
    unzlib: (data) => {
      const result = unzlibSync(data, { out: new Uint8Array(MAX_ZLIB_RESOURCE_BYTES + 1) });
      if (result.byteLength > MAX_ZLIB_RESOURCE_BYTES) {
        throw new Error('Decoded MOBI resource exceeds the supported safety limit');
      }
      return Promise.resolve(result);
    },
  });
  const book: UpstreamMobiBook = await parser.open(new Blob([
    bytes as Uint8Array<ArrayBuffer>,
  ], { type: 'application/x-mobipocket-ebook' }));

  try {
    const hrefs = new Set<string>();
    const collectHrefs = (items: readonly UpstreamMobiTocItem[]): void => {
      for (const item of items) {
        if (item.href) hrefs.add(item.href);
        collectHrefs(item.subitems ?? item.children ?? []);
      }
    };
    collectHrefs(book.toc ?? []);
    const hrefTargets: { href: string; index: number }[] = [];
    for (const href of hrefs) {
      try {
        const target = await book.resolveHref?.(href);
        if (target && Number.isSafeInteger(target.index) && target.index >= 0 && target.index < book.sections.length) {
          hrefTargets.push({ href, index: target.index });
        }
      } catch {
        // Ignore a malformed individual TOC target without dropping the book.
      }
    }

    const sections: ParsedMobiSection[] = [];
    const rasterBudget = { rasterBytes: 0 };
    const resourceOwner = book as UpstreamMobiBook & {
      readonly mobi?: { loadResource(index: number): Promise<ArrayBuffer | Uint8Array> };
    };
    const loadResource = resourceOwner.mobi?.loadResource.bind(resourceOwner.mobi);
    let aggregateMarkupBytes = 0;
    for (const [index, section] of book.sections.entries()) {
      const reconstructed = await loadSectionMarkup(section, options.includeResources, rasterBudget, loadResource);
      if (new TextEncoder().encode(reconstructed).byteLength > MAX_SECTION_MARKUP_BYTES) {
        throw new Error('MOBI section exceeds safety limit');
      }
      const markup = sanitizeMobiMarkup(reconstructed);
      const markupBytes = new TextEncoder().encode(markup).byteLength;
      if (markupBytes > MAX_SECTION_MARKUP_BYTES) throw new Error('MOBI section exceeds safety limit');
      aggregateMarkupBytes += markupBytes;
      if (aggregateMarkupBytes > MAX_BOOK_MARKUP_BYTES) throw new Error('MOBI book exceeds decoded markup limit');
      sections.push({
        id: `mobi-section-${String(index + 1)}`,
        size: section.size ?? markupBytes,
        ...(section.linear ? { linear: section.linear } : {}),
        markup,
      });
    }

    return {
      sections,
      toc: book.toc ?? [],
      metadata: book.metadata ?? {},
      hrefTargets,
    };
  } finally {
    book.destroy?.();
  }
}
