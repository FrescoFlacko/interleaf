// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  SLIDE_COMPLETION_GRACE_MS,
  SLIDE_TRANSITION_MS,
} from '../../src/renderer/components/slide-presence';
import { ResizablePanel } from '../../src/renderer/components/ResizablePanel';
import { App } from '../../src/renderer/app/App';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';

/**
 * Focused Defect 22 coverage: the top-left/top-right panel toggles animate
 * through real presence phases instead of vanishing. jsdom cannot lay out
 * pixels, so these tests pin the STATE MACHINE contract that the Playwright
 * frame-sampling specs verify geometrically:
 *   closing starts on demand -> content stays mounted non-interactive ->
 *   reduced motion completes instantly -> reopening cancels an exit.
 */

/** A single animation frame, expressed linearly per project promise rules. */
function nextFrame(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    window.requestAnimationFrame(() => { resolve(true); });
  });
}

/** Wait past the full slide budget so timed phases have certainly settled. */
function slideSettled(): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => { resolve(Date.now()); }, SLIDE_TRANSITION_MS + SLIDE_COMPLETION_GRACE_MS + 60);
  });
}

function setReducedMotion(reduce: boolean): void {
  const matchesQuery = (query: string): boolean => reduce && query.includes('prefers-reduced-motion');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const base: Omit<MediaQueryList, 'matches'> = {
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
      return Object.assign(base, { matches: matchesQuery(query) });
    },
  });
}

