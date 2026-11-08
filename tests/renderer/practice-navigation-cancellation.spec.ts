// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelPracticeNavigationOnInput } from '../../src/renderer/features/practice/practice-navigation-cancellation';

afterEach(() => { document.body.replaceChildren(); });

describe('practice navigation ownership', () => {
  it('cancels for gestures in the reader or its ebook frame and removes listeners', () => {
    const frame = document.createElement('iframe');
    frame.title = 'Ebook Content';
    document.body.append(frame);
    const cancel = vi.fn();
    const dispose = cancelPracticeNavigationOnInput(cancel);
    document.dispatchEvent(new Event('wheel'));
    frame.contentDocument?.dispatchEvent(new Event('pointerdown'));
    expect(cancel).toHaveBeenCalledTimes(2);
    dispose();
    document.dispatchEvent(new Event('keydown'));
    frame.contentDocument?.dispatchEvent(new Event('pointerdown'));
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
