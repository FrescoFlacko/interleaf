// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { ResizablePanel, type PanelSide } from '../../src/renderer/components/ResizablePanel';
import { PANEL_EXIT_CEILING_MS, PANEL_EXIT_EXPECTED_MS } from '../../src/renderer/components/panel-exit';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';

/**
 * Defect 22, the desktop panel close (preparation, fade, release). At the
 * close the panel is at once inert, hidden from assistive technology and
 * focus moves to its toggle, while the content stays fully visible at full
 * width, prepared for the fade. Only after the page has rendered that prepared
 * state does the unchanged 100ms fade start, so a host that stalls while
 * preparing delays the fade instead of running it unseen. The width is
 * released once, when the fade really ends; a fixed ceiling from the close
 * releases a close that never gets its frames. Nothing is prepared while
 * the panel is open.
 *
 * Frames are delivered by hand so a stall can be held, and timers are fake.
 * jsdom has no animations; each case stands in the fade a browser creates.
 */

/** Animation frames that run only when the test says so. */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, FrameRequestCallback>();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true, writable: true,
    value: (callback: FrameRequestCallback): number => { const id = next++; queued.set(id, callback); return id; },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true, writable: true,
    value: (id: number): void => { queued.delete(id); },
  });
  return {
    pending: (): number => queued.size,
    /** Runs one frame: every callback queued before it. */
    run: (): void => {
      const due = [...queued.entries()];
      queued.clear();
      act(() => { for (const [, callback] of due) callback(performance.now()); });
    },
  };
}

class FakeFade {
  playState: AnimationPlayState = 'running';
  pending = true;
  startTime: number | null = null;
  readonly finished: Promise<FakeFade>;
  private settle: { resolve: (fade: FakeFade) => void; reject: (reason: DOMException) => void } | null = null;

  constructor(readonly transitionProperty = 'opacity') {
    this.finished = new Promise<FakeFade>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.finished.catch(() => undefined);
  }

  start(): void { this.pending = false; this.startTime = 0; }
  finish(): void { this.playState = 'finished'; this.settle?.resolve(this); }
  cancel(): void { this.playState = 'idle'; this.settle?.reject(new DOMException('The transition was cancelled', 'AbortError')); }
}

/** The animations a browser reports for the content: those not yet finished or cancelled. */
function stubAnimations(content: HTMLElement, fades: readonly FakeFade[]): void {
  Object.defineProperty(content, 'getAnimations', {
    configurable: true,
    value: () => fades.filter((fade) => fade.playState === 'running' || fade.playState === 'paused'),
  });
}

/** Every value `data-panel-state` takes, in order, ending with the current one. */
function recordStates(panel: HTMLElement): { readonly states: () => readonly string[] } {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => { records.push(...batch); });
  observer.observe(panel, { attributeFilter: ['data-panel-state'], attributeOldValue: true });
  return {
    states: () => {
      records.push(...observer.takeRecords());
      return [...records.map((record) => record.oldValue ?? ''), panel.getAttribute('data-panel-state') ?? ''];
    },
  };
}

function setReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string): MediaQueryList => Object.assign({
      media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }, { matches: reduce && query.includes('prefers-reduced-motion') }),
  });
}

const WIDTH = { left: 256, right: 320 } as const;

function panelTree(side: PanelSide, open: boolean) {
  return (
    <ResizablePanel side={side} width={WIDTH[side]} otherOpenWidth={0} onWidthChange={() => undefined} open={open}>
      <div><button type="button" data-testid={`inner-${side}`}>Inside</button></div>
    </ResizablePanel>
  );
}

