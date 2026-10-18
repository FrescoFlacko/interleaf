// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useShortcuts } from '../../src/renderer/hooks/use-shortcuts';

/**
 * Who owns the horizontal arrow keys.
 *
 * The Markdown reader puts an overflowing table into the tab order so a reader
 * without a pointer can scroll it. That only works if the application's
 * page-turn shortcut lets those keys through while such a table holds focus —
 * otherwise the region is focusable and immovable, which is worse than not
 * offering it. jsdom lays nothing out, so the overflow is stated here; the
 * Electron test proves the same thing against a real layout engine.
 */

function tableWrapper(scrollWidth: number, clientWidth: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-table-wrapper';
  wrapper.setAttribute('tabindex', '0');
  Object.defineProperty(wrapper, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: clientWidth, configurable: true });
  document.body.appendChild(wrapper);
  return wrapper;
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('horizontal arrow keys in the reader', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('an overflowing table keeps the arrow keys instead of turning the page', () => {
    const { unmount } = renderHook(() => {
      useShortcuts();
    });
    const overflowing = tableWrapper(900, 400);
    const cell = document.createElement('td');
    overflowing.appendChild(cell);

    expect(press(overflowing, 'ArrowRight').defaultPrevented).toBe(false);
    expect(press(overflowing, 'ArrowLeft').defaultPrevented).toBe(false);
    // Focus is usually on the wrapper, but a click can leave it on a cell.
    expect(press(cell, 'ArrowRight').defaultPrevented).toBe(false);
    // Vertical paging is not a horizontal scroll and stays with the reader.
    expect(press(overflowing, 'PageDown').defaultPrevented).toBe(true);

    unmount();
  });

  test('a table that fits, and the page itself, leave the arrow keys to the reader', () => {
    const { unmount } = renderHook(() => {
      useShortcuts();
    });
    const fitting = tableWrapper(400, 400);

    expect(press(fitting, 'ArrowRight').defaultPrevented).toBe(true);
    expect(press(document.body, 'ArrowRight').defaultPrevented).toBe(true);
    expect(press(document.body, 'ArrowLeft').defaultPrevented).toBe(true);

    unmount();
  });
});
