import { describe, expect, it, vi } from 'vitest';
import { navigateLearningSource } from '../../src/renderer/features/reader/learning-source';
import { testDocumentAdapter } from '../helpers/document-adapter';
import type { NormalizedTextChunk } from '@shared/types/document';
import type { DocumentAnchor } from '@shared/types/annotation';
type LearningSource = { documentId: string; documentHash: string; anchor: DocumentAnchor };

const source: LearningSource = { documentId: 'doc', documentHash: 'hash', anchor: {
  format: 'markdown', blockIndex: 4, headingId: 'heading', quote: { exact: 'passage', prefix: '', suffix: '' },
} };
function chunk(text: string): NormalizedTextChunk {
  return { id: 'chunk', documentId: 'doc', ordinal: 0, text, tokenCount: 1,
    location: { format: 'markdown', blockIndex: 4 }, heading: null, pageLabel: null };
}

describe('learning source navigation', () => {
  it('moves only after resolving the exact unique quote and uses the passage block, not the heading', async () => {
    const goToLocation = vi.fn(() => Promise.resolve());
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('the passage ends')]), goToLocation });
    expect(await navigateLearningSource(adapter, source)).toBe(true);
    expect(goToLocation).toHaveBeenCalledWith({ format: 'markdown', blockIndex: 4, characterStart: 4, characterEnd: 11 });
  });
  it('does not navigate on a missing, ambiguous or unsupported source', async () => {
    const goToLocation = vi.fn(() => Promise.resolve());
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('passage passage')]), goToLocation });
    expect(await navigateLearningSource(adapter, source)).toBe(false);
    expect(goToLocation).not.toHaveBeenCalled();
  });
  it('uses an exact native range to disambiguate repeated text', async () => {
    const goToLocation = vi.fn(() => Promise.resolve());
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('passage passage')]), goToLocation });
    const exact: LearningSource = { ...source, anchor: { format: 'markdown', blockIndex: 4,
      characterStart: 8, characterEnd: 15, quote: { exact: 'passage', prefix: '', suffix: '' } } };
    expect(await navigateLearningSource(adapter, exact)).toBe(true);
    expect(goToLocation).toHaveBeenCalledWith({ format: 'markdown', blockIndex: 4, characterStart: 8, characterEnd: 15 });
  });

  it('does not navigate if the reader session changes while resolving', async () => {
    const goToLocation = vi.fn(() => Promise.resolve());
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('the passage ends')]), goToLocation });
    expect(await navigateLearningSource(adapter, source, () => false)).toBe(false);
    expect(goToLocation).not.toHaveBeenCalled();
  });
});
