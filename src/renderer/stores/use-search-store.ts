import { create } from 'zustand';
import type { DocumentMetadata } from '@shared/types/document';
import type { InterleafAPI } from '@shared/types/api';
import type { DocumentIndexState, SearchIndexChunkInput } from '@shared/types/search';
import type { DocumentAdapter } from '../features/reader/types';
import { normalizeSearchChunks } from '../features/search/chunk-normalizer';
import { bridge } from '../app/api-client';

const BATCH_CHUNKS = 25;
const BATCH_TEXT_UNITS = 900_000;
let indexingSequence = 0;

function errorMessage(cause: Error | null): string {
  return (cause instanceof Error ? cause.message : 'Search indexing failed.').slice(0, 1_000);
}

/** The one call a failed generation reports itself with. */
type IndexFailureReporter = Pick<InterleafAPI['search'], 'failIndex'>;

/**
 * Marks the in-progress generation as failed, best effort.
 *
 * A newer generation or a changed document may already own the index state, in
 * which case the report is refused and there is nothing left to record.
 */
async function reportIndexFailure(
  api: IndexFailureReporter,
  document: DocumentMetadata,
  generationId: string,
  cause: Error | null,
): Promise<DocumentIndexState | null> {
  try {
    return await api.failIndex(document.id, document.fileHash, generationId, errorMessage(cause));
  } catch {
    return null;
  }
}

export type SearchState = {
  indexStates: Readonly<Record<string, DocumentIndexState | undefined>>;
  activeIndexingDocumentId: string | null;
  reindexNonce: number;
  /** Monotonic renderer-only lifecycle token for document-bound SearchPanel state. */
  transientResetRevision: number;
  loadIndexState: (documentId: string) => Promise<void>;
  indexDocument: (document: DocumentMetadata, adapter: DocumentAdapter, signal: AbortSignal) => Promise<void>;
  requestReindex: () => void;
  resetTransientSearch: () => void;
  reset: () => void;
};

export const useSearchStore = create<SearchState>((set, get) => ({
  indexStates: {},
  activeIndexingDocumentId: null,
  reindexNonce: 0,
  transientResetRevision: 0,

  loadIndexState: async (documentId) => {
    const state = await bridge.search.getIndexState(documentId);
    set((current) => ({ indexStates: { ...current.indexStates, [documentId]: state ?? undefined } }));
  },

  indexDocument: async (document, adapter, signal) => {
    const api = bridge.search;
    const sequence = ++indexingSequence;
    let generationId: string | null = null;
    try {
      const current = await api.getIndexState(document.id);
      if (signal.aborted) return;
      set((state) => ({ indexStates: { ...state.indexStates, [document.id]: current ?? undefined } }));
      if (current?.status === 'ready' && current.documentHash === document.fileHash) return;

      const generation = await api.beginIndex(document.id, document.fileHash);
      generationId = generation.generationId;
      set((state) => ({
        activeIndexingDocumentId: document.id,
        indexStates: { ...state.indexStates, [document.id]: generation },
      }));

      let batch: SearchIndexChunkInput[] = [];
      let batchUnits = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0 || !generationId) return;
        const next = await api.appendIndex(document.id, document.fileHash, generationId, batch);
        if (sequence === indexingSequence) {
          set((state) => ({ indexStates: { ...state.indexStates, [document.id]: next } }));
        }
        batch = [];
        batchUnits = 0;
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
      };

      for await (const chunk of normalizeSearchChunks(adapter.extractText(), signal)) {
        signal.throwIfAborted();
        if (batch.length >= BATCH_CHUNKS || batchUnits + chunk.text.length > BATCH_TEXT_UNITS) await flush();
        batch.push(chunk);
        batchUnits += chunk.text.length;
      }
      await flush();
      signal.throwIfAborted();
      const ready = await api.completeIndex(document.id, document.fileHash, generationId);
      if (sequence === indexingSequence) {
        set((state) => ({
          activeIndexingDocumentId: null,
          indexStates: { ...state.indexStates, [document.id]: ready },
        }));
      }
    } catch (error) {
      const caught = error instanceof Error ? error : null;
      const failed = generationId === null ? null : await reportIndexFailure(api, document, generationId, caught);
      if (sequence === indexingSequence) {
        set((state) => ({
          activeIndexingDocumentId: null,
          ...(failed === null ? {} : { indexStates: { ...state.indexStates, [document.id]: failed } }),
        }));
      }
    }
  },

  requestReindex: () => { set((state) => ({ reindexNonce: state.reindexNonce + 1 })); },
  resetTransientSearch: () => {
    set((state) => ({ transientResetRevision: state.transientResetRevision + 1 }));
  },
  reset: () => {
    set({
      indexStates: {},
      activeIndexingDocumentId: null,
      reindexNonce: get().reindexNonce,
      transientResetRevision: get().transientResetRevision,
    });
  },
}));
