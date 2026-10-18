// Hardened Foliate View coordinator ported from foliate-js (commit 78914aef4466eb960965702401634c2cb348e9b1)

import type { EPUB } from './epub';
import type { MOBI } from './mobi';
import { Paginator, type EbookNavigationTarget, type RelocateDetail } from './paginator';
import { SectionProgress, TOCProgress } from './progress';
import { searchInDocument, type SearchMatchResult } from './search';

export type Ebook = EPUB | MOBI;

export class View extends EventTarget {
  readonly element = document.createElement('div');
  private renderer: Paginator | null = null;
  private sectionProgress: SectionProgress | null = null;
  private tocProgress: TOCProgress | null = null;
  private book: Ebook | null = null;

  constructor() {
    super();
    Object.assign(this.element.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
    });
  }

  get activeBook(): Ebook | null {
    return this.book;
  }

  get activeRenderer(): Paginator | null {
    return this.renderer;
  }

  async open(book: Ebook): Promise<void> {
    this.book = book;
    this.close();

    this.renderer = new Paginator();
    this.element.appendChild(this.renderer.element);

    const ids = book.sections.map((s) => s.id);
    this.sectionProgress = new SectionProgress(book.sections);
    this.tocProgress = new TOCProgress();

    this.tocProgress.init({
      toc: book.toc,
      ids,
      splitHref: (href) => book.splitTOCHref(href),
      getFragment: (doc, id) => book.getTOCFragment(doc, id),
    });

    this.renderer.addEventListener('relocate', (e) => {
      const detail = (e as CustomEvent<RelocateDetail>).detail;
      this.dispatchEvent(
        new CustomEvent<RelocateDetail>('relocate', {
          detail: {
            index: detail.index,
            progress: this.sectionProgress?.getProgress(detail.index, detail.fraction) ?? detail.progress,
            fraction: detail.fraction,
            range: detail.range,
            cfi: detail.cfi,
          },
        })
      );
    });

    await this.renderer.open(book);
  }

  async goTo(target: number | EbookNavigationTarget): Promise<void> {
    if (this.renderer) {
      await this.renderer.goTo(target);
    }
  }

  async next(): Promise<void> {
    if (this.renderer) {
      await this.renderer.next();
    }
  }

  async prev(): Promise<void> {
    if (this.renderer) {
      await this.renderer.prev();
    }
  }

  setStyles(css: string): void {
    if (this.renderer) {
      this.renderer.setStyles(css);
    }
  }

  async *search(query: string): AsyncGenerator<{ index: number; match: SearchMatchResult }> {
    if (!this.book || !query.trim()) return;

    for (let i = 0; i < this.book.sections.length; i++) {
      const section = this.book.sections[i];
      if (!section) continue;
      const doc = await section.createDocument();
      const matches = Array.from(searchInDocument(doc, query));
      for (const match of matches) {
        yield { index: i, match };
      }
    }
  }

  close(): void {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }
    this.sectionProgress = null;
    this.tocProgress = null;
  }
}
