// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { notePointerPaint, resetNotePointer } from '../../src/renderer/features/reader/annotations/note-pointer';
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

/**
 * Defect 20 cross-realm regression: events dispatched by the sandboxed ebook
 * iframe belong to the IFRAME's realm, so they fail top-realm
 * `instanceof PointerEvent`/`MouseEvent` checks. The SurfaceController must
 * use a structural numeric guard. This spec constructs events with the
 * iframe realm's own constructors — under a top-realm instanceof
 * implementation the cursor/click assertions below FAIL.
 */

const DOC: import('@shared/types/document').DocumentMetadata = {
  id: 'doc-1',
  title: 'Cross-realm Doc',
  author: null,
  format: 'markdown',
  storageMode: 'managed',
  fileSize: 10,
  fileMtimeMs: 0,
  fileHash: 'hash-1',
  pageCount: null,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  source: null,
};

function makeNote(): Annotation {
  return testAnnotation({
    id: 'note-iframe',
    type: 'note',
    anchor: { format: 'markdown', quote: { exact: '', prefix: '', suffix: '' }, blockIndex: 1 },
    selectedText: 'The reader engine',
    note: 'Cross-realm note body.',
    color: null,
  });
}

describe('Defect 20: cross-realm iframe events drive the note pointer', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    useAnnotationStore.setState({
      annotations: [makeNote()],
      selection: null,
      selectionIssue: null,
      error: null,
      loaded: testLoadedAnnotations('doc-1'),
      isLoading: false,
    });
    useReaderStore.setState({ session: testReaderSession(DOC), isLoading: false, error: null });
    resetNotePointer();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    resetNotePointer();
  });

  it('iframe-realm pointer events set the cursor and open the popover', async () => {
    // Stand-in for the foliate section iframe: its own realm and document.
    const iframeEl = document.createElement('iframe');
    document.body.appendChild(iframeEl);
    await waitFor(() => {
      expect(iframeEl.contentDocument?.body).toBeTruthy();
      expect(iframeEl.contentWindow).toBeTruthy();
    });
    const frameWindow = iframeEl.contentWindow!;
    const frameDoc = iframeEl.contentDocument!;

    // Sanity meta-assertion: an event built in the iframe realm genuinely
    // fails the top-realm instanceof check that used to break this path.
    const realmProbe = new (realmEventConstructors(frameWindow).MouseEvent)('click', { bubbles: true });
    expect(realmProbe instanceof window.MouseEvent).toBe(false);

    const owner = {};
    const note = makeNote();
    const toTopClientRect = (rect: { left: number; top: number; right: number; bottom: number }) => ({
      left: 200 + rect.left,
      top: 200 + rect.top,
      right: 200 + rect.right,
      bottom: 200 + rect.bottom,
    });
    notePointerPaint(owner, frameDoc, [{
      annotation: note,
      range: { getClientRects: () => [{ left: 500, top: 500, right: 700, bottom: 520 }] },
    }, {
      annotation: note,
      range: { getClientRects: () => [{ left: 10, top: 40, right: 210, bottom: 60 }] },
    }], { toTopClientRect });

    const { ReaderView } = await import('../../src/renderer/features/reader/ReaderView');
    renderWithChatStore(chat, <ReaderView />);
    await waitFor(() => { expect(screen.getByTestId('pdf-viewport-container')).toBeTruthy(); });

    // Pointer events constructed in the iframe realm must drive the hover
    // cursor (top-realm instanceof would drop these events entirely).
    fireEventInRealm(frameWindow, frameDoc.body, 'pointermove', { clientX: 100, clientY: 50, buttons: 0 });
    await act(async () => {
      await new Promise((resolve) => { requestAnimationFrame(() => { resolve(null); }); });
    });
    expect(frameDoc.body.style.cursor).toBe('pointer');

    // Click activation through the iframe realm opens the top-frame popover.
    fireEventInRealm(frameWindow, frameDoc.body, 'pointerdown', { clientX: 100, clientY: 50, buttons: 1 });
    fireEventInRealm(frameWindow, frameDoc.body, 'pointerup', { clientX: 100, clientY: 50, buttons: 0 });
    fireEventInRealm(frameWindow, frameDoc.body, 'click', { clientX: 100, clientY: 50, buttons: 0 });
    await screen.findByTestId('note-popover');
    expect(screen.getByTestId('note-popover-body').textContent).toBe('Cross-realm note body.');

    // The previous anchor is stored in top-window coordinates. When the
    // activated iframe fragment disappears on repaint, fallback must compare
    // candidate fragments after applying the same translation, otherwise a
    // large frame offset selects the wrong later fragment.
    notePointerPaint(owner, frameDoc, [
      {
        annotation: note,
        range: {
          getClientRects: () => [
            { left: 0, top: 0, right: 20, bottom: 10 },
            { left: 180, top: 180, right: 200, bottom: 190 },
          ],
        },
      },
    ], { toTopClientRect });
    const expected = computeNotePopoverPlacement(
      { left: 200, top: 200, right: 220, bottom: 210 },
      { width: 320, height: 96 },
      { width: 1024, height: 768 }
    );
    await waitFor(() => {
      const popover = screen.getByTestId('note-popover');
      expect(popover.style.left).toBe(String(expected.left) + 'px');
      expect(popover.style.top).toBe(String(expected.top) + 'px');
    });

    // Escape closes (top-document key handling); the pointer is still over
    // the noted text, so the affordance legitimately persists until the
    // pointer moves off-range (also cross-realm).
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByTestId('note-popover')).toBeNull(); });
    fireEventInRealm(frameWindow, frameDoc.body, 'pointermove', { clientX: 400, clientY: 400, buttons: 0 });
    await act(async () => {
      await new Promise((resolve) => { requestAnimationFrame(() => { resolve(null); }); });
    });
    expect(frameDoc.body.style.cursor).toBe('');

    // A focus proxy is rendered in the top document even for iframe notes.
    // Native keyboard activation is covered by the Electron path; this
    // browser-realm check ensures the proxy exists and uses the top geometry.
    const proxy = await screen.findByTestId('note-focus-proxy-note-iframe');
    expect(proxy.style.left).toBe('200px');
    expect(proxy.style.top).toBe('200px');
  });
});

