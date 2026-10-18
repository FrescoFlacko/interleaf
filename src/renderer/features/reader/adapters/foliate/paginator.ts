// Hardened Foliate Paginator controller ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)
// Sandboxed without allow-scripts and cross-environment safe.

import { Overlayer } from './overlayer';
import { sanitizeEbookDocument } from './sanitize';
import * as CFI from './epubcfi';
import { isDarkColor } from '@shared/constants/palette-color';

export type RelocateDetail = {
  index: number;
  progress: number;
  fraction?: number | undefined;
  range?: Range | undefined;
  cfi?: string | undefined;
};

export type PaginatorSection = {
  id: string;
  index: number;
  load: () => Promise<string>;
  unload: () => void;
  createDocument?: () => Promise<Document>;
  cfi?: string | undefined;
};

export type EbookNavigationTarget = {
  readonly index: number;
  readonly anchor?: (doc: Document) => Element | Range | null;
  readonly fraction?: number;
};

export class Paginator extends EventTarget {
  readonly element = document.createElement('div');
  private container = document.createElement('div');
  private iframe = document.createElement('iframe');
  private overlayerElement: Overlayer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private removeScrollListener: (() => void) | null = null;
  private scrollFrame: number | null = null;
  /** Top-visible text position, recorded on scroll and restored after reflow. */
  private readingAnchorRange: Range | null = null;
  private lastObservedWidth = 0;

  sections: PaginatorSection[] = [];
  private currentIndex = 0;
  private currentProgress = 0;
  private currentStyles = '';
  private isDestroyed = false;
  private navigationSequence = 0;

  constructor() {
    super();

    Object.assign(this.element.style, {
      width: '100%',
      height: '100%',
      display: 'block',
      position: 'relative',
      overflow: 'hidden',
    });

    Object.assign(this.container.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      boxSizing: 'border-box',
    });

    Object.assign(this.iframe.style, {
      border: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      boxSizing: 'border-box',
      backgroundColor: 'transparent',
    });
    this.iframe.setAttribute('sandbox', 'allow-same-origin');
    this.iframe.setAttribute('scrolling', 'auto');
    this.iframe.setAttribute('title', 'Ebook Content');
    this.iframe.setAttribute('referrerpolicy', 'no-referrer');

