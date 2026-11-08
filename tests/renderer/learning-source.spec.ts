// @vitest-environment jsdom
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
const current = (): boolean => true;

describe('learning source navigation', () => {
  it('requires mounted-range success after resolving the unique quote', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('the passage ends')]), navigateLearningAnchor: navigate });
    expect(await navigateLearningSource(adapter, source, current)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ format: 'markdown', blockIndex: 4, characterStart: 4, characterEnd: 11 }), current);
  });
  it('does not navigate on ambiguous or cancelled sources', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('passage passage')]), navigateLearningAnchor: navigate });
    expect(await navigateLearningSource(adapter, source, current)).toBe(false);
    expect(await navigateLearningSource(adapter, source)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('uses an exact native range to disambiguate repeated text', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('passage passage')]), navigateLearningAnchor: navigate });
    const exact: LearningSource = { ...source, anchor: { format: 'markdown', blockIndex: 4,
      characterStart: 8, characterEnd: 15, quote: { exact: 'passage', prefix: '', suffix: '' } } };
    expect(await navigateLearningSource(adapter, exact, current)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ characterStart: 8, characterEnd: 15 }), current);
  });
  it('never forwards PDF rectangles and propagates a failed mounted proof', async () => {
    const navigate = vi.fn(() => Promise.resolve(false));
    const pdf: LearningSource = { documentId: 'doc', documentHash: 'hash', anchor: {
      format: 'pdf', pageIndex: 0, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
      quote: { exact: 'passage', prefix: '', suffix: '' },
    } };
    const adapter = testDocumentAdapter('pdf', {
      extractLocationText: () => Promise.resolve([{ ...chunk('passage'), location: { format: 'pdf', pageIndex: 0 } }]),
      navigateLearningAnchor: navigate,
    });
    expect(await navigateLearningSource(adapter, pdf, current)).toBe(false);
    expect(navigate).toHaveBeenCalledWith(expect.not.objectContaining({ rects: expect.anything() }), current);
  });
  it('does not navigate after its owning request is cancelled during extraction', async () => {
    let finish: (chunks: readonly NormalizedTextChunk[]) => void = () => undefined;
    const extraction = new Promise<readonly NormalizedTextChunk[]>((resolve) => { finish = resolve; });
    const navigate = vi.fn(() => Promise.resolve(true));
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => extraction, navigateLearningAnchor: navigate });
    let active = true;
    const result = navigateLearningSource(adapter, source, () => active);
    active = false;
    finish([chunk('passage')]);
    expect(await result).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('rejects success returned after its source request was superseded', async () => {
    let finish: (visible: boolean) => void = () => undefined;
    const mounted = new Promise<boolean>((resolve) => { finish = resolve; });
    const navigate = vi.fn(() => mounted);
    const adapter = testDocumentAdapter('markdown', { extractLocationText: () => Promise.resolve([chunk('passage')]), navigateLearningAnchor: navigate });
    let active = true;
    const result = navigateLearningSource(adapter, source, () => active);
    await vi.waitFor(() => { expect(navigate).toHaveBeenCalledOnce(); });
    active = false;
    finish(true);
    expect(await result).toBe(false);
  });

});
