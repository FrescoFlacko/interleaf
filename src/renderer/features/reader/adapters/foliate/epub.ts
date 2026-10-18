// Hardened EPUB parser ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)
// Enhanced with DOMPurify sanitization and strict DRM rejection.

import * as CFI from './epubcfi';
import { sanitizeEbookHtml } from './sanitize';
import type { ZipLoader } from './zip-loader';

const NS = {
  CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
  XHTML: 'http://www.w3.org/1999/xhtml',
  OPF: 'http://www.idpf.org/2007/opf',
  EPUB: 'http://www.idpf.org/2007/ops',
  DC: 'http://purl.org/dc/elements/1.1/',
  DCTERMS: 'http://purl.org/dc/terms/',
  ENC: 'http://www.w3.org/2001/04/xmlenc#',
  NCX: 'http://www.daisy.org/z3986/2005/ncx/',
} as const;

const MIME = {
  XML: 'application/xml',
  NCX: 'application/x-dtbncx+xml',
  XHTML: 'application/xhtml+xml',
  HTML: 'text/html',
  CSS: 'text/css',
  SVG: 'image/svg+xml',
} as const;

const SAFE_RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

const isFontMimeType = (mimeType: string): boolean => {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('font/') ||
    normalized.startsWith('application/font-') ||
    normalized === 'application/vnd.ms-opentype' ||
    normalized === 'application/x-font-ttf' ||
    normalized === 'application/x-font-opentype';
};

export type ManifestItem = {
  id: string;
  href: string;
  mediaType: string;
  properties?: string[] | undefined;
  mediaOverlay?: string | undefined;
};

export type SpineItem = {
  idref: string;
  linear?: string | undefined;
  properties?: string[] | undefined;
};

export type EpubSection = {
  id: string;
  index: number;
  cfi: string;
  linear?: string | undefined;
  size: number;
  load: () => Promise<string>;
  unload: () => void;
  createDocument: () => Promise<Document>;
  resolveHref: (href: string) => string;
};

export type EpubTOCItem = {
  label: string;
  href: string;
  subitems?: EpubTOCItem[] | undefined;
};

const resolveURL = (url: string, relativeTo: string): string => {
  try {
    if (url.startsWith('/') || url.includes(':')) {
      const root = 'https://interleaf.local/';
      const obj = new URL(url, root + relativeTo);
      return decodeURI(obj.href.replace(root, ''));
    }
    const root = 'https://interleaf.local/';
    const obj = new URL(url, root + relativeTo);
    return decodeURI(obj.href.replace(root, ''));
  } catch {
    return url;
  }
};

const isExternal = (uri: string): boolean => /^(?!blob)\w+:/i.test(uri);

export class EPUB {
  private loader: ZipLoader;
  private opfPath = '';
  private manifest = new Map<string, ManifestItem>();
  private manifestByHref = new Map<string, ManifestItem>();
  private spine: SpineItem[] = [];
  private spineCfis: string[] = [];
  private blobUrls = new Map<string, string>();

  sections: EpubSection[] = [];
  toc: EpubTOCItem[] = [];
  pageList: EpubTOCItem[] = [];
  metadata: {
    title?: string | undefined;
    creator?: string | undefined;
    language?: string | undefined;
    identifier?: string | undefined;
  } = {};
  rendition: { layout?: string | undefined; spread?: string | undefined } = {};
  dir: 'ltr' | 'rtl' = 'ltr';

  constructor(loader: ZipLoader, private readonly signal?: AbortSignal) {
    this.loader = loader;
  }

  private checkAbort(): void {
    this.signal?.throwIfAborted();
  }

  private getParser(): DOMParser {
    if (typeof DOMParser !== 'undefined') return new DOMParser();
    throw new Error('DOMParser is not available');
  }

  private async loadXML(uri: string): Promise<Document | null> {
    this.checkAbort();
    const str = await this.loader.loadText(uri);
    this.checkAbort();
    if (!str) {
      return null;
    }
    const parser = this.getParser();
    try {
      const doc = parser.parseFromString(str, MIME.XML);
      const parserError = doc.querySelector('parsererror');
      if (parserError) {
        return parser.parseFromString(str, MIME.HTML);
      }
      return doc;
    } catch {
      return parser.parseFromString(str, MIME.HTML);
    }
  }

  private async loadStrictEncryptionXML(): Promise<Document | null> {
    this.checkAbort();
    const source = await this.loader.loadText('META-INF/encryption.xml');
    this.checkAbort();
    if (source === null) return null;
    const doc = this.getParser().parseFromString(source, MIME.XML);
    if (doc.querySelector('parsererror')) {
      throw new Error('This document appears to be DRM-protected and cannot be opened by Interleaf.');
    }
    return doc;
  }