    this.container.appendChild(this.iframe);
    this.element.appendChild(this.container);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.isDestroyed) return;
      this.applyCurrentStyles();
      const width = this.element.clientWidth;
      // Only a width change re-wraps the section's text.
      if (width === this.lastObservedWidth) return;
      this.lastObservedWidth = width;
      this.restoreReadingAnchor();
    });
    this.resizeObserver.observe(this.element);
    this.themeObserver = new MutationObserver(() => {
      if (!this.isDestroyed) this.applyCurrentStyles();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      // App palette and the independent reader background are both DOM
      // attributes. Observe the reader ancestor so an already-open iframe
      // receives updated tokens without reopening the section.
      attributeFilter: ['data-theme', 'data-reader-background'],
    });
  }

  get overlayer(): Overlayer | null {
    return this.overlayerElement;
  }

  get document(): Document | null {
    return this.iframe.contentDocument;
  }

  get frameRect(): DOMRect {
    return this.iframe.getBoundingClientRect();
  }

  get index(): number {
    return this.currentIndex;
  }

  get progress(): number {
    return this.currentProgress;
  }

  async open(book: { sections: PaginatorSection[] }): Promise<void> {
    this.sections = book.sections;
    this.currentIndex = 0;
    this.currentProgress = 0;
    if (this.sections.length > 0) {
      await this.goToIndex(0);
    }
  }

  async goToIndex(index: number): Promise<void> {
    if (this.isDestroyed || index < 0 || index >= this.sections.length) return;

    const sequence = ++this.navigationSequence;
    this.clearScrollTracking();
    // The previous section's nodes are about to leave the frame.
    this.readingAnchorRange = null;

    this.currentIndex = index;
    const section = this.sections[index];
    if (!section) return;

    const sanitizedMarkup = await section.load();
    if (sequence !== this.navigationSequence) return;
    await this.loadIframeMarkup(sanitizedMarkup);
    if (sequence !== this.navigationSequence) return;

    const doc = this.document;
    if (doc) {
      sanitizeEbookDocument(doc);
      this.applyCurrentStyles();

      doc.addEventListener('click', (e) => {
        const eventTarget = e.target;
        const target = eventTarget instanceof Element ? eventTarget.closest('a') : null;
        if (target) {
          const href = target.getAttribute('href');
          if (href) {
            e.preventDefault();
          }
        }
      });
      this.setupScrollTracking(doc, section);
      this.lastObservedWidth = this.element.clientWidth;
      this.readingAnchorRange = this.getTopVisibleRange(doc);
    }

    this.currentProgress = (index + 1) / Math.max(1, this.sections.length);

    this.dispatchEvent(
      new CustomEvent<RelocateDetail>('relocate', {
        detail: {
          index: this.currentIndex,
          progress: this.currentProgress,
          cfi: section.cfi,
        },
      })
    );

    this.dispatchEvent(
      new CustomEvent<{ doc: Document | null; index: number }>('load', {
        detail: { doc: this.document, index: this.currentIndex },
      })
    );
  }

  private getTopVisibleRange(doc: Document): Range | null {
    const viewportWidth = this.iframe.contentWindow?.innerWidth ?? 1;
    const x = Math.max(0, Math.min(24, viewportWidth - 1));
    const positionMethod = Reflect.get(doc, 'caretPositionFromPoint');
    const position = typeof positionMethod === 'function'
      ? (positionMethod.call(doc, x, 1) as { offsetNode: Node; offset: number } | null)
      : null;
    if (position) {
      const range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    // Chromium still exposes the older Range-returning API on some versions.
    const rangeMethod = Reflect.get(doc, 'caretRangeFromPoint');
    const direct = typeof rangeMethod === 'function'
      ? (rangeMethod.call(doc, x, 1))
      : null;
    if (direct) {
      direct.collapse(true);
      return direct;
    }
    return null;
  }

  private setupScrollTracking(doc: Document, section: PaginatorSection): void {
    const frameWindow = this.iframe.contentWindow;
    if (!frameWindow) return;
    const emit = (): void => {
      this.scrollFrame = null;
      if (this.isDestroyed || doc !== this.document) return;
      const root = doc.scrollingElement ?? doc.documentElement;
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
      const fraction = maxScroll > 0 ? Math.max(0, Math.min(1, root.scrollTop / maxScroll)) : 0;
      const range = this.getTopVisibleRange(doc);
      // Remembered while the layout it was measured in is still current: a
      // resize is only observed after the text has already re-wrapped, when
      // nothing useful is left at the top of the viewport to capture.
      this.readingAnchorRange = range;
      let cfi = section.cfi;
      if (section.cfi && range) {
        try {
          cfi = CFI.joinIndir(section.cfi, CFI.fromRange(range));
        } catch {
          cfi = section.cfi;
        }
      }
      this.currentProgress = (this.currentIndex + fraction) / Math.max(1, this.sections.length);
      this.dispatchEvent(new CustomEvent<RelocateDetail>('relocate', {
        detail: {
          index: this.currentIndex,
          progress: this.currentProgress,
          fraction,
          ...(range ? { range } : {}),
          ...(cfi ? { cfi } : {}),
        },
      }));
    };
    const onScroll = (): void => {
      if (this.scrollFrame !== null) return;
      this.scrollFrame = frameWindow.requestAnimationFrame(emit);
    };
    frameWindow.addEventListener('scroll', onScroll, { passive: true });
    this.removeScrollListener = () => {
      frameWindow.removeEventListener('scroll', onScroll);
    };
  }

  /**
   * Puts the words the reader was on back at the top of the frame after the
   * section re-wrapped.
   *
   * A reflowable section has no page to return to — narrowing the frame changes
   * where every line falls — so the pixel offset is worthless and the text
   * position is not. The recorded Range still points at the same characters
   * after reflow, so scrolling it back under the frame's top edge restores the
   * reader's actual place instead of an arithmetic approximation of it.
   */
  private restoreReadingAnchor(): void {
    const doc = this.document;
    const frameWindow = this.iframe.contentWindow;
    const range = this.readingAnchorRange;
    if (!doc || !frameWindow || !range) return;
    if (!doc.contains(range.startContainer)) {
      this.readingAnchorRange = null;
      return;
    }
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    if (!rect || !Number.isFinite(rect.top)) return;
    const root = doc.scrollingElement ?? doc.documentElement;
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    const target = Math.max(0, Math.min(maxScroll, root.scrollTop + rect.top));
    frameWindow.scrollTo({ top: target, behavior: 'auto' });
  }

  private clearScrollTracking(): void {
    this.removeScrollListener?.();
    this.removeScrollListener = null;
    if (this.scrollFrame !== null) {
      this.iframe.contentWindow?.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
  }

  private loadIframeMarkup(markup: string): Promise<void> {
    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      this.iframe.removeEventListener('load', onLoad);
      window.clearTimeout(timeout);
      resolveFn();
    };
    const onLoad = (): void => { finish(); };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      this.iframe.removeEventListener('load', onLoad);
      rejectFn(new Error('Timed out while rendering the ebook section.'));
    }, 5_000);
    this.iframe.addEventListener('load', onLoad);

    // jsdom does not dispatch iframe load for srcdoc. Its contentDocument is a
    // test-only blank document, so resolve immediately after assignment there.
    this.iframe.removeAttribute('src');
    this.iframe.srcdoc = markup;
    if (navigator.userAgent.toLowerCase().includes('jsdom')) {
      queueMicrotask(finish);
    }
    return promise;
  }

  async next(): Promise<void> {
    if (this.currentIndex < this.sections.length - 1) {
      await this.goToIndex(this.currentIndex + 1);
    }
  }

  async prev(): Promise<void> {
    if (this.currentIndex > 0) {
      await this.goToIndex(this.currentIndex - 1);
    }
  }

  async goTo(target: number | EbookNavigationTarget): Promise<void> {
    if (typeof target === 'number') {
      await this.goToIndex(target);
      return;
    }

    await this.goToIndex(target.index);
    if (target.anchor && this.document) {
      const elOrRange = target.anchor(this.document);
      if (elOrRange) {
        if (elOrRange instanceof Element) {
          elOrRange.scrollIntoView({ behavior: 'auto', block: 'start' });
        } else if ('startContainer' in elOrRange) {
          const frameWindow = this.iframe.contentWindow;
          const rangeRect = typeof elOrRange.getBoundingClientRect === 'function'
            ? elOrRange.getBoundingClientRect()
            : null;
          if (frameWindow && rangeRect && Number.isFinite(rangeRect.top)) {
            const root = this.document.scrollingElement ?? this.document.documentElement;
            frameWindow.scrollTo({
              top: Math.max(0, root.scrollTop + rangeRect.top),
              behavior: 'auto',
            });
            return;
          }
          const parent =
            elOrRange.startContainer instanceof Element
              ? elOrRange.startContainer
              : elOrRange.startContainer.parentElement;
          parent?.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
      }
    } else if (target.fraction !== undefined && this.document) {
      const root = this.document.scrollingElement ?? this.document.documentElement;
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
      this.iframe.contentWindow?.scrollTo({
        top: maxScroll * Math.max(0, Math.min(1, target.fraction)),
        behavior: 'auto',
      });
    }
  }

  setStyles(css: string): void {
    this.currentStyles = css;
    this.applyCurrentStyles();
  }

  private applyCurrentStyles(): void {
    const doc = this.document;
    if (!doc) return;

    const existingStyle = doc.getElementById('interleaf-injected-styles') as HTMLStyleElement | null;
    const styleEl = existingStyle ?? doc.createElement('style');
    if (!existingStyle) {
      styleEl.id = 'interleaf-injected-styles';
      doc.head.appendChild(styleEl);
    }
    const hostStyles = window.getComputedStyle(this.element);
    // The reader background is deliberately independent from the application
    // palette. Read the explicit reader override first; `--bg-reader` is only
    // the fallback for the "Use app palette" option. This value is then
    // injected into the sandboxed iframe because CSS custom properties do not
    // cross an iframe boundary.
    const readerBackground = hostStyles.getPropertyValue('--reader-background-override').trim() || hostStyles.getPropertyValue('--bg-reader').trim() || '#ffffff';
    const readerText = hostStyles.getPropertyValue('--reader-foreground-override').trim() || hostStyles.getPropertyValue('--text-primary').trim() || '#111111';
    const accent = hostStyles.getPropertyValue('--accent').trim() || readerText;
    const selection = hostStyles.getPropertyValue('--selection').trim() || 'transparent';
    const selectionTranslucent = hostStyles.getPropertyValue('--selection-translucent').trim() ||
      hostStyles.getPropertyValue('--reader-selection-override').trim() ||
      'rgba(186, 230, 253, 0.45)';
    // Painted note annotations use their own stronger translucent token; it is
    // injected alongside the selection token so notes look the same inside the
    // sandboxed frame as they do in top-level documents.
    const noteTranslucent = hostStyles.getPropertyValue('--note-translucent').trim() || selectionTranslucent;
    const darkReader = isDarkColor(readerBackground);
    const searchMark = hostStyles.getPropertyValue('--search-mark').trim();
    const warning = hostStyles.getPropertyValue('--warning').trim();

    styleEl.textContent = `
      :root {
        color-scheme: ${darkReader ? 'dark' : 'light'};
        background: ${readerBackground};
        color: ${readerText};
        --accent: ${accent};
        --selection: ${selection};
        --selection-translucent: ${selectionTranslucent};
        --note-translucent: ${noteTranslucent};
        --search-mark: ${searchMark};
        --warning: ${warning};
      }
      body {
        margin: 0 !important;
        padding: 2rem 2.5rem !important;
        box-sizing: border-box !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        background: ${readerBackground} !important;
        color: ${readerText} !important;
      }
      ::selection {
        background-color: var(--selection-translucent, ${selectionTranslucent});
      }
      img, svg, image {
        max-width: 100% !important;
        height: auto !important;
      }
      ${this.currentStyles}
    `;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.navigationSequence += 1;
    this.clearScrollTracking();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.iframe.srcdoc = '';
    this.iframe.removeAttribute('src');
    this.sections = [];
    this.element.remove();
  }
}
