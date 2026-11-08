// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePracticeNavigation, usePracticeNavigationStore } from '../../src/renderer/features/practice/use-practice-navigation';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { testReaderSession, testUnrenderedAdapter } from '../helpers/reader-session';
import type { DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';

const documentRecord: DocumentMetadata = {
  id: 'doc', title: 'Document', author: 'Reader', format: 'markdown', storageMode: 'managed',
  fileSize: 1, fileMtimeMs: 1, fileHash: 'hash', pageCount: 1, folderId: null, storageHealth: 'ok',
  readingPosition: null, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z', source: null,
};

afterEach(() => {
  cleanup();
  usePracticeNavigationStore.getState().setPending(null);
  useReaderStore.setState(useReaderStore.getInitialState(), true);
});

it('does not position or report a source after a reader gesture supersedes extraction', async () => {
  let finish: (chunks: readonly NormalizedTextChunk[]) => void = () => undefined;
  const extraction = new Promise<readonly NormalizedTextChunk[]>((resolve) => { finish = resolve; });
  const navigate = vi.fn(() => Promise.resolve(true));
  const adapter = testUnrenderedAdapter(documentRecord, { extractLocationText: () => extraction, navigateLearningAnchor: navigate });
  const session = testReaderSession(documentRecord, { adapter });
  useReaderStore.setState({ session });
  usePracticeNavigationStore.getState().setPending({ source: { kind: 'native', documentId: 'doc', documentHash: 'hash', annotationId: null,
    anchor: { format: 'markdown', blockIndex: 0, quote: { exact: 'passage', prefix: '', suffix: '' } } } });
  const result = renderHook(() => usePracticeNavigation(session, 1));
  act(() => { document.dispatchEvent(new Event('wheel')); });
  await act(async () => { finish([{ id: 'chunk', documentId: 'doc', ordinal: 0, text: 'passage', tokenCount: 1,
    location: { format: 'markdown', blockIndex: 0 }, heading: null, pageLabel: null }]); await extraction; });
  await waitFor(() => { expect(usePracticeNavigationStore.getState().pending).toBeNull(); });
  expect(navigate).not.toHaveBeenCalled();
  expect(result.result.current).toBe('');
});