  private validateEncryption(encryptionDoc: Document | null): void {
    if (!encryptionDoc) return;
    const allElements = Array.from(encryptionDoc.getElementsByTagName('*'));
    const encryptedDataByName = allElements.filter((element) => element.localName === 'EncryptedData');
    const malformedEncryptionElement = allElements.some((element) =>
      ['EncryptedData', 'EncryptionMethod', 'CipherData', 'CipherReference'].includes(element.localName) &&
      element.namespaceURI !== NS.ENC
    );
    if (encryptedDataByName.length === 0 || malformedEncryptionElement) {
      throw new Error('This document appears to be DRM-protected and cannot be opened by Interleaf.');
    }

    for (const element of encryptedDataByName) {
      const methods = Array.from(element.getElementsByTagNameNS(NS.ENC, 'EncryptionMethod'));
      const cipherData = Array.from(element.getElementsByTagNameNS(NS.ENC, 'CipherData'));
      const cipherReferences = Array.from(element.getElementsByTagNameNS(NS.ENC, 'CipherReference'));
      const directChildren = Array.from(element.children);
      const directMethods = directChildren.filter((child) =>
        child.localName === 'EncryptionMethod' && child.namespaceURI === NS.ENC
      );
      const directCipherData = directChildren.filter((child) =>
        child.localName === 'CipherData' && child.namespaceURI === NS.ENC
      );
      const directCipherReferences = directCipherData[0]
        ? Array.from(directCipherData[0].children).filter((child) =>
            child.localName === 'CipherReference' && child.namespaceURI === NS.ENC
          )
        : [];
      if (
        methods.length !== 1 || cipherData.length !== 1 || cipherReferences.length !== 1 ||
        directMethods.length !== 1 || directCipherData.length !== 1 ||
        directCipherReferences.length !== 1 || directCipherReferences[0] !== cipherReferences[0]
      ) {
        throw new Error('This document appears to be DRM-protected and cannot be opened by Interleaf.');
      }
      const method = methods[0];
      const cipherReference = cipherReferences[0];
      const algorithm = method?.getAttribute('Algorithm') ?? '';
      const uri = cipherReference?.getAttribute('URI')?.trim() ?? '';
      const target = uri ? this.manifestByHref.get(resolveURL(uri, '')) : undefined;
      if (!FONT_OBFUSCATION_ALGORITHMS.has(algorithm) || !target || !isFontMimeType(target.mediaType)) {
        throw new Error('This document appears to be DRM-protected and cannot be opened by Interleaf.');
      }
    }
  }

  async init(): Promise<this> {
    this.checkAbort();
    // 1. Check container.xml
    const containerDoc = await this.loadXML('META-INF/container.xml');
    if (!containerDoc) {
      throw new Error('Invalid EPUB: Missing META-INF/container.xml');
    }

    const rootfile = containerDoc.querySelector('rootfile');
    const fullPath = rootfile?.getAttribute('full-path');
    if (!fullPath) {
      throw new Error('Invalid EPUB: No package document defined in container.xml');
    }
    this.opfPath = fullPath;

    // Parse the descriptor strictly now, then classify its targets only after
    // the package manifest is available. Malformed descriptors fail closed.
    const encryptionDoc = await this.loadStrictEncryptionXML();

    // 3. Load OPF document
    const opf = await this.loadXML(this.opfPath);
    if (!opf) {
      throw new Error(`Invalid EPUB: Failed to load package document at ${this.opfPath}`);
    }

    // Parse metadata
    const getMetadataText = (localName: string): string =>
      (opf.getElementsByTagNameNS(NS.DC, localName)[0] ?? opf.querySelector(localName))
        ?.textContent.trim() ?? '';
    const titleText = getMetadataText('title');
    const creatorText = getMetadataText('creator');
    const langText = getMetadataText('language');
    const idText = getMetadataText('identifier');

    this.metadata = {
      ...(titleText ? { title: titleText } : {}),
      ...(creatorText ? { creator: creatorText } : {}),
      ...(langText ? { language: langText } : {}),
      ...(idText ? { identifier: idText } : {}),
    };

    // Parse manifest
    const manifestEl = opf.getElementsByTagNameNS(NS.OPF, 'manifest')[0] ?? opf.querySelector('manifest');
    const manifestItems = manifestEl
      ? Array.from(manifestEl.getElementsByTagNameNS(NS.OPF, 'item').length > 0
          ? manifestEl.getElementsByTagNameNS(NS.OPF, 'item')
          : manifestEl.querySelectorAll('item'))
      : [];

    for (const item of manifestItems) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type');
      if (id && href && mediaType) {
        const resolvedHref = resolveURL(href, this.opfPath);
        const props = item.getAttribute('properties')?.split(/\s+/);
        const mediaOverlay = item.getAttribute('media-overlay');
        const manifestItem: ManifestItem = {
          id,
          href: resolvedHref,
          mediaType,
          ...(props && props.length > 0 ? { properties: props } : {}),
          ...(mediaOverlay ? { mediaOverlay } : {}),
        };
        this.manifest.set(id, manifestItem);
        this.manifestByHref.set(resolvedHref, manifestItem);
      }
    }

