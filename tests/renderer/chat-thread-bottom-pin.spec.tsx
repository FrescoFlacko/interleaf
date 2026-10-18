// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ChatMessage } from '@shared/types/ai';
import { useThreadBottomPin } from '../../src/renderer/features/chat/use-thread-bottom-pin';

function scroller(): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 900 });
  element.scrollTop = 400;
  return element;
}

function pin(element: HTMLElement, messages: readonly ChatMessage[], generating = false): void {
  renderHook(() => {
    useThreadBottomPin({
      scrollerRef: { current: element },
      view: 'chat',
      rightTab: 'chat',
      sessionId: 'session-1',
      loading: false,
      messages,
      generating,
    });
  });
}

describe('useThreadBottomPin', () => {
  it('opens a conversation at its newest turn', () => {
    const element = scroller();
    pin(element, [{ id: 'm1', role: 'user', content: 'Hi', status: 'complete', ordinal: 0 } as ChatMessage]);
    expect(element.scrollTop).toBe(900);
  });

  it('opens an empty thread at its top, so the invitation is read from the start (200% zoom)', () => {
    const element = scroller();
    pin(element, []);
    expect(element.scrollTop).toBe(0);
  });

  it('still follows the generating notice of a first turn', () => {
    const element = scroller();
    pin(element, [], true);
    expect(element.scrollTop).toBe(900);
  });
});
