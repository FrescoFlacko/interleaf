import type {
  DocumentFormat,
  DocumentLocation,
  EpubLocation,
  TableOfContentsItem,
} from '@shared/types/document';
import { EbookBaseAdapter } from './ebook-base-adapter';
import { EPUB, type EpubTOCItem } from './foliate/epub';
import * as CFI from './foliate/epubcfi';
import { makeFflateZipLoader, type ZipInflate } from './foliate/zip-loader';
import type { EbookNavigationTarget } from './foliate/paginator';

export class EpubAdapter extends EbookBaseAdapter<EPUB> {
  readonly format: DocumentFormat = 'epub';

  constructor(private readonly inflateArchive?: ZipInflate) {
    super();
  }

  async createBook(buffer: Uint8Array, signal: AbortSignal): Promise<EPUB> {
    const loader = await makeFflateZipLoader(buffer, this.inflateArchive, signal);
    const epub = new EPUB(loader, signal);
    try {
      await epub.init();
      return epub;
    } catch (error) {
      epub.destroy();
      throw error;
    }
  }

  buildLocation(sectionIndex: number, cfiOrOffset?: string | number, progress?: number): EpubLocation {
    const section = this.book?.sections[sectionIndex];
    const cfi = typeof cfiOrOffset === 'string' ? cfiOrOffset : section?.cfi ?? CFI.fake.fromIndex(sectionIndex);
    const resolvedProgress = progress ?? this.currentProgress;
    return {
      format: 'epub',
      cfi,
      ...(section?.id ? { spineHref: section.id } : {}),
      progression: resolvedProgress,
    };
  }

  resolveLocationTarget(
    location: DocumentLocation
  ): EbookNavigationTarget | number | null {
    if (location.format === 'epub') {
      if (this.book && location.cfi) {
        const resolved = this.book.resolveCFI(location.cfi);
        if (resolved) return resolved;
      }

      if (this.book && location.spineHref) {
        const resolved = this.book.resolveHref(location.spineHref);
        if (resolved) return resolved;
      }

      if (location.cfi) {
        try {
          const parsed = CFI.parse(location.cfi);
          const parts = Array.isArray(parsed) ? parsed : parsed.parent;
          const index = CFI.fake.toIndex(parts[0]);
          if (index >= 0 && index < this.pageCount) {
            return index;
          }
        } catch {
          // Fall through to the first section for a stale/corrupt saved CFI.
        }
      }
    } else if (location.format === 'pdf') {
      return Math.max(0, Math.min(location.pageIndex, this.pageCount - 1));
    } else if (location.format === 'mobi') {
      return Math.max(0, Math.min(location.sectionIndex, this.pageCount - 1));
    }
    return location.format === 'epub' ? null : 0;
  }

  getTableOfContents(): Promise<readonly TableOfContentsItem[]> {
    if (!this.book) return Promise.resolve([]);

    let itemId = 1;
    const mapTocItem = (item: EpubTOCItem, level: number): TableOfContentsItem => {
      const resolved = item.href ? this.book?.resolveHref(item.href) : null;
      const sectionIndex = resolved?.index ?? 0;
      const section = this.book?.sections[sectionIndex];
      const cfi = section?.cfi ?? CFI.fake.fromIndex(sectionIndex);
      const spineHref = item.href || section?.id;

      const loc: EpubLocation = {
        format: 'epub',
        cfi,
        ...(spineHref ? { spineHref } : {}),
      };

      const children = item.subitems?.map((sub) => mapTocItem(sub, level + 1)) ?? [];

      return {
        id: `toc-${String(itemId++)}`,
        title: item.label || `Section ${String(sectionIndex + 1)}`,
        location: loc,
        level,
        children,
      };
    };

    return Promise.resolve(this.book.toc.map((item) => mapTocItem(item, 0)));
  }
}
