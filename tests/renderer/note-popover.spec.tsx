// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axe from 'axe-core';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import {
  getNotePointerSurfaces,
  notePointerDetachOwner,
  notePointerInvalidateLayout,
  notePointerPaint,
  resetNotePointer,
  type RangeLike,
} from '../../src/renderer/features/reader/annotations/note-pointer';
import { computeNotePopoverPlacement } from '../../src/renderer/features/reader/annotations/note-popover-placement';
import type { Annotation } from '@shared/types/annotation';
import { testReaderSession } from '../helpers/reader-session';
import { testAnnotation, testLoadedAnnotations } from '../helpers/annotation';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/* jsdom Range.getClientRects() returns an empty list, so the paint registry is
   driven with structural fake ranges — the production consumer (adapters)
   passes real DOM Ranges whose getClientRects() satisfies the same contract.
   jsdom also performs no layout: the popover's measured size falls back to the
   first-paint estimate, which the placement assertions account for. */

type RectTuple = readonly [l: number, t: number, r: number, b: number];

function fakeRange(rects: readonly RectTuple[]): RangeLike {
  const list = rects.map(([l, t, r, b]) => ({ left: l, top: t, right: r, bottom: b }));
  return { getClientRects: () => list };
}

const NOTE_ANCHOR = { format: 'markdown' as const, quote: { exact: '', prefix: '', suffix: '' }, blockIndex: 1 };

function makeDocument(id: string, hash: string): import('@shared/types/document').DocumentMetadata {
  return {
    id,
    title: id,
    author: null,
    format: 'markdown',
    storageMode: 'managed',
    fileSize: 10,
    fileMtimeMs: 0,
    fileHash: hash,
    pageCount: null,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    source: null,
  };
}

const DOC_ONE = makeDocument('doc-1', 'hash-1');
const DOC_TWO = makeDocument('doc-2', 'hash-2');

function makeNote(id: string, text: string, selectedText = 'The reader engine decouples layout extraction'): Annotation {
  return testAnnotation({ id, type: 'note', anchor: NOTE_ANCHOR, selectedText, note: text, color: null });
}

/** Paints through the production registry with a stable test owner. */
const testOwner = {};
function seedPainted(notes: readonly { note: Annotation; rects: readonly RectTuple[] }[]): void {
  notePointerPaint(
    testOwner,
    document,
    notes.map(({ note, rects }) => ({ annotation: note, range: fakeRange(rects) }))
  );
}

const RECT_A: readonly RectTuple[] = [[10, 40, 210, 60]];
const RECT_B: readonly RectTuple[] = [[300, 300, 500, 320]];