    this.validateEncryption(encryptionDoc);

    // Parse spine
    const spineEl = opf.getElementsByTagNameNS(NS.OPF, 'spine')[0] ?? opf.querySelector('spine');
    const itemrefs = spineEl
      ? Array.from(spineEl.getElementsByTagNameNS(NS.OPF, 'itemref').length > 0
          ? spineEl.getElementsByTagNameNS(NS.OPF, 'itemref')
          : spineEl.querySelectorAll('itemref'))
      : [];

    this.spine = itemrefs
      .map((itemref) => {
        const idref = itemref.getAttribute('idref') ?? '';
        const linear = itemref.getAttribute('linear') ?? 'yes';
        const props = itemref.getAttribute('properties')?.split(/\s+/);
        return {
          idref,
          linear,
          ...(props && props.length > 0 ? { properties: props } : {}),
        };
      })
      .filter((s) => Boolean(s.idref && this.manifest.has(s.idref)));

    // Generate CFIs for each spine item (/6/2, /6/4, /6/6...)
    this.spineCfis = this.spine.map((_, i) => `/6/${String((i + 1) * 2)}`);

    // Build sections
    this.sections = this.spine.map((spineItem, index) => {
      const item = this.manifest.get(spineItem.idref);
      const cfi = this.spineCfis[index];
      if (!item || !cfi) {
        throw new Error(`Invalid EPUB: missing manifest entry or CFI for spine item ${spineItem.idref}`);
      }
      return {
        id: item.href,
        index,
        cfi,
        ...(spineItem.linear ? { linear: spineItem.linear } : {}),
        size: this.loader.getSize(item.href),
        load: () => this.loadSectionHtml(item),
        unload: () => { this.unloadSection(); },
        createDocument: () => this.loadDocument(item),
        resolveHref: (href: string) => resolveURL(href, item.href),
      };
    });

    // Parse TOC (Nav doc or NCX)
    await this.parseTableOfContents();

