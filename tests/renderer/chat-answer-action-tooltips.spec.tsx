// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/shared/types/ai';
import { ChatMessageBubble } from '../../src/renderer/features/chat/ChatMessageBubble';
import { stubBridge } from '../helpers/interleaf-api';

const COPY_HINT = 'Copy the full answer to the clipboard';
const SAVE_HINT = 'Save the answer as a note at your current location in this document';

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

function renderAnswer(message: ChatMessage = answer, canSaveNote = true) {
  return render(<ChatMessageBubble message={message} onCitation={() => Promise.resolve()}
    canSaveNote={canSaveNote} onSaveNote={save} onNotice={notice} details={null} />);
}

const copyButton = () => screen.getByRole('button', { name: 'Copy answer' });
const saveButton = () => screen.getByRole('button', { name: 'Save answer as note' });
/** The painted tooltip; it repeats the description, so it is hidden from the accessibility tree. */
const tooltip = () => document.querySelector<HTMLElement>('[data-testid="chat-answer-action-tooltip"]');

/**
 * The two icon-only answer actions explain themselves with the app's own
 * tooltip. A native `title` never appears on keyboard focus, waits on the
 * platform's long delay and cannot be themed, so it is not the explanation.
 */
describe('Answer action tooltips', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    stubBridge({ clipboard: { writeText: copy } });
  });

  it('explains each action on keyboard focus straight away, and leaves on blur', () => {
    renderAnswer();
    act(() => { copyButton().focus(); });
    expect(tooltip()).toHaveTextContent(COPY_HINT);
    expect(tooltip()).toHaveAttribute('role', 'tooltip');

    act(() => { saveButton().focus(); });
    expect(tooltip()).toHaveTextContent(SAVE_HINT);

    act(() => { saveButton().blur(); });
    expect(tooltip()).toBeNull();
  });

  it('keeps the accessible names and adds the explanation as their description', () => {
    renderAnswer();
    expect(copyButton()).toHaveAccessibleName('Copy answer');
    expect(saveButton()).toHaveAccessibleName('Save answer as note');
    expect(copyButton()).toHaveAccessibleDescription(COPY_HINT);
    expect(saveButton()).toHaveAccessibleDescription(SAVE_HINT);
    expect(copyButton()).not.toHaveAttribute('title');
    expect(saveButton()).not.toHaveAttribute('title');
    expect(copyButton().textContent).toBe('');
  });

  it('opens on hover after a short delay, then follows the pointer to the neighbour at once', () => {
    vi.useFakeTimers();
    renderAnswer();
    fireEvent.pointerEnter(copyButton());
    expect(tooltip()).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    expect(tooltip()).toHaveTextContent(COPY_HINT);

    fireEvent.pointerLeave(copyButton());
    fireEvent.pointerEnter(saveButton());
    expect(tooltip()).toHaveTextContent(SAVE_HINT);
    expect(tooltip()).toHaveAttribute('data-instant');
  });

  it('stays while the pointer crosses onto the tooltip, and leaves once it is gone from both', () => {
    vi.useFakeTimers();
    renderAnswer();
    fireEvent.pointerEnter(copyButton());
    act(() => { vi.advanceTimersByTime(400); });

    fireEvent.pointerLeave(copyButton());
    fireEvent.pointerEnter(tooltip()!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(tooltip()).toHaveTextContent(COPY_HINT);

    fireEvent.pointerLeave(tooltip()!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(tooltip()).toBeNull();
  });

  it('never opens when the pointer only passes over', () => {
    vi.useFakeTimers();
    renderAnswer();
    fireEvent.pointerEnter(copyButton());
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerLeave(copyButton());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(tooltip()).toBeNull();
  });

  it('dismisses on Escape without moving focus', () => {
    renderAnswer();
    act(() => { copyButton().focus(); });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(tooltip()).toBeNull();
    expect(copyButton()).toHaveFocus();
  });

  it('dismisses when the action is used, and still performs it', async () => {
    renderAnswer();
    act(() => { copyButton().focus(); });
    fireEvent.click(copyButton());
    expect(tooltip()).toBeNull();
    await waitFor(() => { expect(copy).toHaveBeenCalledWith(answer.content); });

    act(() => { saveButton().focus(); });
    fireEvent.click(saveButton());
    expect(tooltip()).toBeNull();
    await waitFor(() => { expect(save).toHaveBeenCalledWith('A complete **answer**.'); });
    await waitFor(() => { expect(notice).toHaveBeenLastCalledWith('success', 'Note saved'); });
  });

  it('does not open from the focus a pointer press gives the button', () => {
    renderAnswer();
    fireEvent.pointerDown(copyButton());
    act(() => { copyButton().focus(); });
    expect(tooltip()).toBeNull();
  });

  it('does not linger when the thread scrolls, the text is selected, or the answer goes away', () => {
    vi.useFakeTimers();
    const { unmount } = renderAnswer();
    fireEvent.pointerEnter(copyButton());
    act(() => { vi.advanceTimersByTime(400); });
    expect(tooltip()).not.toBeNull();
    fireEvent.scroll(window);
    expect(tooltip()).toBeNull();

    act(() => { saveButton().focus(); });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('answer'));
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    expect(tooltip()).toBeNull();

    act(() => { copyButton().blur(); copyButton().focus(); });
    expect(tooltip()).not.toBeNull();
    unmount();
    expect(tooltip()).toBeNull();
  });

  /**
   * Focusing a button below the fold scrolls the thread to reveal it; that
   * scroll must not take away the explanation the focus just asked for.
   */
  it('keeps a focused button\'s tooltip through a scroll that leaves the button in view', () => {
    renderAnswer();
    act(() => { copyButton().focus(); });
    fireEvent.scroll(window);
    expect(tooltip()).toHaveTextContent(COPY_HINT);
  });

  it('offers no save hint where saving is unavailable, and no actions while streaming', () => {
    renderAnswer(answer, false);
    expect(screen.queryByRole('button', { name: 'Save answer as note' })).toBeNull();
    expect(document.body).not.toHaveTextContent(SAVE_HINT);
    cleanup();

    renderAnswer({ ...answer, status: 'streaming', content: 'An unfinished' });
    expect(screen.queryByRole('button', { name: 'Copy answer' })).toBeNull();
    expect(document.body).not.toHaveTextContent(COPY_HINT);
    expect(tooltip()).toBeNull();
  });

  it('paints the tooltip outside the action row, so the row and the answer do not move', () => {
    renderAnswer();
    const row = copyButton().closest('.chat-design-actions')!;
    const before = row.innerHTML;
    act(() => { copyButton().focus(); });
    expect(tooltip()).not.toBeNull();
    expect(row.contains(tooltip())).toBe(false);
    expect(row.innerHTML).toBe(before);
  });
});
