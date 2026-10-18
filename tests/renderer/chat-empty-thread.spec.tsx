// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ChatEmptyThread } from '../../src/renderer/features/chat/ChatEmptyThread';

describe('ChatEmptyThread', () => {
  afterEach(cleanup);

  it('stays silent while the session is still loading or once the thread has messages', () => {
    const { rerender } = render(<ChatEmptyThread messageCount={0} isLoading={true} documentTitle="Field Notes" contextItems={[]} startersAvailable={false} onStarter={() => undefined} />);
    expect(screen.queryByTestId('chat-empty-thread')).toBeNull();
    expect(screen.queryByTestId('chat-empty-artwork')).toBeNull();

    rerender(<ChatEmptyThread messageCount={2} isLoading={false} documentTitle="Field Notes" contextItems={[]} startersAvailable={false} onStarter={() => undefined} />);
    expect(screen.queryByTestId('chat-empty-thread')).toBeNull();
  });

  it('shows instructional text with decorative artwork hidden from assistive tech', async () => {
    const { container } = render(<ChatEmptyThread messageCount={0} isLoading={false} documentTitle="Field Notes" contextItems={[]} startersAvailable={false} onStarter={() => undefined} />);

    expect(screen.getByText('Start with this document')).toBeTruthy();
    expect(screen.getByText(/Grounded answers cite exact pages/u)).toBeTruthy();
    expect(screen.getByText(/Attach pages or a selection with Add context/u)).toBeTruthy();

    const artwork = screen.getByTestId('chat-empty-artwork');
    expect(artwork.getAttribute('aria-hidden')).toBe('true');
    // Nothing inside the artwork contributes an accessible name.
    expect(artwork.querySelector('svg')?.getAttribute('focusable')).toBe('false');
    expect(artwork.textContent).toBe('');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
