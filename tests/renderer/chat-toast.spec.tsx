// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ChatToast } from '../../src/renderer/features/chat/ChatToast';
import { CHAT_TOAST_SUCCESS_MS, useChatToast } from '../../src/renderer/features/chat/use-chat-toast';

/**
 * The chat panel's one transient-notice slot, tested where its timing is
 * observable. The panel's own spec proves the toast follows persistence and
 * stays out of the thread and composer; this spec owns how long it lives.
 */
function Harness() {
  const toast = useChatToast();
  return (
    <>
      <button type="button" data-testid="publish-success" onClick={() => { toast.publish('success', 'Note saved'); }}>
        save
      </button>
      <button type="button" data-testid="publish-error" onClick={() => { toast.publish('error', 'Could not save note'); }}>
        fail
      </button>
      <ChatToast notice={toast.notice} onDismiss={toast.dismiss} />
    </>
  );
}

const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms); }); };

describe('chat toast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows a success notice and clears it on its own within a bounded interval', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('publish-success'));

    expect(screen.getByTestId('chat-toast')).toHaveTextContent('Note saved');
    expect(screen.getByTestId('chat-toast-announcement')).toHaveTextContent('Note saved');
    expect(CHAT_TOAST_SUCCESS_MS).toBeLessThanOrEqual(10_000);

    advance(CHAT_TOAST_SUCCESS_MS - 1);
    expect(screen.getByTestId('chat-toast')).toBeVisible();

    advance(1);
    expect(screen.queryByTestId('chat-toast')).toBeNull();
    // The announcement empties with it, so a later save is a fresh utterance
    // rather than a repeat of unchanged text.
    expect(screen.getByTestId('chat-toast-announcement')).toHaveTextContent('');
  });

  it('restarts the interval for a consecutive save instead of inheriting the old one', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('publish-success'));
    advance(CHAT_TOAST_SUCCESS_MS - 500);
    expect(screen.getByTestId('chat-toast')).toBeVisible();

    fireEvent.click(screen.getByTestId('publish-success'));
    // The first save's remaining 500ms is discarded, not carried over.
    advance(CHAT_TOAST_SUCCESS_MS - 1);
    expect(screen.getByTestId('chat-toast')).toBeVisible();
    // Only one timer is ever outstanding.
    expect(vi.getTimerCount()).toBe(1);

    advance(1);
    expect(screen.queryByTestId('chat-toast')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('changes the live region again when a second save says the same words', () => {
    render(<Harness />);
    const region = screen.getByTestId('chat-toast-announcement');

    fireEvent.click(screen.getByTestId('publish-success'));
    expect(region).toHaveTextContent('Note saved');
    const firstAnnouncement = region.firstElementChild;

    const observer = new MutationObserver(() => undefined);
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    advance(CHAT_TOAST_SUCCESS_MS - 500);
    fireEvent.click(screen.getByTestId('publish-success'));
    const records = observer.takeRecords();
    observer.disconnect();

    // The words are identical, so text alone would leave the region untouched
    // and the second save would pass in silence. The announcement is replaced
    // instead, which is a change assistive technology can act on.
    expect(records.map((record) => record.type)).toContain('childList');
    expect(region.firstElementChild).not.toBe(firstAnnouncement);
    expect(region).toHaveTextContent('Note saved');

    // Still one region and one painted notice, so it is spoken once, not twice.
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(screen.getAllByTestId('chat-toast')).toHaveLength(1);

    // And the visible confirmation restarted rather than inheriting the first
    // save's remaining 500ms.
    advance(CHAT_TOAST_SUCCESS_MS - 1);
    expect(screen.getByTestId('chat-toast')).toBeVisible();
    advance(1);
    expect(screen.queryByTestId('chat-toast')).toBeNull();
  });

  it('cancels its pending timer when the panel goes away', () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByTestId('publish-success'));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a failure until it is dismissed, and speaks it exactly once', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('publish-error'));

    const toast = screen.getByTestId('chat-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    // The panel is the announcement, so the polite region stays empty and the
    // failure is not read twice.
    expect(toast).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('chat-toast-announcement')).toHaveTextContent('');
    expect(vi.getTimerCount()).toBe(0);

    advance(CHAT_TOAST_SUCCESS_MS * 3);
    expect(screen.getByTestId('chat-toast')).toHaveTextContent('Could not save note');

    fireEvent.click(screen.getByTestId('chat-toast-dismiss'));
    expect(screen.queryByTestId('chat-toast')).toBeNull();
  });

  it('replaces a failure with a later success, which then expires normally', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('publish-error'));
    fireEvent.click(screen.getByTestId('publish-success'));

    const toast = screen.getByTestId('chat-toast');
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(toast).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('chat-toast-dismiss')).toBeNull();

    advance(CHAT_TOAST_SUCCESS_MS);
    expect(screen.queryByTestId('chat-toast')).toBeNull();
  });

  it('renders one live region even when nothing has happened yet', () => {
    render(<Harness />);
    // The region is mounted up front: a region inserted alongside its own text
    // is not reliably announced.
    const announcement = screen.getByTestId('chat-toast-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');
    expect(announcement).toHaveTextContent('');
    expect(screen.queryByTestId('chat-toast')).toBeNull();
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('carries no accessibility violations in either tone', async () => {
    // axe schedules its own work, so this one case runs on the real clock.
    vi.useRealTimers();
    render(<Harness />);

    fireEvent.click(screen.getByTestId('publish-success'));
    expect(screen.getByTestId('chat-toast')).toBeVisible();
    const success = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(success.violations).toEqual([]);

    fireEvent.click(screen.getByTestId('publish-error'));
    expect(screen.getByTestId('chat-toast')).toHaveAttribute('role', 'alert');
    const failure = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(failure.violations).toEqual([]);
  });
});