    return this;
  }

  private async parseTableOfContents(): Promise<void> {
    // 1. Try EPUB 3 Nav Document
    const navItem = Array.from(this.manifest.values()).find((item) =>
      item.properties?.includes('nav')
    );
    if (navItem) {
      try {
        const navDoc = await this.loadXML(navItem.href);
        if (navDoc) {
          const navEl =
            navDoc.querySelector('nav[*|type="toc"]') ??
            navDoc.querySelector('nav[epub\\:type="toc"]') ??
            navDoc.querySelector('nav');
          if (navEl) {
            const ol = navEl.querySelector('ol');
            if (ol) {
              this.toc = this.parseNavList(ol, navItem.href);
              if (this.toc.length > 0) return;
            }
          }
        }
      } catch {
        // Fallback to NCX
      }
    }

    // 2. Try EPUB 2 NCX Document
    const ncxItem = Array.from(this.manifest.values()).find(
      (item) => item.mediaType === MIME.NCX || item.id === 'ncx'
    );
    if (ncxItem) {
      try {
        const ncxDoc = await this.loadXML(ncxItem.href);
        if (ncxDoc) {
          const navMap = ncxDoc.querySelector('navMap');
          if (navMap) {
            this.toc = this.parseNcxNavPoints(navMap, ncxItem.href);
            return;
          }
        }
      } catch {
        // No TOC
      }
    }

    // 3. Fallback: generate synthetic TOC from spine items
    this.toc = this.sections.map((section, idx) => ({
      label: `Section ${String(idx + 1)}`,
      href: section.id,
    }));
  }

  private parseNavList(ol: Element, baseHref: string): EpubTOCItem[] {
    const items: EpubTOCItem[] = [];
    const directLis = Array.from(ol.children).filter((el) => el.tagName.toLowerCase() === 'li');

    for (const li of directLis) {
      const anchor = li.querySelector('a') ?? li.querySelector('span');
      const labelText = anchor?.textContent.trim();
      const label = labelText?.length ? labelText : 'Untitled';
      const rawHref = anchor?.getAttribute('href') ?? '';
      const href = rawHref ? resolveURL(rawHref, baseHref) : baseHref;
      const childOl = li.querySelector('ol');
      const subitems = childOl ? this.parseNavList(childOl, baseHref) : undefined;
      items.push({
        label,
        href,
        ...(subitems && subitems.length > 0 ? { subitems } : {}),
      });
    }
    return items;
  }

  private parseNcxNavPoints(parent: Element, baseHref: string): EpubTOCItem[] {
    const items: EpubTOCItem[] = [];
    const navPoints = Array.from(parent.children).filter((el) => el.tagName.toLowerCase() === 'navpoint');

    for (const np of navPoints) {
      const textEl = np.querySelector('navLabel > text');
      const contentEl = np.querySelector('content');
      const label = textEl?.textContent.trim() ?? 'Untitled';
      const src = contentEl?.getAttribute('src') ?? '';
      const href = src ? resolveURL(src, baseHref) : baseHref;
      const subitems = this.parseNcxNavPoints(np, baseHref);
      items.push({
        label,
        href,
        ...(subitems.length > 0 ? { subitems } : {}),
      });
    }
    return items;
  }

  async loadDocument(item: ManifestItem): Promise<Document> {
    this.checkAbort();
    const rawText = await this.loader.loadText(item.href);
    this.checkAbort();
    const sanitized = sanitizeEbookHtml(rawText ?? '');
    // Parse as text/html, not application/xhtml+xml: XML-mode documents expose
    // no `document.body` (jsdom), and XHTML strictness breaks on common named
    // entities in real-world EPUBs. Content is already sanitized, so HTML mode
    // is safe.
    return this.getParser().parseFromString(sanitized, MIME.HTML);
  }

  async loadSectionHtml(item: ManifestItem): Promise<string> {
    this.checkAbort();
    const rawText = await this.loader.loadText(item.href);
    this.checkAbort();
    if (!rawText) return '<html><body></body></html>';

    // 1. Sanitize raw HTML string through strict DOMPurify policy
    const sanitized = sanitizeEbookHtml(rawText);

    // 2. Parse into a detached DOM to rewrite internal raster images. Book CSS
    // and style attributes are deliberately stripped by the sanitizer; only
    // Interleaf-owned typography enters the live reader frame.
    const doc = this.getParser().parseFromString(sanitized, MIME.HTML);

    // Replace images
    const images = Array.from(doc.querySelectorAll('img, image'));
    for (const img of images) {
      const srcAttr = img.getAttribute('src');
      const src = srcAttr ?? img.getAttribute('xlink:href');
      if (src && !isExternal(src)) {
        const resolved = resolveURL(src, item.href);
        const blobUrl = await this.getOrCreateBlobUrl(resolved);
        if (blobUrl) {
          if (img.hasAttribute('src')) img.setAttribute('src', blobUrl);
          if (img.hasAttribute('xlink:href')) img.setAttribute('xlink:href', blobUrl);
        }
      }
    }

    return new XMLSerializer().serializeToString(doc);
  }

  private async getOrCreateBlobUrl(href: string): Promise<string | null> {
    const existing = this.blobUrls.get(href);
    if (existing) return existing;
    const manifestItem = this.manifestByHref.get(href);
    const mimeType = manifestItem?.mediaType;
    if (!mimeType || !SAFE_RASTER_MIME_TYPES.has(mimeType.toLowerCase())) {
      return null;
    }
    const blob = await this.loader.loadBlob(href, mimeType);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(href, url);
    return url;
  }

  private unloadSection(): void {
    // Raster resource URLs are book-scoped because multiple sections may
    // reference the same resource. They are revoked together in destroy().
  }

  resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Element | null } | null {
    const parsed = CFI.parse(cfi);
    const parts = Array.isArray(parsed) ? parsed : parsed.parent;
    const spineIndex = CFI.fake.toIndex(parts[0]);
    if (spineIndex >= 0 && spineIndex < this.sections.length) {
      return {
        index: spineIndex,
        anchor: (doc: Document) => {
          try {
            return CFI.toRange(doc, cfi);
          } catch {
            return null;
          }
        },
      };
    }
    return null;
  }

  resolveHref(href: string): { index: number; anchor: (doc: Document) => Element | null } | null {
    const [path, hash] = href.split('#');
    const decodedPath = decodeURI(path ?? '');
    const index = this.sections.findIndex((s) => s.id === decodedPath || s.id.endsWith(decodedPath));
    if (index < 0) return null;

    return {
      index,
      anchor: (doc: Document) => (hash ? doc.getElementById(hash) ?? doc.querySelector(`[name="${CSS.escape(hash)}"]`) : doc.body),
    };
  }

  splitTOCHref(href: string): [string, string?] {
    const [path, hash] = href.split('#');
    return hash !== undefined ? [path ?? '', hash] : [path ?? ''];
  }

  getTOCFragment(doc: Document, id: string): Element | null {
    return doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`);
  }

  async getCoverBlob(): Promise<Blob | null> {
    const coverItem = Array.from(this.manifest.values()).find(
      (item) => (item.properties?.includes('cover-image') ?? false) || item.id.toLowerCase().includes('cover')
    );
    if (!coverItem) return null;
    return this.loader.loadBlob(coverItem.href, coverItem.mediaType);
  }

  destroy(): void {
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    this.loader.destroy();
  }
}
