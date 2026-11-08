// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportedPracticeCreate } from '../../src/renderer/features/highlight-import/ImportedPracticeCreate';
import { stubBridge } from '../helpers/interleaf-api';

describe('practice from imported source', () => {
  afterEach(cleanup);
  it('sends the user question and retained source identity only after explicit save', async () => {
    const createImported = vi.fn().mockResolvedValue({});
    stubBridge({ practice: { createImported } });
    render(<ImportedPracticeCreate importedHighlightId="source-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Make practice card' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What was the point?' } });
    expect(createImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save card' }));
    await waitFor(() => { expect(createImported).toHaveBeenCalledWith({ importedHighlightId: 'source-one', question: 'What was the point?' }); });
    expect(await screen.findByText('Practice card saved.')).toBeTruthy();
  });
});
