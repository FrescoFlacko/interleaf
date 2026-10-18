// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  calculateDestinationOffset,
  enhanceLinkAnnotations,
  parseSafeExternalUrl,
  PdfLinkService,
  resolvePdfDestination,
  type PdfDestinationPage,
  type PdfDestinationSource,
  type PdfDestinationViewport,
} from '../../src/renderer/features/reader/adapters/pdf-link-service';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { TestCanvasContext } from '../helpers/canvas-context';
import { testIntersectionObserverEntry } from '../helpers/intersection-observer';
import { testDocumentSource } from '../helpers/document-source';

describe('PDF Link Annotations & Destination Resolution', () => {
  describe('parseSafeExternalUrl', () => {
    it('accepts valid https, http, and mailto URLs', () => {
      expect(parseSafeExternalUrl('https://example.com/test')).toBe('https://example.com/test');
      expect(parseSafeExternalUrl('http://example.com/page?query=1#hash')).toBe('http://example.com/page?query=1#hash');
      expect(parseSafeExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    });

    it('rejects unsafe schemes fail-closed', () => {
      expect(parseSafeExternalUrl('javascript:alert(1)')).toBeNull();
      expect(parseSafeExternalUrl('javascript:void(0)')).toBeNull();
      expect(parseSafeExternalUrl('file:///etc/passwd')).toBeNull();
      expect(parseSafeExternalUrl('file:///C:/Windows/System32')).toBeNull();
      expect(parseSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(parseSafeExternalUrl('blob:http://localhost/uuid')).toBeNull();
      expect(parseSafeExternalUrl('interleaf-media://asset-123')).toBeNull();
      expect(parseSafeExternalUrl('custom-proto://execute')).toBeNull();
    });

    it('rejects malformed, empty, or oversized URLs', () => {
      expect(parseSafeExternalUrl('')).toBeNull();
      expect(parseSafeExternalUrl('   ')).toBeNull();
      expect(parseSafeExternalUrl(null)).toBeNull();
      expect(parseSafeExternalUrl(undefined)).toBeNull();
      expect(parseSafeExternalUrl(123)).toBeNull();
      expect(parseSafeExternalUrl('not a url')).toBeNull();
      expect(parseSafeExternalUrl('https://')).toBeNull();
      expect(parseSafeExternalUrl(`https://example.com/${'x'.repeat(2100)}`)).toBeNull();
    });
  });

  describe('resolvePdfDestination', () => {
    const mockPdfDoc: PdfDestinationSource = {
      getDestination: vi.fn(async (name: string) => {
        await Promise.resolve();
        if (name === 'known-dest') {
          return [{ num: 10, gen: 0 }, { name: 'XYZ' }, 72, 594, null];
        }
        if (name === 'int-dest') {
          return [1, { name: 'FitH' }, 700];
        }
        return null;
      }),
      getPageIndex: vi.fn(async (ref: { num: number; gen: number }) => {
        await Promise.resolve();
        if (ref.num === 10) return 2;
        throw new Error('Unknown ref');
      }),
    };

    it('resolves named destinations with Ref proxy page references', async () => {
      const resolved = await resolvePdfDestination(mockPdfDoc, 'known-dest', 5);
      expect(resolved).toEqual({
        pageIndex: 2,
        pageNumber: 3,
        modeName: 'XYZ',
        args: [72, 594, null],
      });
    });

    it('resolves named destinations with integer page references', async () => {
      const resolved = await resolvePdfDestination(mockPdfDoc, 'int-dest', 5);
      expect(resolved).toEqual({
        pageIndex: 1,
        pageNumber: 2,
        modeName: 'FitH',
        args: [700],
      });
    });

    it('resolves explicit destination arrays directly', async () => {
      const resolved = await resolvePdfDestination(
        mockPdfDoc,
        [{ num: 10, gen: 0 }, { name: 'Fit' }],
        5
      );
      expect(resolved).toEqual({
        pageIndex: 2,
        pageNumber: 3,
        modeName: 'Fit',
        args: [],
      });
    });

    it('handles string mode names in destination arrays', async () => {
      const resolved = await resolvePdfDestination(
        mockPdfDoc,
        [0, 'FitV', 100],
        5
      );
      expect(resolved).toEqual({
        pageIndex: 0,
        pageNumber: 1,
        modeName: 'FitV',
        args: [100],
      });
    });

    it('rejects out-of-bounds page indices', async () => {
      expect(await resolvePdfDestination(mockPdfDoc, [-1, 'XYZ'], 5)).toBeNull();
      expect(await resolvePdfDestination(mockPdfDoc, [5, 'XYZ'], 5)).toBeNull();
      expect(await resolvePdfDestination(mockPdfDoc, [100, 'XYZ'], 5)).toBeNull();
    });

    it('rejects unknown or malformed destinations fail-closed', async () => {
      expect(await resolvePdfDestination(mockPdfDoc, 'unknown-dest', 5)).toBeNull();
      expect(await resolvePdfDestination(mockPdfDoc, null, 5)).toBeNull();
      expect(await resolvePdfDestination(mockPdfDoc, [], 5)).toBeNull();
      expect(await resolvePdfDestination(mockPdfDoc, [{ num: 999, gen: 0 }, 'Fit'], 5)).toBeNull();
    });
  });

  describe('calculateDestinationOffset', () => {
    const mockPage: PdfDestinationPage = { view: [0, 0, 612, 792] };

    const mockViewport: PdfDestinationViewport = {
      height: 792,
      convertToViewportPoint: vi.fn((x: number, y: number): [number, number] => [x, 792 - y]),
    };

    it('calculates vertical offset for XYZ mode', () => {
      const offset = calculateDestinationOffset(mockPage, mockViewport, 'XYZ', [72, 594]);
      expect(offset).toBe(792 - 594);
    });

    it('defaults to page top in XYZ mode when y is null or omitted', () => {
      const offset = calculateDestinationOffset(mockPage, mockViewport, 'XYZ', [72, null]);
      expect(offset).toBe(0);
    });

    it('calculates vertical offset for FitH and FitBH modes', () => {
      const offsetH = calculateDestinationOffset(mockPage, mockViewport, 'FitH', [700]);
      expect(offsetH).toBe(792 - 700);

      const offsetBH = calculateDestinationOffset(mockPage, mockViewport, 'FitBH', [650]);
      expect(offsetBH).toBe(792 - 650);
    });

    it('calculates vertical offset for FitR mode', () => {
      const offsetR = calculateDestinationOffset(mockPage, mockViewport, 'FitR', [72, 100, 500, 750]);
      expect(offsetR).toBe(792 - 750);
    });

    it('returns 0 offset for Fit, FitB, FitV, FitBV modes', () => {
      expect(calculateDestinationOffset(mockPage, mockViewport, 'Fit', [])).toBe(0);
      expect(calculateDestinationOffset(mockPage, mockViewport, 'FitB', [])).toBe(0);
      expect(calculateDestinationOffset(mockPage, mockViewport, 'FitV', [100])).toBe(0);
      expect(calculateDestinationOffset(mockPage, mockViewport, 'FitBV', [100])).toBe(0);
    });
  });

  describe('enhanceLinkAnnotations', () => {
    it('sets tabindex=0 and accessible aria-label on links', () => {
      const container = document.createElement('div');
      container.innerHTML = `
        <section class="linkAnnotation">
          <a title="Chapter 1: Foundations" href="#chapter.1"></a>
        </section>
        <section class="linkAnnotation">
          <a href="https://example.com/test"></a>
        </section>
      `;

      enhanceLinkAnnotations(container);

      const anchors = container.querySelectorAll<HTMLAnchorElement>('.linkAnnotation > a');
      expect(anchors[0]?.getAttribute('tabindex')).toBe('0');
      expect(anchors[0]?.getAttribute('aria-label')).toBe('Chapter 1: Foundations');

      expect(anchors[1]?.getAttribute('tabindex')).toBe('0');
      expect(anchors[1]?.getAttribute('aria-label')).toBe('External link to https://example.com/test');
    });

    it('handles Enter and Space keydown events to activate links', () => {
      const container = document.createElement('div');
      container.innerHTML = `
        <section class="linkAnnotation">
          <a href="#test"></a>
        </section>
      `;
      enhanceLinkAnnotations(container);

      const a = container.querySelector<HTMLAnchorElement>('a')!;
      const clickSpy = vi.fn();
      a.onclick = clickSpy;

      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      a.dispatchEvent(enterEvent);
      expect(enterEvent.defaultPrevented).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(1);

      const spaceEvent = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
      a.dispatchEvent(spaceEvent);
      expect(spaceEvent.defaultPrevented).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('PdfLinkService', () => {
    it('returns valid destination hashes', () => {
      const host = {
        goToDestination: vi.fn(),
        goToPage: vi.fn(),
        handleExternalLink: vi.fn(),
        getCurrentPage: () => 1,
        getPageCount: () => 5,
      };
      const service = new PdfLinkService(host);

      expect(service.getDestinationHash('named.1')).toBe('#named.1');
      expect(service.getDestinationHash([1, 'XYZ'])).toBe('#[1,"XYZ"]');
      expect(service.getDestinationHash(null)).toBe('#');
      expect(service.getAnchorUrl('#hash')).toBe('#hash');
    });

    it('sets safe external links and prevents direct renderer navigation', () => {
      const host = {
        goToDestination: vi.fn(),
        goToPage: vi.fn(),
        handleExternalLink: vi.fn(),
        getCurrentPage: () => 1,
        getPageCount: () => 5,
      };
      const service = new PdfLinkService(host);
      const link = document.createElement('a');

      service.addLinkAttributes(link, 'https://example.com/interleaf');
      expect(link.href).toBe('https://example.com/interleaf');
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');

      const clickEvent = new MouseEvent('click', { cancelable: true });
      link.dispatchEvent(clickEvent);
      expect(clickEvent.defaultPrevented).toBe(true);
      expect(host.handleExternalLink).toHaveBeenCalledWith('https://example.com/interleaf');
    });

    it('disarms unsafe external URLs fail-closed', () => {
      const host = {
        goToDestination: vi.fn(),
        goToPage: vi.fn(),
        handleExternalLink: vi.fn(),
        getCurrentPage: () => 1,
        getPageCount: () => 5,
      };
      const service = new PdfLinkService(host);
      const link = document.createElement('a');

      service.addLinkAttributes(link, 'javascript:alert(1)');
      expect(link.hasAttribute('href')).toBe(false);
      expect(link.getAttribute('data-unsafe-link')).toBe('true');

      const clickEvent = new MouseEvent('click', { cancelable: true });
      link.dispatchEvent(clickEvent);
      expect(clickEvent.defaultPrevented).toBe(true);
      expect(host.handleExternalLink).not.toHaveBeenCalled();
    });

    it('executes named page actions and fails closed on unknown actions', () => {
      const host = {
        goToDestination: vi.fn(),
        goToPage: vi.fn(),
        handleExternalLink: vi.fn(),
        getCurrentPage: () => 2,
        getPageCount: () => 5,
      };
      const service = new PdfLinkService(host);

      service.executeNamedAction('NextPage');
      expect(host.goToPage).toHaveBeenCalledWith(3);

      service.executeNamedAction('PrevPage');
      expect(host.goToPage).toHaveBeenCalledWith(1);

      service.executeNamedAction('FirstPage');
      expect(host.goToPage).toHaveBeenCalledWith(1);

      service.executeNamedAction('LastPage');
      expect(host.goToPage).toHaveBeenCalledWith(5);

      service.executeNamedAction('Print');
      expect(host.goToPage).toHaveBeenCalledTimes(4); // No extra call
    });
  });

  describe('PdfAdapter integration: link layer rendering and lifecycle', () => {
    let container: HTMLElement;
    let adapter: PdfAdapter;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const originalIntersectionObserver = globalThis.IntersectionObserver;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      adapter = new PdfAdapter();

      class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = '600px 0px 600px 0px';
        readonly scrollMargin = '0px 0px 0px 0px';
        readonly thresholds = [0.01];
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element): void {
          this.callback([
            testIntersectionObserverEntry({
              target,
              isIntersecting: true,
              rootBounds: container.getBoundingClientRect(),
            }),
          ], this);
        }
        unobserve(): void {
          // no-op in mock
        }
        disconnect(): void {
          // no-op in mock
        }
        takeRecords(): IntersectionObserverEntry[] { return []; }
      }
      globalThis.IntersectionObserver = MockIntersectionObserver;

      const getContextMock = function (this: HTMLCanvasElement, contextId: string): CanvasRenderingContext2D | null {
        return contextId === '2d' ? new TestCanvasContext(this) : null;
      };
     Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: getContextMock,
      });

      Element.prototype.getBoundingClientRect = function () {
        const pageNumAttr = this.getAttribute('data-page-number');
        if (pageNumAttr) {
          const pageNum = Number(pageNumAttr);
          const top = (pageNum - 1) * 800;
          return {
            top, bottom: top + 792, left: 0, right: 612,
            width: 612, height: 792, x: 0, y: top, toJSON: () => ({}),
          };
        }
        return {
          top: 0, bottom: 600, left: 0, right: 800,
          width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
        };
      };
    });

    afterEach(async () => {
      await adapter.close();
      container.remove();
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: originalGetContext,
      });
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      globalThis.IntersectionObserver = originalIntersectionObserver;
    });

    it('renders interactive link annotations and navigates internal destinations', async () => {
      const pdfBuffer = makePdfFixture({
        title: 'Interactive Links Document',
        pages: ['Page 1: Table of contents with internal and external links.', 'Page 2: Target chapter content.'],
        links: [
          {
            pageNumber: 1,
            rect: [72, 700, 250, 720],
            targetPage: 2,
            destMode: 'XYZ',
            destCoords: [72, 720],
          },
          {
            pageNumber: 1,
            rect: [72, 650, 300, 670],
            url: 'https://example.com/interleaf-external',
          },
        ],
      });

      const base64 = pdfBuffer.toString('base64');
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-links-test',
        assetUrl: `data:application/pdf;base64,${base64}`,
      }));

      await waitFor(() => {
        expect(container.querySelector<HTMLElement>('[data-page-number="1"] .annotationLayer')).not.toBeNull();
      });
      const annotationLayer = container.querySelector<HTMLElement>('[data-page-number="1"] .annotationLayer');
      expect(annotationLayer?.getAttribute('data-testid')).toBe('pdf-annotationlayer-p1');

      const links = annotationLayer?.querySelectorAll<HTMLAnchorElement>('.linkAnnotation > a');
      expect(links?.length).toBe(2);

      // Link 1: Internal link
      const internalLink = links?.[0];
      expect(internalLink?.getAttribute('tabindex')).toBe('0');
      expect(internalLink?.getAttribute('aria-label')).toBeTruthy();

      // Click internal link
      internalLink?.click();

      // Destination resolution navigates to Page 2
      await waitFor(() => {
        expect(adapter.getCurrentPage()).toBe(2);
      });
      // Link 2: External link
      const externalLink = links?.[1];
      expect(externalLink?.href).toBe('https://example.com/interleaf-external');

      const externalCallback = vi.fn();
      adapter.setExternalLinkCallback(externalCallback);

      externalLink?.click();
      expect(externalCallback).toHaveBeenCalledWith('https://example.com/interleaf-external');
    });

    it('cleans up annotation layers on virtualization and close', async () => {
      const pdfBuffer = makePdfFixture({
        title: 'Virtualization Links Document',
        pages: ['Page 1', 'Page 2'],
        links: [
          {
            pageNumber: 1,
            rect: [72, 700, 250, 720],
            targetPage: 2,
          },
        ],
      });

      const base64 = pdfBuffer.toString('base64');
      await adapter.open(container, testDocumentSource({
        documentId: 'doc-virt-test',
        assetUrl: `data:application/pdf;base64,${base64}`,
      }));
      await waitFor(() => {
        expect(container.querySelector('[data-page-number="1"] .annotationLayer')).not.toBeNull();
      });
      // Close adapter
      await adapter.close();
      expect(container.querySelector('.annotationLayer')).toBeNull();
    });

    it('does not attach stale annotation layers if render is superseded before completion', async () => {
      const pdfBuffer = makePdfFixture({
        title: 'Stale Links Document',
        pages: ['Page 1', 'Page 2'],
        links: [
          {
            pageNumber: 1,
            rect: [72, 700, 250, 720],
            targetPage: 2,
          },
        ],
      });

      const base64 = pdfBuffer.toString('base64');
      const openPromise = adapter.open(container, testDocumentSource({
        documentId: 'doc-stale-test',
        assetUrl: `data:application/pdf;base64,${base64}`,
      }));

      // Immediately close while in flight
      await adapter.close();
      await openPromise.catch(() => undefined);

      expect(container.querySelector('.annotationLayer')).toBeNull();
    });
  });
  /**
   * Following a PDF's link out of the document.
   *
   * A link annotation is untrusted data. The adapter neither navigates nor
   * reaches for Electron: it reports the target to whoever mounted it, and that
   * host is the only party that can ask main to open it. With no host listening
   * — before mount, or after the document is closed — the click does nothing.
   */
  describe('PdfAdapter external link reporting', () => {
    it('reports the target to the mounted host', async () => {
      const adapter = new PdfAdapter();
      const onExternalLink = vi.fn();
      adapter.setExternalLinkCallback(onExternalLink);

      await adapter.handleExternalLink('https://example.org/paper.html');

      expect(onExternalLink).toHaveBeenCalledExactlyOnceWith('https://example.org/paper.html');
    });

    it('does nothing when no host is listening, before mount or after close', async () => {
      const adapter = new PdfAdapter();
      await expect(adapter.handleExternalLink('https://example.org/')).resolves.toBeUndefined();

      const onExternalLink = vi.fn();
      adapter.setExternalLinkCallback(onExternalLink);
      await adapter.close();
      await adapter.handleExternalLink('https://example.org/');

      expect(onExternalLink).not.toHaveBeenCalled();
    });
  });
});
