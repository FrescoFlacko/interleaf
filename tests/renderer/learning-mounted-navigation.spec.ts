// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { withLearningNavigation } from '../../src/renderer/features/reader/learning-mounted-navigation';
import { testDocumentAdapter } from '../helpers/document-adapter';
import type { DocumentAnchor } from '@shared/types/annotation';

const markdown: DocumentAnchor = { format: 'markdown', blockIndex: 1, characterStart: 0, characterEnd: 7,
  quote: { exact: 'passage', prefix: '', suffix: '' } };

describe('mounted learning source navigation', () => {
  it('does not position or claim success after its session is replaced during mounting', async () => {
    let finish: () => void = () => undefined;
    const transition = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = withLearningNavigation(testDocumentAdapter('markdown', { goToLocation: () => transition }));
    let active = true;
    const result = adapter.navigateLearningAnchor?.(markdown, () => active);
    active = false;
    finish();
    expect(await result).toBe(false);
  });
  it('never forwards a PDF rectangle and refuses a missing live text layer', async () => {
    const navigate = vi.fn(() => Promise.resolve());
    const adapter = withLearningNavigation(testDocumentAdapter('pdf', { goToLocation: navigate }));
    const anchor: DocumentAnchor = { format: 'pdf', pageIndex: 0, quote: { exact: 'passage', prefix: '', suffix: '' },
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }] };
    expect(await adapter.navigateLearningAnchor?.(anchor, () => true)).toBe(false);
    expect(navigate).toHaveBeenCalledWith({ format: 'pdf', pageIndex: 0 });
  });
  it('does not inspect or scroll a PDF layer after cancellation during navigation', async () => {
    let finish: () => void = () => undefined;
    const transition = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = withLearningNavigation(testDocumentAdapter('pdf', { goToLocation: () => transition }));
    const anchor: DocumentAnchor = { format: 'pdf', pageIndex: 0, quote: { exact: 'passage', prefix: '', suffix: '' } };
    const query = vi.spyOn(document, 'querySelector');
    let active = true;
    try {
      const result = adapter.navigateLearningAnchor?.(anchor, () => active);
      active = false;
      finish();
      expect(await result).toBe(false);
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
  });

});
