// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/shared/types/ai';
import { ChatMessageBubble } from '../../src/renderer/features/chat/ChatMessageBubble';
import { stubBridge } from '../helpers/interleaf-api';

const answer: ChatMessage = {
  id: 'answer', sessionId: 'session', role: 'assistant', ordinal: 1,
  content: 'A complete **answer**.', citations: [], status: 'complete',
  requestId: null, tokenCount: null, errorMessage: null, createdAt: '2026-09-05T00:00:00Z',
  disclosures: [],
  webSources: [],
};
const copy = vi.fn((text: string) => Promise.resolve({ copied: true as const, characterCount: text.length }));
const save = vi.fn(() => Promise.resolve(true));
const notice = vi.fn();
function renderAnswer(message: ChatMessage = answer) {
  return render(<ChatMessageBubble message={message} onCitation={() => Promise.resolve()}
    canSaveNote onSaveNote={save} onNotice={notice}
    details={null} />);
}

describe('Reference answer actions', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    stubBridge({ clipboard: { writeText: copy } });
  });

  it('copies and saves the complete answer through the supplied capabilities', async () => {
    renderAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => { expect(copy).toHaveBeenCalledWith(answer.content); });
    expect(notice).toHaveBeenLastCalledWith('success', 'Answer copied');

    fireEvent.click(screen.getByRole('button', { name: 'Save answer as note' }));
    // The raw Markdown source is what is persisted, not the rendered text.
    await waitFor(() => { expect(save).toHaveBeenCalledWith('A complete **answer**.'); });
    await waitFor(() => { expect(notice).toHaveBeenLastCalledWith('success', 'Note saved'); });
  });

  /**
   * The confirmation is the panel's to place. Reporting it inside the message
   * would insert a line into the answer the reader is reading and push the
   * control row they are still pointing at, so the bubble itself must not grow
   * or gain any live region when an action succeeds.
   */
  it('reports the outcome outward, leaving the message geometry untouched', async () => {
    const { container } = renderAnswer();
    const actions = screen.getByRole('button', { name: 'Copy answer' }).closest('.chat-design-actions')!;
    const before = actions.childElementCount;
    const bubbleHtml = container.innerHTML;

    fireEvent.click(screen.getByRole('button', { name: 'Save answer as note' }));
    await waitFor(() => { expect(notice).toHaveBeenCalledWith('success', 'Note saved'); });

    expect(actions.childElementCount).toBe(before);
    expect(container.innerHTML).toBe(bubbleHtml);
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/saved/i)).toBeNull();
  });

  it('reports a rejected save as a failure and never as a success', async () => {
    save.mockResolvedValueOnce(false);
    renderAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Save answer as note' }));

    await waitFor(() => { expect(notice).toHaveBeenCalledWith('error', 'Could not save note'); });
    expect(notice).not.toHaveBeenCalledWith('success', 'Note saved');
  });

  it('reports a failed clipboard write as a failure', async () => {
    copy.mockRejectedValueOnce(new Error('denied'));
    renderAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));

    await waitFor(() => { expect(notice).toHaveBeenCalledWith('error', 'Could not copy answer'); });
    expect(notice).not.toHaveBeenCalledWith('success', 'Answer copied');
  });

  /**
   * The action row is glyphs only. Each control keeps the accessible name it
   * had as a label, so a screen reader and a keyboard user lose nothing, but
   * the words themselves no longer occupy the row beside the answer.
   */
  it('presents each action as an icon carrying its own accessible name', () => {
    renderAnswer();
    const copyButton = screen.getByRole('button', { name: 'Copy answer' });
    const saveButton = screen.getByRole('button', { name: 'Save answer as note' });

    // Each control is a glyph and nothing else, named by the button itself.
    expect(copyButton.querySelector('svg[data-icon="copy"]')).not.toBeNull();
    expect(saveButton.querySelector('svg[data-icon="add-note"]')).not.toBeNull();
    expect(copyButton.textContent).toBe('');
    expect(saveButton.textContent).toBe('');

    // Decorative inside a named button: the name is announced once.
    expect(copyButton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // The explanation is the app's own tooltip, never a second native one.
    expect(copyButton).not.toHaveAttribute('title');
    expect(saveButton).not.toHaveAttribute('title');

    // The words these buttons used to spell out are gone from the row.
    expect(screen.queryByText('Copy')).toBeNull();
    expect(screen.queryByText('Save as note')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry last message' })).toBeNull();
    expect(screen.queryByTestId('retry-chat-button')).toBeNull();
  });

  /**
   * There is no retry control anywhere in Reader Chat. A failed turn returns
   * its prompt to the composer instead, so the answer carries only the two
   * actions that do something with the answer itself. The settled case is
   * asserted with the icon row above.
   */
  it('offers no retry control on a failed answer', () => {
    renderAnswer({ ...answer, status: 'failed', errorMessage: 'Provider stopped responding.' });
    expect(screen.queryByRole('button', { name: 'Retry last message' })).toBeNull();
    expect(screen.queryByTestId('retry-chat-button')).toBeNull();
  });

  it('withholds persistence actions while content is streaming', () => {
    renderAnswer({ ...answer, status: 'streaming', content: 'An unfinished' });
    expect(screen.queryByRole('button', { name: 'Copy answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save answer as note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry last message' })).toBeNull();
    expect(screen.getByText('An unfinished')).toBeVisible();
  });

  it('marks a streaming answer as still being written, and drops the mark once it settles', () => {
    const { rerender } = renderAnswer({ ...answer, status: 'streaming', content: 'Quorum holds [src-1]' });
    expect(screen.getByTestId('chat-streaming-indicator')).toHaveTextContent('Generating response…');
    // Not a live region: the waiting notice already announced the turn once.
    expect(screen.getByTestId('chat-streaming-indicator').closest('[role="status"]')).toBeNull();
    expect(screen.getByTestId('citation-pending')).toBeTruthy();

    rerender(<ChatMessageBubble message={{ ...answer, content: 'Quorum holds [src-1]' }} onCitation={() => Promise.resolve()}
      canSaveNote={false} onSaveNote={() => Promise.resolve(false)} onNotice={() => undefined} details={null} />);
    expect(screen.queryByTestId('chat-streaming-indicator')).toBeNull();
    expect(screen.queryByTestId('citation-pending')).toBeNull();
  });
});