function mountPanel(side: PanelSide, open = true) {
  const view = render(panelTree(side, open));
  return {
    panel: screen.getByTestId(`resizable-panel-${side}`),
    content: screen.getByTestId(`resizable-panel-${side}-content`),
    setOpen: (next: boolean) => { view.rerender(panelTree(side, next)); },
    unmount: view.unmount,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

/** Deactivated, full width, content fully visible and prepared for the fade. */
function expectPreparing(panel: HTMLElement, content: HTMLElement, side: PanelSide): void {
  expect(panel.getAttribute('data-panel-state')).toBe('preparing');
  expect(panel).toHaveAttribute('inert');
  expect(panel).toHaveAttribute('aria-hidden', 'true');
  expect(panel.style.width).toBe(`${String(WIDTH[side])}px`);
  expect(panel.style.visibility).toBe('');
  expect(content.style.opacity).toBe('1');
  expect(content.style.willChange).toBe('opacity');
  expect(content.style.transform).toBe('none');
}

/** Fading at full width: the unchanged 100ms ease-in exit. */
function expectFading(panel: HTMLElement, content: HTMLElement, side: PanelSide): void {
  expect(panel.getAttribute('data-panel-state')).toBe('closing');
  expect(panel).toHaveAttribute('inert');
  expect(panel.style.width).toBe(`${String(WIDTH[side])}px`);
  expect(content.style.opacity).toBe('0');
  expect(content.style.transition).toBe('opacity var(--dur-exit) ease-in');
  expect(content.style.willChange).toBe('opacity');
  expect(content.style.transform).toBe('none');
}

function expectReleased(panel: HTMLElement, content: HTMLElement): void {
  expect(panel.getAttribute('data-panel-state')).toBe('closed');
  expect(panel.style.width).toBe('0px');
  expect(panel.style.visibility).toBe('hidden');
  expect(panel).toHaveAttribute('inert');
  expect(content.style.willChange).toBe('');
}

function expectOpenAtRest(panel: HTMLElement, content: HTMLElement, side: PanelSide): void {
  expect(panel.getAttribute('data-panel-state')).toBe('open');
  expect(panel).not.toHaveAttribute('inert');
  expect(panel.style.width).toBe(`${String(WIDTH[side])}px`);
  expect(content.style.opacity).toBe('1');
  expect(content.style.willChange).toBe('');
}

let frames: ReturnType<typeof manualFrames>;

describe('Defect 22: panel close preparation, fade and release', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    frames = manualFrames();
    setReducedMotion(false);
    useUiStore.setState({ loadedSettings: DEFAULT_APP_SETTINGS });
    document.body.replaceChildren();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setReducedMotion(false);
    document.body.replaceChildren();
  });

  for (const side of ['left', 'right'] as const) {
    describe(`${side} panel`, () => {
      it('deactivates at once and keeps the content visible until the prepared state has rendered, then fades', () => {
        const toggle = document.createElement('button');
        toggle.setAttribute('data-testid', `toggle-${side}-panel`);
        document.body.append(toggle);
        const { panel, content, setOpen } = mountPanel(side);
        expectOpenAtRest(panel, content, side);
        screen.getByTestId(`inner-${side}`).focus();

        setOpen(false);
        expect(document.activeElement).toBe(toggle);
        expectPreparing(panel, content, side);
        // The frame that renders the prepared state.
        frames.run();
        expectPreparing(panel, content, side);
        // The next frame: the prepared state has been rendered; the fade starts.
        frames.run();
        expectFading(panel, content, side);
      });

      it('while frames stall in preparation the content stays visible and the fade waits; the ceiling from the close releases it', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        stubAnimations(content, []);
        const record = recordStates(panel);
        setOpen(false);
        await advance(PANEL_EXIT_CEILING_MS - 1);
        expectPreparing(panel, content, side);
        await advance(1);
        expectReleased(panel, content);
        expect(frames.pending()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(record.states()).toEqual(['open', 'preparing', 'closed']);
      });

      it('a fade still pending past the old deadline keeps the width, and its real end releases it once', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        const fade = new FakeFade();
        stubAnimations(content, [fade]);
        const record = recordStates(panel);
        setOpen(false);
        frames.run();
        frames.run();
        expectFading(panel, content, side);
        await advance(PANEL_EXIT_EXPECTED_MS + 150);
        expectFading(panel, content, side);
        fade.start();
        fade.finish();
        await flush();
        expectReleased(panel, content);
        expect(record.states()).toEqual(['open', 'preparing', 'closing', 'closed']);
      });

      it('a started fade stalled past the old deadline is not cut short; its opacity end event releases it', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        const fade = new FakeFade();
        fade.start();
        stubAnimations(content, [fade]);
        setOpen(false);
        frames.run();
        frames.run();
        await advance(PANEL_EXIT_EXPECTED_MS + 100);
        expectFading(panel, content, side);
        act(() => { content.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' })); });
        expectReleased(panel, content);
      });

      it('a fade that completes without an end event releases the width', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        const fade = new FakeFade();
        fade.start();
        stubAnimations(content, [fade]);
        setOpen(false);
        frames.run();
        frames.run();
        await advance(110);
        expectFading(panel, content, side);
        fade.finish();
        await flush();
        expectReleased(panel, content);
      });

      it('with no fade to wait for, the width is released at the old deadline from the fade start', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        stubAnimations(content, []);
        setOpen(false);
        frames.run();
        frames.run();
        await advance(PANEL_EXIT_EXPECTED_MS - 1);
        expectFading(panel, content, side);
        await advance(1);
        expectReleased(panel, content);
      });

      it('ignores end events of a child, of another property and of an earlier close', async () => {
        const { panel, content, setOpen } = mountPanel(side);
        const first = new FakeFade();
        const fades = [first];
        stubAnimations(content, fades);
        setOpen(false);
        frames.run();
        frames.run();
        setOpen(true);
        first.cancel();
        const second = new FakeFade();
        fades.push(second);
        setOpen(false);
        frames.run();
        frames.run();
        await advance(PANEL_EXIT_EXPECTED_MS + 50);
        act(() => {
          screen.getByTestId(`inner-${side}`).dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' }));
          content.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }));
        });
        await flush();
        expectFading(panel, content, side);
        second.finish();
        await flush();
        expectReleased(panel, content);
      });
    });
  }

  // Fades that only start after a stall but inside the accepted range (a first
  // faded frame by +550ms after the action, end and release by +650ms) must
  // run to their end: +541 was a recorded cold close, +549 the review's replay.
  for (const [side, start] of [['left', 541], ['right', 549]] as const) {
    it(`a fade that only starts at +${String(start)} after a stall is not cut short: the width goes at its end, +${String(start + 100)}`, async () => {
      const { panel, content, setOpen } = mountPanel(side);
      const fade = new FakeFade();
      stubAnimations(content, [fade]);
      const record = recordStates(panel);
      setOpen(false);
      frames.run();
      frames.run();
      expectFading(panel, content, side);
      await advance(start);
      fade.start();
      await advance(99);
      expectFading(panel, content, side);
      await advance(1);
      fade.finish();
      await flush();
      expectReleased(panel, content);
      expect(record.states()).toEqual(['open', 'preparing', 'closing', 'closed']);
    });
  }

  it('at the edge, a fade starting at +550 is still held at +649, and its end and the ceiling at +650 release the width once', async () => {
    const { panel, content, setOpen } = mountPanel('left');
    const fade = new FakeFade();
    stubAnimations(content, [fade]);
    const record = recordStates(panel);
    setOpen(false);
    frames.run();
    frames.run();
    await advance(550);
    fade.start();
    await advance(99);
    expectFading(panel, content, 'left');
    // The fade's end and the ceiling fall together; whichever runs first releases, once.
    fade.finish();
    await advance(1);
    await flush();
    expectReleased(panel, content);
    await advance(PANEL_EXIT_CEILING_MS);
    expect(record.states()).toEqual(['open', 'preparing', 'closing', 'closed']);
  });

  it('a fade ending exactly as the ceiling falls releases the width once', async () => {
    const { panel, content, setOpen } = mountPanel('right');
    const fade = new FakeFade();
    stubAnimations(content, [fade]);
    const record = recordStates(panel);
    setOpen(false);
    frames.run();
    frames.run();
    fade.start();
    await advance(PANEL_EXIT_CEILING_MS);
    fade.finish();
    await flush();
    expectReleased(panel, content);
    await advance(PANEL_EXIT_CEILING_MS);
    expect(record.states()).toEqual(['open', 'preparing', 'closing', 'closed']);
  });

  it('the ceiling covers the whole accepted range and no more: the 650ms close', () => {
    // Any fade that starts by +550 ends by +650, so the ceiling cannot fall
    // before it; and it never holds the band beyond the close's 650ms.
    expect(PANEL_EXIT_CEILING_MS).toBeGreaterThanOrEqual(550 + 100);
    expect(PANEL_EXIT_CEILING_MS).toBeLessThanOrEqual(650);
  });

  it('the ceiling counts from the close, across preparation and fade', async () => {
    const { panel, content, setOpen } = mountPanel('left');
    stubAnimations(content, [new FakeFade()]);
    setOpen(false);
    await advance(200);
    frames.run();
    frames.run();
    expectFading(panel, content, 'left');
    await advance(PANEL_EXIT_CEILING_MS - 200 - 1);
    expectFading(panel, content, 'left');
    await advance(1);
    expectReleased(panel, content);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a reopen before the preparation has rendered cancels every frame, timer and the hint', async () => {
    const { panel, content, setOpen } = mountPanel('right');
    stubAnimations(content, []);
    setOpen(false);
    frames.run();
    setOpen(true);
    expect(frames.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expectOpenAtRest(panel, content, 'right');
    frames.run();
    await advance(PANEL_EXIT_CEILING_MS * 2);
    expectOpenAtRest(panel, content, 'right');
  });

  it('a reopen during the fade keeps the panel open when the old fade later settles', async () => {
    const { panel, content, setOpen } = mountPanel('left');
    const fade = new FakeFade();
    fade.start();
    stubAnimations(content, [fade]);
    setOpen(false);
    frames.run();
    frames.run();
    await advance(50);
    setOpen(true);
    expect(vi.getTimerCount()).toBe(0);
    fade.finish();
    await flush();
    await advance(PANEL_EXIT_CEILING_MS);
    expectOpenAtRest(panel, content, 'left');
  });

  it('a rapid close, reopen and close releases once, for the last close', async () => {
    const { panel, content, setOpen } = mountPanel('left');
    stubAnimations(content, []);
    const record = recordStates(panel);
    setOpen(false);
    await advance(40);
    setOpen(true);
    setOpen(false);
    await advance(PANEL_EXIT_CEILING_MS - 1);
    expectPreparing(panel, content, 'left');
    await advance(1);
    expectReleased(panel, content);
    expect(record.states()).toEqual(['open', 'preparing', 'open', 'preparing', 'closed']);
  });

  it('unmounting while preparing or fading leaves no frame, timer, listener or later update', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preparing = mountPanel('left');
    preparing.setOpen(false);
    preparing.unmount();
    expect(frames.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const fading = mountPanel('right');
    const fade = new FakeFade();
    stubAnimations(fading.content, [fade]);
    const removed = vi.spyOn(fading.content, 'removeEventListener');
    fading.setOpen(false);
    frames.run();
    frames.run();
    fading.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removed.mock.calls.some(([type]) => type === 'transitionend')).toBe(true);
    fade.finish();
    await flush();
    await advance(PANEL_EXIT_CEILING_MS);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('reduced motion closes on the same commit, with no preparation, frame or hint', () => {
    setReducedMotion(true);
    const { panel, content, setOpen } = mountPanel('left');
    setOpen(false);
    expectReleased(panel, content);
    expect(frames.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an initially closed panel opens unprepared and closes through preparation', async () => {
    const { panel, content, setOpen } = mountPanel('right', false);
    expectReleased(panel, content);
    setOpen(true);
    act(() => { content.dispatchEvent(new Event('animationend', { bubbles: true })); });
    expectOpenAtRest(panel, content, 'right');
    const fade = new FakeFade();
    stubAnimations(content, [fade]);
    setOpen(false);
    expectPreparing(panel, content, 'right');
    frames.run();
    frames.run();
    expectFading(panel, content, 'right');
    fade.start();
    fade.finish();
    await flush();
    expectReleased(panel, content);
  });
});
