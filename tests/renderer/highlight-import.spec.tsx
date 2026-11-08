// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportedHighlights } from '../../src/renderer/features/highlight-import/ImportedHighlights';
import { stubBridge } from '../helpers/interleaf-api';

describe('imported highlight preview', () => {
  afterEach(cleanup);
  it('requires confirmation and shows provenance and warnings', async () => {
    const commit = vi.fn().mockResolvedValue({ inserted: 1, duplicates: 0 });
    stubBridge({ library: { listDocuments: () => Promise.resolve([]) }, importedHighlights: {
      list: () => Promise.resolve([]), commit,
      preview: () => Promise.resolve({ token: '123e4567-e89b-42d3-a456-426614174000', provider: 'kindle', count: 1, duplicates: 0,
        warnings: ['One note was not imported.'], titles: [{ key: '["Book",null]', title: 'Book', author: null, count: 1 }],
        samples: [{ title: 'Book', quote: '<script>literal</script>', location: 'page 2' }] }),
    } });
    render(<ImportedHighlights />);
    fireEvent.click(screen.getByRole('button', { name: 'Imported highlights' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    expect(await screen.findByText('One note was not imported.')).toBeTruthy();
    expect(screen.getByText(/<script>literal<\/script>/)).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => { expect(commit).toHaveBeenCalledOnce(); });
    expect(await screen.findByText('Imported 1; skipped 0 duplicates.')).toBeTruthy();
  });
});
