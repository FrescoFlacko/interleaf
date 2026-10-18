import type {
  DocumentFormat,
  DocumentLocation,
  MobiLocation,
  TableOfContentsItem,
} from '@shared/types/document';
import { EbookBaseAdapter } from './ebook-base-adapter';
import { MOBI, type MobiParse, type MobiTOCItem } from './foliate/mobi';
import type { EbookNavigationTarget } from './foliate/paginator';

export class MobiAdapter extends EbookBaseAdapter<MOBI> {
  readonly format: DocumentFormat = 'mobi';

  constructor(private readonly parseMobi?: MobiParse) {
    super();
  }

  async createBook(buffer: Uint8Array, signal: AbortSignal): Promise<MOBI> {
    signal.throwIfAborted();
    const mobi = new MOBI(buffer, this.parseMobi, signal);
    try {
      await mobi.open();
      return mobi;
    } catch (error) {
      mobi.destroy();
      throw error;
    }
  }

  buildLocation(sectionIndex: number, cfiOrOffset?: string | number, progress?: number): MobiLocation {
    const byteOffset = typeof cfiOrOffset === 'number' ? cfiOrOffset : undefined;
    const resolvedProgress = progress ?? this.currentProgress;
    return {
      format: 'mobi',
      sectionIndex,
      ...(byteOffset !== undefined ? { byteOffset } : {}),
      progression: resolvedProgress,
    };
  }

  resolveLocationTarget(
    location: DocumentLocation
  ): EbookNavigationTarget | number | null {
    if (location.format === 'mobi') {
      const idx = location.sectionIndex;
      const index = Math.max(0, Math.min(idx, this.pageCount - 1));
      const progression = location.progression;
      if (progression === undefined || !this.book) return index;
      const sizes = this.book.sections.map((section) => section.linear === 'no' ? 0 : Math.max(1, section.size));
      const total = sizes.reduce((sum, size) => sum + size, 0);
      const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
      const sectionSize = sizes[index] ?? 1;
      const fraction = total > 0 ? (progression * total - before) / sectionSize : 0;
      return { index, fraction: Math.max(0, Math.min(1, fraction)) };
    } else if (location.format === 'pdf') {
      return Math.max(0, Math.min(location.pageIndex, this.pageCount - 1));
    } else if (location.format === 'epub') {
      return 0;
    }
    return 0;
  }

  getTableOfContents(): Promise<readonly TableOfContentsItem[]> {
    if (!this.book) return Promise.resolve([]);

    let itemId = 1;
    const mapTocItem = (item: MobiTOCItem, level: number): TableOfContentsItem => {
      const resolved = item.href ? this.book?.resolveHref(item.href) : null;
      const sectionIndex = resolved?.index ?? 0;

      const loc: MobiLocation = {
        format: 'mobi',
        sectionIndex,
      };

      const children = item.subitems?.map((sub) => mapTocItem(sub, level + 1)) ?? [];

      return {
        id: `mobi-toc-${String(itemId++)}`,
        title: item.label || `Section ${String(sectionIndex + 1)}`,
        location: loc,
        level,
        children,
      };
    };

    return Promise.resolve(this.book.toc.map((item) => mapTocItem(item, 0)));
  }
}