describe('Defect 20: note pointer affordance + popover', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 });
    document.body.replaceChildren();
    useAnnotationStore.setState({
      annotations: [],
      selection: null,
      selectionIssue: null,
      error: null,
      loaded: testLoadedAnnotations('doc-1'),
      isLoading: false,
    });
    useReaderStore.setState({ session: testReaderSession(DOC_ONE), isLoading: false, error: null });
    resetNotePointer();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    resetNotePointer();
  });

  async function mountReader(): Promise<HTMLElement> {
    const { ReaderView } = await import('../../src/renderer/features/reader/ReaderView');
    renderWithChatStore(chat, <ReaderView />);
    const container = await waitFor(() => {
      const el = screen.getByTestId('pdf-viewport-container');
      expect(el).toBeTruthy();
      return el;
    });
    return container;
  }

  async function raf(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => { requestAnimationFrame(() => { resolve(null); }); });
    });
  }

  function expectPlacementFor(rects: readonly RectTuple[]): { left: string; top: string } {
    const [l, t, r, b] = rects[0]!;
    const { left, top } = computeNotePopoverPlacement(
      { left: l, top: t, right: r, bottom: b },
      { width: 320, height: 96 },
      { width: 1024, height: 768 }
    );
    return { left: `${String(left)}px`, top: `${String(top)}px` };
  }

  it('hover uses the LATEST pointer coordinates per frame and clears the cursor at the exact range edge', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-1', 'Latest coordinates body.')] });
    seedPainted([{ note: makeNote('note-1', 'Latest coordinates body.'), rects: RECT_A }]);
    const container = await mountReader();

    // Note → outside within one frame: the rAF must consume the outside point.
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 0 });
    fireEvent.pointerMove(container, { clientX: 500, clientY: 500, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('');

    // Inside the fragment: pointer cursor.
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('pointer');

    // 1px beyond the right edge (+1px slack): cursor cleared again.
    fireEvent.pointerMove(container, { clientX: 212, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('');

    // Back just inside the slack boundary: pointer cursor returns.
    fireEvent.pointerMove(container, { clientX: 210, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('pointer');
  });

  it('reconciles a stationary hover when repaint, reflow, or scroll changes note geometry', async () => {
    const note = makeNote('note-stationary', 'Stationary hover body.');
    let currentRects: readonly RectTuple[] = RECT_A;
    const range: RangeLike = { getClientRects: () => fakeRange(currentRects).getClientRects() };
    useAnnotationStore.setState({ annotations: [note] });
    notePointerPaint(testOwner, document, [{ annotation: note, range }]);
    const container = await mountReader();

    // Establish the hover point once. Subsequent geometry changes deliberately
    // do not dispatch another pointermove.
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('pointer');

    // Reflow moves the note away from the stationary pointer: invalidation
    // must clear the root cursor without waiting for another move.
    currentRects = RECT_B;
    act(() => { notePointerInvalidateLayout(); });
    expect(container.style.cursor).toBe('');

    // A later reflow can move a note under the same stationary pointer; the
    // repaint subscriber must restore the pointer affordance immediately.
    currentRects = [[90, 45, 190, 65]];
    act(() => { notePointerInvalidateLayout(); });
    expect(container.style.cursor).toBe('pointer');

    // Repainting with no live range removes the note beneath the pointer and
    // clears the affordance without pointer movement.
    act(() => { notePointerPaint(testOwner, document, []); });
    expect(container.style.cursor).toBe('');

    // Scroll invalidation follows the same stationary-pointer path. The
    // range is restored under the pointer, then moved away before scroll.
    currentRects = RECT_A;
    act(() => { notePointerPaint(testOwner, document, [{ annotation: note, range }]); });
    expect(container.style.cursor).toBe('pointer');
    currentRects = RECT_B;
    fireEvent.scroll(container);
    expect(container.style.cursor).toBe('');
  });

  it('retained pointer-travel distance (pointermove with collapsed selection) suppresses the post-drag click', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-drag', 'Drag note body.')] });
    seedPainted([{ note: makeNote('note-drag', 'Drag note body.'), rects: RECT_A }]);
    const container = await mountReader();

    // Drag across the fragment with pointer events; the selection stays
    // collapsed, so the retained drag distance is the operative guard. The
    // browser fires click AFTER pointerup, so the distance must survive it.
    fireEvent.pointerDown(container, { clientX: 30, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 200, clientY: 55, buttons: 1 });
    fireEvent.pointerUp(container, { clientX: 205, clientY: 56, buttons: 0 });
    fireEvent.click(container, { clientX: 205, clientY: 56 });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(screen.queryByTestId('note-popover')).toBeNull();

    // pointercancel aborts the drag: the next clean click opens normally.
    fireEvent.pointerDown(container, { clientX: 30, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 400, clientY: 90, buttons: 1 });
    fireEvent.pointerCancel(container);
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    expect(await screen.findByTestId('note-popover')).toBeTruthy();

    // lostpointercapture also resets the retained distance.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    fireEvent.pointerDown(container, { clientX: 30, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 400, clientY: 90, buttons: 1 });
    fireEvent.pointerUp(container, { clientX: 400, clientY: 90, buttons: 0 });
    fireEvent.lostPointerCapture(container);
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    expect(await screen.findByTestId('note-popover')).toBeTruthy();

    // pointerleave before a click also leaves a clean slate.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    fireEvent.pointerDown(container, { clientX: 30, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 400, clientY: 90, buttons: 1 });
    fireEvent.pointerLeave(container);
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    expect(await screen.findByTestId('note-popover')).toBeTruthy();
  });

  it('popover never takes focus; Escape and the close button restore the opener; outside click and scroll never steal focus', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-fx', 'Focus policy body.')] });
    seedPainted([{ note: makeNote('note-fx', 'Focus policy body.'), rects: RECT_A }]);
    const container = await mountReader();
    container.focus();
    expect(document.activeElement).toBe(container);

    fireEvent.click(container, { clientX: 100, clientY: 50 });
    const popover = await screen.findByTestId('note-popover');
    // Non-modal: focus stays on the opener; the popover does not absorb it.
    expect(document.activeElement).toBe(container);
    expect(popover.getAttribute('role')).toBe('dialog');

    // Escape restores focus to the opener.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(document.activeElement).toBe(container);

    // Re-open, then close via the close button: opener focus restored again.
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await screen.findByTestId('note-popover');
    fireEvent.click(screen.getByTestId('note-popover-close'));
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(document.activeElement).toBe(container);

    // Outside click on another control closes the bubble WITHOUT stealing
    // focus from that control. A plain button in the top document stands in
    // for any real control the user might click next.
    const otherControl = document.createElement('button');
    otherControl.textContent = 'Other control';
    document.body.appendChild(otherControl);
    otherControl.focus();
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await screen.findByTestId('note-popover');
    // Real input fires pointerdown before click; the popover closes on the
    // pointerdown phase (production outside-close contract).
    fireEvent.pointerDown(otherControl);
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(document.activeElement).toBe(otherControl);

    // Reader scroll closes the bubble and likewise leaves focus alone.
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await screen.findByTestId('note-popover');
    fireEvent.scroll(container);
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(document.activeElement).toBe(otherControl);
  });

  it('repaint repositions the open popover onto fresh geometry and removing the note closes it (positive assertions)', async () => {
    const note = makeNote('note-rp', 'Repaint body.');
    useAnnotationStore.setState({ annotations: [note] });
    seedPainted([{ note, rects: RECT_A }]);
    const container = await mountReader();

    fireEvent.click(container, { clientX: 100, clientY: 50 });
    const popover = await screen.findByTestId('note-popover');
    const firstPlacement = expectPlacementFor(RECT_A);
    expect(popover.style.left).toBe(firstPlacement.left);
    expect(popover.style.top).toBe(firstPlacement.top);

    // Same note re-painted after a reflow: the bubble repositions onto the
    // freshly painted rect — stale geometry is never preserved.
    seedPainted([{ note, rects: RECT_B }]);
    await waitFor(() => {
      const next = expectPlacementFor(RECT_B);
      expect(popover.style.left).toBe(next.left);
      expect(popover.style.top).toBe(next.top);
    });

    // A repaint that drops the note closes the bubble positively.
    seedPainted([]);
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
  });

  it('drag leave while pressed suppresses the re-entry release click; a clean click still opens', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-dlv', 'Leave body.')] });
    seedPainted([{ note: makeNote('note-dlv', 'Leave body.'), rects: RECT_A }]);
    const container = await mountReader();

    // Press on the note, drag, LEAVE the surface with the button still held,
    // re-enter still pressed, and release on the note: the release-generated
    // click must not open (explicit left-while-pressed suppression).
    fireEvent.pointerDown(container, { clientX: 100, clientY: 50, buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 400, clientY: 90, buttons: 1 });
    fireEvent.pointerLeave(container, { buttons: 1 });
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 1 });
    fireEvent.pointerUp(container, { clientX: 100, clientY: 50, buttons: 0 });
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(screen.queryByTestId('note-popover')).toBeNull();

    // A fresh press re-seeds the controller: the clean click opens normally.
    fireEvent.pointerDown(container, { clientX: 100, clientY: 50, buttons: 1 });
    fireEvent.pointerUp(container, { clientX: 100, clientY: 50, buttons: 0 });
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    expect(await screen.findByTestId('note-popover')).toBeTruthy();
  });

  it('popover reconciliation follows the activated fragment identity with a nearest-fragment fallback', async () => {
    const note = makeNote('note-frag', 'Fragment body.');
    useAnnotationStore.setState({ annotations: [note] });
    const threeSegments: readonly RectTuple[] = [
      [10, 100, 200, 120],
      [10, 130, 200, 150],
      [10, 160, 200, 170],
    ];
    seedPainted([{ note, rects: threeSegments }]);
    const container = await mountReader();

    // Activate the LAST fragment (a later line of a multiline note).
    fireEvent.click(container, { clientX: 100, clientY: 165 });
    const popover = await screen.findByTestId('note-popover');
    const thirdPlacement = expectPlacementFor([[10, 160, 200, 170]]);
    expect(popover.style.left).toBe(thirdPlacement.left);
    expect(popover.style.top).toBe(thirdPlacement.top);

    // Reflow moves every fragment: reconciliation stays on the SAME live
    // fragment (identity), never collapsing back to the first rect.
    seedPainted([{ note, rects: [
      [10, 140, 200, 160],
      [10, 170, 200, 190],
      [10, 200, 200, 210],
    ] }]);
    await waitFor(() => {
      const moved = expectPlacementFor([[10, 200, 200, 210]]);
      expect(popover.style.left).toBe(moved.left);
      expect(popover.style.top).toBe(moved.top);
    });

    // The activated fragment no longer exists (fewer lines): the popover
    // reconciles to the live fragment nearest the previous anchor.
    seedPainted([{ note, rects: [
      [10, 140, 200, 160],
      [10, 190, 200, 210],
    ] }]);
    await waitFor(() => {
      const nearest = expectPlacementFor([[10, 190, 200, 210]]);
      expect(popover.style.left).toBe(nearest.left);
      expect(popover.style.top).toBe(nearest.top);
    });
  });

  it('adapter detach closes an already-open popover immediately without Escape', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-det', 'Detach body.')] });
    seedPainted([{ note: makeNote('note-det', 'Detach body.'), rects: RECT_A }]);
    const container = await mountReader();

    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await screen.findByTestId('note-popover');

    // Adapter close detaches its surfaces; the open popover must reconcile
    // in the same notification burst — no Escape, no extra paint needed.
    act(() => { notePointerDetachOwner(testOwner); });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
  });

  it('focus proxies: keyboard activation route per painted note, hidden when offscreen', async () => {
    useAnnotationStore.setState({ annotations: [
      makeNote('note-kb', 'Keyboard body.'),
      makeNote('note-empty', 'Empty preview body.', '   '),
      makeNote('note-off', 'Offscreen body.'),
    ] });
    seedPainted([
      { note: makeNote('note-kb', 'Keyboard body.'), rects: RECT_A },
      { note: makeNote('note-empty', 'Empty preview body.', '   '), rects: RECT_B },
      { note: makeNote('note-off', 'Offscreen body.'), rects: [[10, 5000, 200, 5020]] },
    ]);
    const container = await mountReader();

    // Two proxies for the visible notes; the offscreen note gets none (an
    // invisible tab stop would be worse than none).
    const proxy = await screen.findByTestId('note-focus-proxy-note-kb');
    const emptyPreviewProxy = await screen.findByTestId('note-focus-proxy-note-empty');
    expect(screen.queryByTestId('note-focus-proxy-note-off')).toBeNull();
    expect(proxy.getAttribute('aria-label')).toBe('Open reader note: The reader engine decouples layout extraction');
    expect(emptyPreviewProxy.getAttribute('aria-label')).toBe('Open reader note: noted text');
    expect(proxy.getAttribute('type')).toBe('button');
    expect(proxy.style.pointerEvents).toBe('none');
    expect(proxy.style.position).toBe('fixed');

    // Native button activation (Enter/Space default behavior) opens the
    // exact note with the proxy recorded as the opener; the browser has the
    // focused proxy as activeElement during keyboard activation, which jsdom
    // models with an explicit focus before the activation click. The E2E
    // path proves the same flow with real Tab traversal.
    proxy.focus();
    fireEvent.click(proxy);
    const popover = await screen.findByTestId('note-popover');
    expect(popover.textContent).toContain('Keyboard body.');
    expect(document.activeElement).toBe(proxy);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(document.activeElement).toBe(proxy);

    // Removing the paint removes the proxy (cleanup, no stale tab stops).
    act(() => { notePointerDetachOwner(testOwner); });
    await waitFor(() => { expect(screen.queryByTestId('note-focus-proxy-note-kb')).toBeNull(); });
    expect(container).toBeTruthy();
  });

  it('runtime window shrink re-places the popover inside the new viewport', async () => {
    useAnnotationStore.setState({ annotations: [makeNote('note-rz', 'Resize body.')] });
    seedPainted([{ note: makeNote('note-rz', 'Resize body.'), rects: [[500, 200, 700, 220]] }]);
    const container = await mountReader();

    fireEvent.click(container, { clientX: 600, clientY: 210 });
    const popover = await screen.findByTestId('note-popover');

    // Shrink the window at runtime: placement must rerender (viewport is
    // reactive state) so the panel stays inside the new viewport, even
    // though the panel's own measured size is unchanged.
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 420 });
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 320 });
    fireEvent(window, new Event('resize'));
    await waitFor(() => {
      const left = Number.parseFloat(popover.style.left);
      const top = Number.parseFloat(popover.style.top);
      const width = Math.min(320, 420 - 16);
      expect(left).toBeGreaterThanOrEqual(8 - 1);
      expect(left + width).toBeLessThanOrEqual(420 - 8 + 1);
      expect(top).toBeGreaterThanOrEqual(8 - 1);
      expect(top).toBeLessThanOrEqual(320 - 8 + 1);
    });
  });

  it('warmed rect cache is rebuilt after reflow invalidation and reused between moves', async () => {
    const note = makeNote('note-cache', 'Cache body.');
    let currentRects = [{ left: 10, top: 40, right: 210, bottom: 60 }];
    let rectCalls = 0;
    const countingRange = {
      getClientRects: () => {
        rectCalls += 1;
        return currentRects;
      },
    };
    useAnnotationStore.setState({ annotations: [note] });
    notePointerPaint(testOwner, document, [{ annotation: note, range: countingRange }]);
    const container = await mountReader();

    // Hover warms the cache: exactly one rects read for this fragment.
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('pointer');
    const callsAfterWarm = rectCalls;
    expect(callsAfterWarm).toBeGreaterThan(0);

    // Repeated moves reuse the cache: no per-pointermove rects re-reads.
    fireEvent.pointerMove(container, { clientX: 120, clientY: 52, buttons: 0 });
    await raf();
    fireEvent.pointerMove(container, { clientX: 150, clientY: 55, buttons: 0 });
    await raf();
    expect(rectCalls).toBe(callsAfterWarm);

    // Reflow (no repaint, no scroll): the fragment moves and the window
    // resizes. Invalidation must rebuild the cache exactly once so the new
    // location hit-tests and the stale location does not.
    currentRects = [{ left: 300, top: 300, right: 500, bottom: 320 }];
    fireEvent(window, new Event('resize'));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

    const callsAfterInvalidate = rectCalls;
    fireEvent.pointerMove(container, { clientX: 100, clientY: 50, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('');
    fireEvent.pointerMove(container, { clientX: 400, clientY: 310, buttons: 0 });
    await raf();
    expect(container.style.cursor).toBe('pointer');
    expect(rectCalls).toBeLessThanOrEqual(callsAfterInvalidate + 1);
  });

  it('active-document switch resets the registry and closes the popover', async () => {
    const note = makeNote('note-sw', 'Document switch body.');
    useAnnotationStore.setState({ annotations: [note] });
    seedPainted([{ note, rects: RECT_A }]);
    const container = await mountReader();
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    await screen.findByTestId('note-popover');
    expect(getNotePointerSurfaces().length).toBeGreaterThan(0);

    useReaderStore.setState({ session: testReaderSession(DOC_TWO) });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    expect(getNotePointerSurfaces()).toHaveLength(0);
  });

  it('renders the Markdown note body without echoing the selected text and passes an accessibility audit', async () => {
    const selectedText = 'The reader engine decouples layout extraction';
    const note = makeNote('note-quote', '## Finding\n\n- **First** item\n- Second item with `code`', selectedText);
    useAnnotationStore.setState({ annotations: [note] });
    seedPainted([{ note, rects: RECT_A }]);
    const container = await mountReader();
    fireEvent.click(container, { clientX: 100, clientY: 50 });
    const popover = await screen.findByTestId('note-popover');

    expect(screen.queryByTestId('note-popover-quote')).toBeNull();
    expect(popover.textContent).not.toContain(selectedText);
    expect(popover.querySelector('q')).toBeNull();
    const body = screen.getByTestId('note-popover-body');
    expect(body.querySelector('h2')?.textContent).toBe('Finding');
    expect(body.querySelectorAll('li')).toHaveLength(2);

    const results = await axe.run(popover, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
