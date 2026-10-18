import type { z } from 'zod';
import type { searchIndexChunkSchema } from '../schemas/search';
import type { DocumentLocation } from './document';

type DocumentIndexStatus = 'not_indexed' | 'indexing' | 'ready' | 'failed';

export type DocumentIndexState = {
  readonly documentId: string;
  readonly documentHash: string;
  readonly status: DocumentIndexStatus;
  readonly totalChunks: number;
  readonly indexedChunks: number;
  /**
   * Rough token estimate for the whole document, derived by the main-owned
   * search repository from the indexed extracted text (UTF-16 units / 4) —
   * never from file size, and never carrying document text itself. `null`
   * whenever there is no trustworthy estimate: while indexing, after a
   * failure, or when the published index describes a superseded revision.
   */
  readonly estimatedTokens: number | null;
  readonly errorMessage: string | null;
  readonly updatedAt: string;
};

export type IndexGeneration = DocumentIndexState & {
  readonly generationId: string;
};

export type SearchIndexChunkInput = z.output<typeof searchIndexChunkSchema>;

export type SearchTermRange = {
  /** UTF-16 offsets relative to the indexed chunk text. */
  readonly start: number;
  readonly end: number;
  /** The complete native token matched by the FTS prefix term. */
  readonly text: string;
  readonly queryTermIndex: number;
  /** All distinct query-term indexes represented by this physical token. */
  readonly queryTermIndices: readonly number[];
};

/** Revision-bound native ranges returned by main-owned search resolution. */
export type SearchMatchAnchor = {
  readonly version: 1;
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentHash: string;
  readonly location: DocumentLocation;
  readonly queryTerms: readonly string[];
  readonly ranges: readonly SearchTermRange[];
};

export type SearchHit = {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly documentAuthor: string | null;
  readonly documentHash: string;
  readonly ordinal: number;
  readonly excerpt: string;
  readonly location: DocumentLocation;
  readonly heading: string | null;
  readonly pageLabel: string | null;
  readonly rank: number;
  /** New main-owned results always include an anchor or an explicit legacy null. */
  readonly anchor: SearchMatchAnchor | null;
};
