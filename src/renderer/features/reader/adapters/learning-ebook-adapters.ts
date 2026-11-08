import type { DocumentAnchor } from '@shared/types/annotation';
import { EpubAdapter } from './epub-adapter';
import { MobiAdapter } from './mobi-adapter';

/** Learning source navigation must not use ebook location fallbacks. */
export class LearningEpubAdapter extends EpubAdapter {
  verifyLearningAnchor(anchor: DocumentAnchor): boolean {
    if (anchor.format !== 'epub' || !this.book) return false;
    try {
      const resolved = this.book.resolveCFI(anchor.cfi);
      if (!resolved) return false;
      return !anchor.spineHref || this.book.sections[resolved.index]?.id === anchor.spineHref;
    } catch { return false; }
  }
}

export class LearningMobiAdapter extends MobiAdapter {
  verifyLearningAnchor(anchor: DocumentAnchor): boolean {
    return anchor.format === 'mobi' && this.book !== null && anchor.sectionIndex < this.book.sections.length;
  }
}
