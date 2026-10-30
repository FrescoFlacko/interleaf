// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';
import type { DocumentIndexState, IndexGeneration, SearchIndexChunkInput } from '@shared/types/search';
import { createDocumentAdapter } from '../../src/renderer/features/reader/adapters/adapter-factory';
import { useSearchStore } from '../../src/renderer/stores/use-search-store';
import { stubBridge, testBridge } from '../helpers/interleaf-api';

const documentMetadata: DocumentMetadata = {
  id: 'legacy-search-document',
  title: 'Legacy Search Document',
  author: null,
  format: 'markdown',
  storageMode: 'link',
  fileSize: 128,
  fileMtimeMs: 1,
  fileHash: 'legacy-search-hash',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  source: null,
};

const legacyState: DocumentIndexState = {
  documentId: documentMetadata.id,
  documentHash: documentMetadata.fileHash,
  status: 'not_indexed',
  totalChunks: 0,
  indexedChunks: 0,
  estimatedTokens: null,
  errorMessage: 'Search index format upgrade requires a rebuild.',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

describe('search index startup rebuild', () => {
  const previousApi = testBridge;

  afterEach(() => {
    useSearchStore.getState().reset();
    stubBridge(previousApi);
  });

  it('rebuilds a v17-invalidated ready index when its document is opened', async () => {
    const adapter = createDocumentAdapter('markdown');
    const chunk: NormalizedTextChunk = {
      id: 'legacy-source-chunk',
      documentId: documentMetadata.id,
      ordinal: 0,
      text: 'leading needle and repeated needle',
      tokenCount: 5,
      location: {
        format: 'markdown',
        blockIndex: 0,
        characterStart: 0,
        characterEnd: 'leading needle and repeated needle'.length,
      },
      heading: null,
      pageLabel: null,
    };
    vi.spyOn(adapter, 'extractText').mockImplementation(async function* (): AsyncIterable<NormalizedTextChunk> {
      await Promise.resolve();
      yield chunk;
    });

    const generation: IndexGeneration = { ...legacyState, status: 'indexing', errorMessage: null, generationId: 'generation-v17' };
    const indexed: DocumentIndexState = {
      ...legacyState,
      status: 'ready',
      totalChunks: 1,
      indexedChunks: 1,
      errorMessage: null,
    };
    const getIndexState = vi.fn().mockResolvedValueOnce(legacyState).mockResolvedValue(indexed);
    const beginIndex = vi.fn().mockResolvedValue(generation);
    const appendIndex = vi.fn<(documentId: string, hash: string, generationId: string, chunks: readonly SearchIndexChunkInput[]) => Promise<IndexGeneration>>()
      .mockResolvedValue(generation);
    const completeIndex = vi.fn().mockResolvedValue(indexed);
    const failIndex = vi.fn();
    stubBridge({ search: { getIndexState, beginIndex, appendIndex, completeIndex, failIndex } });

    await useSearchStore.getState().indexDocument(documentMetadata, adapter, new AbortController().signal);

    expect(getIndexState).toHaveBeenCalledWith(documentMetadata.id);
    expect(beginIndex).toHaveBeenCalledWith(documentMetadata.id, documentMetadata.fileHash);
    expect(appendIndex).toHaveBeenCalledWith(
      documentMetadata.id,
      documentMetadata.fileHash,
      generation.generationId,
      [expect.objectContaining({ text: chunk.text, location: chunk.location })],
    );
    expect(completeIndex).toHaveBeenCalledWith(documentMetadata.id, documentMetadata.fileHash, generation.generationId);
    expect(failIndex).not.toHaveBeenCalled();
    expect(useSearchStore.getState().indexStates[documentMetadata.id]).toEqual(indexed);
  });

  it('increments transient search reset without clearing durable index state', () => {
    useSearchStore.setState({ indexStates: { [documentMetadata.id]: legacyState } });
    const before = useSearchStore.getState().transientResetRevision;
    useSearchStore.getState().resetTransientSearch();
    expect(useSearchStore.getState().transientResetRevision).toBe(before + 1);
    expect(useSearchStore.getState().indexStates[documentMetadata.id]).toEqual(legacyState);
  });
});