describe('Defect 22: desktop panel toggle transitions', () => {
  beforeEach(() => {
    useUiStore.setState({
      loadedSettings: DEFAULT_APP_SETTINGS,
      leftOpen: true,
      rightOpen: true,
      leftWidth: 256,
      rightWidth: 320,
      focusMode: false,
      compactActivePanel: null,
    });
    document.body.replaceChildren();
  });

  afterEach(() => {
    cleanup();
    setReducedMotion(false);
    document.body.replaceChildren();
  });

  it('close enters a real exit phase: non-interactive immediately, hidden only after the slide budget', async () => {
    const panelProps = {
      side: 'left' as const,
      width: 320,
      otherOpenWidth: 0,
      onWidthChange: () => undefined,
    };
    const { rerender } = render(
      <ResizablePanel {...panelProps} open>
        <div>Sidebar</div>
      </ResizablePanel>
    );
    const panel = screen.getByTestId('resizable-panel-left');
    const resizerRef: { current: Element | null } = { current: document.querySelector('[data-testid=\"panel-resizer-left\"]') };
    expect(panel.getAttribute('data-panel-state')).toBe('open');

    rerender(
      <ResizablePanel {...panelProps} open={false}>
        <div>Sidebar</div>
      </ResizablePanel>
    );

    // Exit phase contract: still mounted, already unreachable.
    expect(panel.isConnected).toBe(true);
    expect(panel.getAttribute('data-panel-state')).toBe('closing');
    expect(panel).toHaveAttribute('inert');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    // The width is never animated: it holds while the content fades out
    // (opacity only, the 100ms exit), and drops to 0 once, when the exit settles.
    expect(panel.style.width).toBe('320px');
    expect(panel.className).not.toContain('transition-[width]');
    const content = screen.getByTestId('resizable-panel-left-content');
    expect(content.style.opacity).toBe('0');
    // At rest the content carries no transform, so it never becomes the
    // containing block of the fixed popovers inside it.
    expect(content.style.transform).toBe('none');
    // Ease-in, so the fade stays visible until its last frame rather than
    // flattening out near transparent while the column is still held.
    expect(content.style.transition).toBe('opacity var(--dur-exit) ease-in');
    // The drag handle stays mounted as the SAME node; the inert root makes it
    // unreachable without destroying handle identity across toggles.

    await slideSettled();

    // End state: same single instance, fully hidden and inert.
    expect(panel.isConnected).toBe(true);
    expect(panel.getAttribute('data-panel-state')).toBe('closed');
    expect(panel.style.visibility).toBe('hidden');
    expect(panel).toHaveAttribute('inert');
    expect(panel.style.width).toBe('0px');

    rerender(
      <ResizablePanel {...panelProps} open>
        <div>Sidebar</div>
      </ResizablePanel>
    );
    // Reopening restores interactivity and the stored width on one node.
    expect(panel.getAttribute('data-panel-state')).toBe('open');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.hasAttribute('aria-hidden')).toBe(false);
    expect(panel.style.visibility).toBe('');
    expect(panel.style.width).toBe('320px');
    // The width commits at once and, on that same commit, the content's entry
    // animation starts (from transparent, 20px towards the outer edge): no
    // frame waits with the column empty before the fade begins.
    const entering = screen.getByTestId('resizable-panel-left-content');
    expect(entering.style.animation).toBe('panel-content-enter-left var(--dur-base) ease-out');
    expect(entering.style.opacity).toBe('1');
    expect(entering.style.transform).toBe('none');
    expect(entering.style.transition).toContain('opacity');
    expect(entering.style.transition).toContain('transform');
    // Once it has played, nothing of it remains and the panel rests as before.
    act(() => { entering.dispatchEvent(new Event('animationend', { bubbles: true })); });
    expect(entering.style.animation).toBe('none');
    expect(entering.style.opacity).toBe('1');
    expect(entering.style.transform).toBe('none');
    expect(entering.style.transition).toContain('opacity');
    expect(entering.style.transition).toContain('transform');
    expect(resizerRef.current).not.toBeNull();
    expect(document.querySelector('[data-testid="panel-resizer-left"]')).toBe(resizerRef.current);
  });

  it('releases the width as soon as the content fade ends, not after the grace', () => {
    const panelProps = { side: 'right' as const, width: 360, otherOpenWidth: 0, onWidthChange: () => undefined };
    const { rerender } = render(
      <ResizablePanel {...panelProps} open>
        <div><span data-testid="inner">Companion</span></div>
      </ResizablePanel>
    );
    rerender(
      <ResizablePanel {...panelProps} open={false}>
        <div><span data-testid="inner">Companion</span></div>
      </ResizablePanel>
    );
    const panel = screen.getByTestId('resizable-panel-right');
    const content = screen.getByTestId('resizable-panel-right-content');
    const transitionEnd = (propertyName: string): Event =>
      Object.assign(new Event('transitionend', { bubbles: true }), { propertyName });

    // A child's transition, or another property, is not the exit finishing.
    act(() => { screen.getByTestId('inner').dispatchEvent(transitionEnd('opacity')); });
    act(() => { content.dispatchEvent(transitionEnd('transform')); });
    expect(panel.getAttribute('data-panel-state')).toBe('closing');
    expect(panel.style.width).toBe('360px');

    act(() => { content.dispatchEvent(transitionEnd('opacity')); });
    expect(panel.getAttribute('data-panel-state')).toBe('closed');
    expect(panel.style.width).toBe('0px');
  });

  it('a close during the entry drops the entry animation so the exit fade runs', () => {
    const panelProps = { side: 'right' as const, width: 360, otherOpenWidth: 0, onWidthChange: () => undefined };
    const { rerender } = render(<ResizablePanel {...panelProps} open={false}><div>Companion</div></ResizablePanel>);
    rerender(<ResizablePanel {...panelProps} open><div>Companion</div></ResizablePanel>);
    const content = screen.getByTestId('resizable-panel-right-content');
    expect(content.style.animation).toBe('panel-content-enter-right var(--dur-base) ease-out');
    rerender(<ResizablePanel {...panelProps} open={false}><div>Companion</div></ResizablePanel>);
    expect(screen.getByTestId('resizable-panel-right').getAttribute('data-panel-state')).toBe('closing');
    expect(content.style.animation).toBe('none');
    expect(content.style.opacity).toBe('0');
    expect(content.style.transition).toBe('opacity var(--dur-exit) ease-in');
  });

  it('reopening mid-exit cancels the close on the same mounted instance', async () => {
    const panelProps = {
      side: 'left' as const,
      width: 280,
      otherOpenWidth: 0,
      onWidthChange: () => undefined,
    };
    const { rerender } = render(
      <ResizablePanel {...panelProps} open>
        <div>Sidebar</div>
      </ResizablePanel>
    );
    const panel = screen.getByTestId('resizable-panel-left');

    rerender(
      <ResizablePanel {...panelProps} open={false}>
        <div>Sidebar</div>
      </ResizablePanel>
    );
    expect(panel.getAttribute('data-panel-state')).toBe('closing');

    rerender(
      <ResizablePanel {...panelProps} open>
        <div>Sidebar</div>
      </ResizablePanel>
    );
    expect(panel.getAttribute('data-panel-state')).toBe('open');
    expect(panel.style.width).toBe('280px');
    // A close cut short is not a reopen from rest: no entry animation replays.
    expect(screen.getByTestId('resizable-panel-left-content').style.animation).toBe('none');

    await slideSettled();
    // The cancelled exit never resolves into a hidden state.
    expect(panel.getAttribute('data-panel-state')).toBe('open');
    expect(panel.isConnected).toBe(true);
  });

  it('prefers-reduced-motion applies the closed end state immediately', () => {
    setReducedMotion(true);
    const panelProps = {
      side: 'right' as const,
      width: 340,
      otherOpenWidth: 0,
      onWidthChange: () => undefined,
    };
    const { rerender } = render(
      <ResizablePanel {...panelProps} open>
        <div>Companion</div>
      </ResizablePanel>
    );
    const panel = screen.getByTestId('resizable-panel-right');

    rerender(
      <ResizablePanel {...panelProps} open={false}>
        <div>Companion</div>
      </ResizablePanel>
    );
    // No exit dwell: state, geometry, and hiding land on this very commit.
    expect(panel.getAttribute('data-panel-state')).toBe('closed');
    expect(panel.style.visibility).toBe('hidden');
    expect(panel).toHaveAttribute('inert');
    expect(panel.style.width).toBe('0px');
  });

  it('focus inside a closing/hiding panel moves to the owning header toggle', () => {
    setReducedMotion(true);
    const toggleButton = document.createElement('button');
    toggleButton.setAttribute('data-testid', 'toggle-left-panel');
    document.body.append(toggleButton);

    const panelProps = {
      side: 'left' as const,
      width: 300,
      otherOpenWidth: 0,
      onWidthChange: () => undefined,
    };
    const { rerender } = render(
      <ResizablePanel {...panelProps} open>
        <button type="button" data-testid="panel-inner-button">Inside</button>
      </ResizablePanel>
    );
    const inner = screen.getByTestId('panel-inner-button');
    inner.focus();
    expect(document.activeElement).toBe(inner);

    rerender(
      <ResizablePanel {...panelProps} open={false}>
        <button type="button" data-testid="panel-inner-button">Inside</button>
      </ResizablePanel>
    );
    expect(document.activeElement).toBe(toggleButton);
    toggleButton.remove();
  });
});

