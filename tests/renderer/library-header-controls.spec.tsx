// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LibraryHeaderControls } from '../../src/renderer/features/library/components/LibraryHeaderControls';

/** Gives the strip a scroll geometry jsdom does not lay out. */
function setStripGeometry(strip: HTMLElement, geometry: { scrollWidth: number; clientWidth: number; scrollLeft: number }): void {
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: geometry.scrollWidth });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: geometry.clientWidth });
  strip.scrollLeft = geometry.scrollLeft;
  fireEvent.scroll(strip);
}

describe('LibraryHeaderControls overflow cue', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows no cue while every control fits', () => {
    render(<LibraryHeaderControls />);
    const strip = screen.getByTestId('library-header-controls');
    setStripGeometry(strip, { scrollWidth: 400, clientWidth: 400, scrollLeft: 0 });

    expect(strip.hasAttribute('data-overflow-start')).toBe(false);
    expect(strip.hasAttribute('data-overflow-end')).toBe(false);
    expect(screen.queryByTestId('library-header-scroll-end')).toBeNull();
    expect(screen.queryByTestId('library-header-scroll-start')).toBeNull();
  });

  it('marks each edge with controls past it and scrolls there from its chevron', () => {
    render(<LibraryHeaderControls />);
    const strip = screen.getByTestId('library-header-controls');
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy as typeof strip.scrollBy;

    setStripGeometry(strip, { scrollWidth: 400, clientWidth: 200, scrollLeft: 0 });
    expect(strip.hasAttribute('data-overflow-end')).toBe(true);
    expect(strip.hasAttribute('data-overflow-start')).toBe(false);
    // Both chevrons hold their place while anything overflows, so scrolling
    // never changes the strip's width; the one with nothing past it is hidden.
    expect(screen.getByTestId('library-header-scroll-start').className).toContain('invisible');
    const more = screen.getByRole('button', { name: 'Show more library controls' });
    expect(more.className).not.toContain('invisible');
    // A pointer affordance only: Tab already reaches and reveals each control.
    expect(more.tabIndex).toBe(-1);
    fireEvent.click(more);
    expect(scrollBy).toHaveBeenCalledWith({ left: 160 });

    setStripGeometry(strip, { scrollWidth: 400, clientWidth: 200, scrollLeft: 200 });
    expect(strip.hasAttribute('data-overflow-end')).toBe(false);
    expect(strip.hasAttribute('data-overflow-start')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier library controls' }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -160 });

    // Every control stays in the strip, in order, reachable by keyboard.
    for (const testId of ['library-search-input', 'format-filter-select', 'sort-by-select', 'grid-view-toggle', 'list-view-toggle']) {
      expect(strip.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
  });

  it('scrolls a control that takes focus clear of the fades, whole, or from its start', () => {
    render(<LibraryHeaderControls />);
    const strip = screen.getByTestId('library-header-controls');
    const sort = screen.getByTestId('sort-by-select');
    const place = (element: HTMLElement, left: number, width: number): void => {
      element.getBoundingClientRect = () => ({ left, right: left + width, width, top: 0, bottom: 28, height: 28, x: left, y: 0, toJSON: () => ({}) });
    };
    place(strip, 0, 200);

    // Fits between the faded edges: lands 24 px clear of the end.
    strip.scrollLeft = 0;
    place(sort, 180, 100);
    fireEvent.focus(sort);
    expect(strip.scrollLeft).toBe(104);

    // Fits only the whole strip: centred, entirely in view.
    strip.scrollLeft = 0;
    place(sort, 150, 180);
    fireEvent.focus(sort);
    expect(strip.scrollLeft).toBe(140);

    // Wider than the strip: its start is shown.
    strip.scrollLeft = 100;
    place(sort, -40, 260);
    fireEvent.focus(sort);
    expect(strip.scrollLeft).toBe(60);
  });
});
