import type { DocumentAnchor } from './annotation';

/** Provider metadata is not a native document location or proof of a passage. */
export type ImportedHighlight = {
  readonly id: string;
  readonly provider: 'kindle' | 'readwise';
  readonly title: string;
  readonly author: string | null;
  readonly quote: string;
  readonly note: string | null;
  readonly location: string | null;
  readonly date: string | null;
  readonly documentId: string | null;
  readonly verifiedAnchor: DocumentAnchor | null;
  readonly verifiedDocumentHash: string | null;
};

export type ImportPreview = {
  readonly token: string;
  readonly provider: 'kindle' | 'readwise';
  readonly count: number;
  readonly duplicates: number;
  readonly warnings: readonly string[];
  readonly samples: readonly { readonly title: string; readonly quote: string; readonly location: string | null }[];
  readonly titles: readonly { readonly key: string; readonly title: string; readonly author: string | null; readonly count: number }[];
};
export type ImportResult = { readonly inserted: number; readonly duplicates: number };
