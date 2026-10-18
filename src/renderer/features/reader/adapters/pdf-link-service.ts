import * as pdfjsLib from 'pdfjs-dist';
import type { PortableMember } from '@shared/models/portable';

type PageRef = Parameters<pdfjsLib.PDFDocumentProxy['getPageIndex']>[0];

/**
 * The display mode of an explicit destination (`XYZ`, `FitH`, ...), as it
 * appears in the destination array.
 */
type PdfDestinationMode = { readonly name: string };

/**
 * One member of an explicit destination array. pdf.js types the array as
 * `any[]`; the members a conforming destination can hold are the target page
 * reference, the display mode, and the mode's numeric arguments, which the
 * format allows to be null. Every member is still re-checked where it is read,
 * because the array comes from an untrusted document.
 */
export type PdfDestinationMember = PageRef | PdfDestinationMode | number | string | null;

/**
 * A PDF destination: either the name of one recorded in the document's
 * destination table, or the explicit `[page, mode, ...args]` array itself.
 */
export type PdfDestination = string | readonly PdfDestinationMember[];

/** Allowlisted external protocols for PDF Link annotations. */
const SAFE_EXTERNAL_PROTOCOLS: Record<string, true> = {
  'http:': true,
  'https:': true,
  'mailto:': true,
};
/**
 * Validates and normalizes an untrusted URL from a PDF Link annotation.
 * Fails closed on any non-allowlisted scheme (e.g. javascript, file, data),
 * malformed target, or empty input.
 *
 * The value comes straight out of the document's annotation dictionary, so it
 * arrives as whatever the file put there: anything that is not a string is
 * rejected here rather than trusted to be one.
 */
export function parseSafeExternalUrl(raw: PortableMember): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  try {
    const parsed = new URL(trimmed);
    if (SAFE_EXTERNAL_PROTOCOLS[parsed.protocol] !== true) {
      return null;
    }
    // http/https must have a hostname
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** The part of the document proxy destination resolution uses. Structural so
 * the outline mapper and focused tests can supply exactly these two lookups. */
export type PdfDestinationResolver = PdfDestinationSource;

export type ResolvedPdfDestination = {
  readonly pageIndex: number;
  readonly pageNumber: number;
  readonly modeName: string;
  readonly args: readonly PdfDestinationMember[];
};

/** The part of an open document destination resolution consults. */
export type PdfDestinationSource = Pick<pdfjsLib.PDFDocumentProxy, 'getDestination' | 'getPageIndex'>;

/** The part of a rendered page's geometry destination offsets are measured in. */
export type PdfDestinationViewport = Pick<pdfjsLib.PageViewport, 'height' | 'convertToViewportPoint'>;

/** The part of a page destination offsets read: its media box. */
export type PdfDestinationPage = Pick<pdfjsLib.PDFPageProxy, 'view'>;

/**
 * Resolves a named or explicit PDF destination into a validated page index and mode.
 * Safe against malformed destinations, missing refs, and out-of-bounds page numbers.
 */
export async function resolvePdfDestination(
  pdfDoc: PdfDestinationResolver,
  dest: PdfDestination | null | undefined,
  pageCount: number
): Promise<ResolvedPdfDestination | null> {
  if (!dest) return null;

  let explicitDest: readonly PdfDestinationMember[] | null = typeof dest === 'string' ? null : dest;
  if (typeof dest === 'string') {
    try {
      explicitDest = (await pdfDoc.getDestination(dest)) as readonly PdfDestinationMember[] | null;
    } catch {
      return null;
    }
  }

  if (!explicitDest || explicitDest.length === 0) {
    return null;
  }

  const destRef = explicitDest[0];
  const modeObj = explicitDest[1];
  const args = explicitDest.slice(2);
  let pageIndex: number | null = null;

  if (typeof destRef === 'number' && Number.isInteger(destRef)) {
    pageIndex = destRef;
  } else if (typeof destRef === 'object' && destRef !== null && 'num' in destRef) {
    try {
      pageIndex = await pdfDoc.getPageIndex(destRef);
    } catch {
      return null;
    }
  }
  if (typeof pageIndex !== 'number' || pageIndex < 0 || pageIndex >= pageCount) {
    return null;
  }


  let modeName = 'Fit';
  if (typeof modeObj === 'string') {
    modeName = modeObj;
  } else if (typeof modeObj === 'object' && modeObj !== null && 'name' in modeObj) {
    modeName = modeObj.name;
  }

  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    modeName,
    args,
  };
}

/**
 * pdf.js declares the conversion as returning `any[]`; it is the `[x, y]` pair
 * in viewport space. Only the vertical component is used for scrolling.
 */
