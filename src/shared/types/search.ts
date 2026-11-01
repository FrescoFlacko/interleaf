import type { z } from 'zod';
import type { searchIndexChunkSchema } from '../schemas/search';
import type { DocumentLocation } from './document';

type IndexStateCommon = {
  readonly documentId: string;
  readonly documentHash: string;
  readonly totalChunks: number;
  readonly indexedChunks: number;
  readonly updatedAt: string;
};

/**
 * A document's index state. Each status carries only the fields that are true
 * of it: a failure always says why, a reason may accompany `not_indexed` (a
 * format upgrade that invalidated the published index records one), nothing
 * else carries a message, and only a ready index has a token estimate.
 *
 * `estimatedTokens` is a rough token estimate for the whole document, derived
 * by the main-owned search repository from the indexed extracted text (UTF-16
 * units / 4) — never from file size, and never carrying document text itself.
 * A ready index still reports `null` when the published index describes a
 * superseded revision, because there is then no trustworthy estimate.
 */
export type DocumentIndexState =
  | (IndexStateCommon & {
      readonly status: 'not_indexed';
      readonly estimatedTokens: null;
      readonly errorMessage: string | null;
    })
  | (IndexStateCommon & {
      readonly status: 'indexing';
      readonly estimatedTokens: null;
      readonly errorMessage: null;
    })
  | (IndexStateCommon & {
      readonly status: 'ready';
      readonly estimatedTokens: number | null;
      readonly errorMessage: null;
    })
  | (IndexStateCommon & {
      readonly status: 'failed';
      readonly estimatedTokens: null;
      readonly errorMessage: string;
    });

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
