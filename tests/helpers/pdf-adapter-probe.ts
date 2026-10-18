import type * as pdfjsLib from 'pdfjs-dist';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';

/**
 * A `PdfAdapter` that lets the render-scheduling suite watch its own work.
 *
 * Zoom commits, epoch bumps, preview and painted scales, and in-flight render
 * tasks are not observable from the public adapter contract, and the specs that
 * cover cancellation, double buffering and resize coalescing are precisely
 * about them. The adapter keeps that bookkeeping `protected`, so this subclass
 * reads it as the class itself does: the views below are checked against the
 * real declarations, and a renamed or retyped member fails the build instead of
 * silently making a test observe nothing.
 *
 * Everything exposed here is read-only apart from the two seeding helpers,
 * which stand in for a layout the real `open` would have built.
 */
export class ProbePdfAdapter extends PdfAdapter {
  /** The loaded document. Reading it before `open` resolves is a test bug. */
  get document(): pdfjsLib.PDFDocumentProxy {
    if (this.pdfDoc === null) throw new Error('The probe adapter has no open document.');
    return this.pdfDoc;
  }

  get scale(): number {
    return this.zoom;
  }


  get epoch(): number {
    return this.renderEpoch;
  }

  get commitTimer(): number | null {
    return this.resizeCommitTimer;
  }


  get painted(): ReadonlySet<number> {
    return this.renderedPages;
  }

  get paintedScales(): ReadonlyMap<number, number> {
    return this.renderedScales;
  }

  get previewedScales(): ReadonlyMap<number, number> {
    return this.previewScales;
  }

  get pendingTokens(): ReadonlyMap<number, symbol> {
    return this.pendingRenderTokens;
  }



  get dimensions(): ReadonlyMap<number, { readonly width: number; readonly height: number }> {
    return this.pageDimensions;
  }

  /** Repaints one page, as virtualization and a zoom commit both do. */
  repaintPage(pageNumber: number): Promise<void> {
    return this.renderPage(pageNumber);
  }

  /** Tears one page's canvas and layers down, as virtualization does. */
  discardPageContent(pageNumber: number): void {
    this.destroyPageContent(pageNumber);
  }

  /**
   * Installs a page layout without loading a document.
   *
   * A selection test needs many pages of real DOM and no rendering at all, so
   * it builds the wrappers itself and seats them where `open` would have.
   */
  seedLayout(scroller: HTMLElement, wrappers: ReadonlyMap<number, HTMLElement>): void {
    this.scrollContainer = scroller;
    this.pageWrappers.clear();
    for (const [pageNumber, wrapper] of wrappers) this.pageWrappers.set(pageNumber, wrapper);
  }
}