function viewportY(viewport: PdfDestinationViewport, x: number, y: number): number {
  const point = viewport.convertToViewportPoint(x, y) as readonly number[];
  return point[1] ?? 0;
}

function clampToPage(viewport: PdfDestinationViewport, offset: number): number {
  return Math.max(0, Math.min(viewport.height, offset));
}

/**
 * Calculates the vertical pixel offset from the top of the rendered page for
 * standard PDF destination modes (XYZ, Fit, FitH, FitV, FitR, FitB, FitBH, FitBV).
 */
export function calculateDestinationOffset(
  page: PdfDestinationPage,
  viewport: PdfDestinationViewport,
  modeName: string,
  args: readonly PdfDestinationMember[]
): number {
  switch (modeName) {
    case 'XYZ': {
      const x = typeof args[0] === 'number' ? args[0] : 0;
      const pageTop = page.view[3] ?? viewport.height;
      const y = typeof args[1] === 'number' ? args[1] : pageTop;
      return clampToPage(viewport, viewportY(viewport, x, y));
    }
    case 'FitH':
    case 'FitBH': {
      const pageTop = page.view[3] ?? viewport.height;
      const y = typeof args[0] === 'number' ? args[0] : pageTop;
      return clampToPage(viewport, viewportY(viewport, 0, y));
    }
    case 'FitR': {
      // args: [left, bottom, right, top]
      const pageTop = page.view[3] ?? viewport.height;
      const top = typeof args[3] === 'number' ? args[3] : pageTop;
      return clampToPage(viewport, viewportY(viewport, 0, top));
    }
    case 'FitBV':
    case 'Fit':
    case 'FitB':
    default:
      return 0;
  }
}

/**
 * Post-processes rendered link elements to ensure full keyboard focusability (tabindex=0,
 * Enter/Space activation) and accessible names/labels.
 */
export function enhanceLinkAnnotations(container: HTMLElement): void {
  const anchors = container.querySelectorAll<HTMLAnchorElement>('.linkAnnotation > a');
  for (const a of anchors) {
    if (!a.hasAttribute('tabindex')) {
      a.setAttribute('tabindex', '0');
    }

    const existingLabel = a.getAttribute('aria-label');
    if (!existingLabel) {
      if (a.title && a.title.trim().length > 0) {
        a.setAttribute('aria-label', a.title.trim());
      } else {
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          const destName = href.slice(1);
          a.setAttribute('aria-label', destName ? `Go to ${destName}` : 'Internal document link');
        } else if (href) {
          a.setAttribute('aria-label', `External link to ${href}`);
        } else {
          a.setAttribute('aria-label', 'Document link');
        }
      }
    }

    a.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        a.click();
      }
    });
  }
}

export type PdfLinkServiceHost = {
  goToDestination(destination: PdfDestination): Promise<boolean>;
  goToPage(pageNumber: number): Promise<void>;
  handleExternalLink(url: string): Promise<void>;
  getCurrentPage(): number;
  getPageCount(): number;
};

/**
 * Implements the link service interface expected by PDF.js's AnnotationLayer.
 * Integrates internal GoTo navigation and external URI security into Interleaf's reader.
 */
export class PdfLinkService {
  constructor(private readonly host: PdfLinkServiceHost) {}

  getDestinationHash(destination: PdfDestination | null): string {
    if (typeof destination === 'string') return `#${destination}`;
    // pdfjs asks for the hash of a link with no destination too.
    if (destination === null) return '#';
    return `#${JSON.stringify(destination)}`;
  }

  getAnchorUrl(hash: string): string {
    return hash || '#';
  }

  async goToDestination(destination: PdfDestination): Promise<void> {
    await this.host.goToDestination(destination);
  }

  addLinkAttributes(link: HTMLAnchorElement, url: string): void {
    const safeUrl = parseSafeExternalUrl(url);
    if (!safeUrl) {
      link.removeAttribute('href');
      link.setAttribute('data-unsafe-link', 'true');
      link.onclick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        return false;
      };
      return;
    }

    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.onclick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void this.host.handleExternalLink(safeUrl);
      return false;
    };
  }

  executeNamedAction(action: string): void {
    switch (action) {
      case 'NextPage':
        void this.host.goToPage(this.host.getCurrentPage() + 1);
        break;
      case 'PrevPage':
        void this.host.goToPage(this.host.getCurrentPage() - 1);
        break;
      case 'FirstPage':
        void this.host.goToPage(1);
        break;
      case 'LastPage':
        void this.host.goToPage(this.host.getPageCount());
        break;
      default:
        // Unsupported/unknown actions fail closed
        break;
    }
  }

  executeSetOCGState(): void {
    // Unsupported fail closed
  }
}