/**
 * The event constructors belonging to one realm.
 *
 * `PointerEvent` is optional because jsdom does not implement it in every
 * version this suite runs against, and the caller falls back to a mouse event
 * exactly as the production code's realm-agnostic checks expect.
 */
type RealmEventConstructors = {
  readonly MouseEvent: new (type: string, init: MouseEventInit) => MouseEvent;
  readonly PointerEvent?: new (type: string, init: PointerEventInit) => PointerEvent;
};

/**
 * Reads another realm's event constructors.
 *
 * TypeScript declares these on the global `window` binding, not on the
 * `Window` an iframe's `contentWindow` hands back, so the frame's own
 * constructors are named here and checked at runtime before use. Constructing
 * through them is the whole point of this spec: an event from the frame realm
 * must fail the top realm's `instanceof`.
 */
function realmEventConstructors(realm: Window): RealmEventConstructors {
  const constructors: RealmEventConstructors = realm as Window & RealmEventConstructors;
  if (typeof constructors.MouseEvent !== 'function') {
    throw new Error('The realm under test exposes no MouseEvent constructor.');
  }
  return constructors;
}

/** Dispatches an event constructed from the given realm's constructors. */
function fireEventInRealm(
  realm: Window,
  target: EventTarget,
  type: 'pointermove' | 'pointerdown' | 'pointerup' | 'click',
  init: { clientX: number; clientY: number; buttons: number }
): void {
  const realmWindow = realmEventConstructors(realm);
  const event = type.startsWith('pointer') && typeof realmWindow.PointerEvent === 'function'
    ? new realmWindow.PointerEvent(type, { bubbles: true, cancelable: true, ...init, pointerId: 1, isPrimary: true })
    : new realmWindow.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
}