describe('Defect 22: compact drawer overlay presence', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({
      loadedSettings: DEFAULT_APP_SETTINGS,
      leftOpen: true,
      rightOpen: true,
      focusMode: false,
      compactActivePanel: null,
    });
    document.body.replaceChildren();
  });

  afterEach(() => {
    cleanup();
    setReducedMotion(false);
    document.body.replaceChildren();
  });

  it('enter phases rest at translateX(0) and exit phases keep a single mounted drawer until done', async () => {
    const { unmount } = render(<App />);

    act(() => {
      useUiStore.setState({ compactActivePanel: 'left' });
    });

    const drawer = screen.getByTestId('compact-drawer-left');
    expect(drawer.getAttribute('data-slide-phase')).toBe('entering');
    expect(drawer.style.transform).toBe('translateX(-100%)');
    // Longhand authoring (deterministic under style diffs/tooling).
    expect(drawer.style.transitionProperty).toBe('none');
    expect(drawer.style.transitionDuration).toBe('0ms');

    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    expect(drawer.getAttribute('data-slide-phase')).toBe('open');
    expect(drawer.style.transform).toBe('translateX(0%)');
    expect(drawer.style.transitionProperty).toBe('transform');
    expect(drawer.style.transitionDuration).toBe(`${String(SLIDE_TRANSITION_MS)}ms`);
    expect(drawer.style.transitionTimingFunction).toBe('var(--ease-drawer)');

    // Focus hands off on the EXITING COMMIT itself, not after unmount.
    act(() => {
      useUiStore.getState().setCompactActivePanel(null);
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('toggle-left-panel');

    // Exit is real: same node slides out non-interactive, backdrop fades too.
    expect(drawer.getAttribute('data-slide-phase')).toBe('exiting');
    expect(drawer).toHaveAttribute('inert');
    expect(drawer.style.transform).toBe('translateX(-100%)');
    const backdrop = screen.getByTestId('compact-backdrop');
    expect(backdrop.className).toContain('opacity-0');
    expect(backdrop.className).toContain('pointer-events-none');

    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-left')).toBeNull(); });
    expect(screen.queryByTestId('compact-backdrop')).toBeNull();
    unmount();
  });


  it('reduced-motion opening skips the off-screen entering phase entirely', () => {
    setReducedMotion(true);
    render(<App />);
    act(() => {
      useUiStore.setState({ compactActivePanel: 'right' });
    });
    const drawer = screen.getByTestId('compact-drawer-right');
    // First committed frame: open phase, at-rest transform, real transition
    // declaration, focus already inside — never entering/off-screen.
    expect(drawer.getAttribute('data-slide-phase')).toBe('open');
    expect(drawer.style.transform).toBe('translateX(0%)');
    expect(drawer.style.transitionProperty).toBe('transform');
    expect(drawer.style.transitionDuration).toBe(`${String(SLIDE_TRANSITION_MS)}ms`);
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it('leaving the compact range clears the drawer synchronously and never resurrects it', async () => {
    const widthStub = (value: number): void => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value });
      window.dispatchEvent(new Event('resize'));
    };
    const { unmount } = render(<App />);
    act(() => {
      useUiStore.setState({ compactActivePanel: 'right' });
    });
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    expect(screen.getByTestId('compact-drawer-right')).toBeInTheDocument();

    act(() => {
      widthStub(1000);
    });
    // Compact state cleared while the drawer is still mounted and exiting:
    // focus is already on the owning toggle, never lost to <body>.
    expect(useUiStore.getState().compactActivePanel).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('toggle-right-panel');
    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-right')).toBeNull(); });

    act(() => {
      widthStub(480);
    });
    await act(async () => {
      await slideSettled();
    });
    // No stale resurrection; a deliberate open still works.
    expect(screen.queryByTestId('compact-drawer-right')).toBeNull();
    act(() => {
      useUiStore.getState().toggleRight();
    });
    expect(screen.getByTestId('compact-drawer-right')).toBeInTheDocument();
    unmount();
    widthStub(480);
  });

  it('switching mounts exactly one instance of each surface while the old drawer exits', async () => {
    const { unmount } = render(<App />);
    act(() => {
      useUiStore.setState({ compactActivePanel: 'left' });
    });
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });

    fireEvent.click(screen.getByTestId('switch-to-companion-button'));

    // Switch suppression: no late focus theft to a header toggle mid-exit;
    // focus stays with the interactive surface until the replacement takes it.
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('toggle-left-panel');
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('toggle-right-panel');

    // Overlap window: incoming Companion drawer plus outgoing Library drawer,
    // but never a duplicated instance of either surface.
    expect(screen.getAllByTestId('companion-panel')).toHaveLength(1);
    expect(screen.getAllByTestId('sidebar-library')).toHaveLength(1);
    expect(screen.getByTestId('compact-drawer-right')).toBeInTheDocument();

    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-left')).toBeNull(); });
    expect(screen.getAllByTestId('companion-panel')).toHaveLength(1);
    expect(screen.getByTestId('compact-drawer-right').getAttribute('data-slide-phase')).toBe('open');
    unmount();
  });
});
