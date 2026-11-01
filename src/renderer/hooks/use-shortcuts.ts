import { useEffect } from 'react';
import { useUiStore } from '../stores/use-ui-store';
import { isLibraryModalOpen, useLibraryStore } from '../stores/use-library-store';
import { isReaderReady, useReaderStore } from '../stores/use-reader-store';
import { useAnnotationStore } from '../stores/use-annotation-store';
import { runFileShortcut } from '../stores/use-open-file-store';
import { locationToAnchor } from '../features/reader/annotations/dom-anchors';

export const isEditableShortcutTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.getAttribute('contenteditable') !== null || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

/**
 * True when a horizontal arrow key belongs to the focused element rather than
 * to page navigation.
 *
 * The Markdown reader puts an overflowing table into the tab order so it can be
 * scrolled sideways from the keyboard. Turning the page on those keys would
 * leave that region focusable and immovable, which is worse than not offering
 * it at all. Only a table that actually overflows claims the key.
 */
const ownsHorizontalArrow = (target: EventTarget | null, key: string): boolean => {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  if (!(target instanceof HTMLElement)) return false;
  const region = target.closest<HTMLElement>('.markdown-table-wrapper');
  return region !== null && region.scrollWidth > region.clientWidth;
};

/** True when reader navigation keys belong to the application rather than to
 * the focused control or scrollable region. */
const isReaderNavigationTarget = (target: EventTarget | null, key: string): boolean =>
  !isEditableShortcutTarget(target) && !ownsHorizontalArrow(target, key);

/** React state updates from document-level popover handlers are committed
 * after the current key event bubbles to window. Inspect the mounted layer as
 * well as Zustand state so Escape cannot close Focus Mode in the same event
 * that dismisses a selection toolbar, note popover, or modal. */
function libraryModalOwnsKeys(): boolean {
  return isLibraryModalOpen(useLibraryStore.getState());
}

/** Inspect the mounted top layer as well as Zustand state so Escape and F11
 * respect top-layer modal precedence over drawers and Focus Mode. A surface
 * fading out (`data-phase="exiting"`, itself or its scrim) is already closed.
 * A confirmation (`alertdialog`) is as modal as any dialog. */
export function hasOpenTopLayer(): boolean {
  const layers = document.querySelectorAll(
    '[role="dialog"]:not([data-testid="compact-drawer-left"]):not([data-testid="compact-drawer-right"]):not([hidden]), [role="alertdialog"]:not([hidden]), [role="menu"]:not([hidden]), [data-testid="annotation-selection-toolbar"]:not([hidden])'
  );
  return [...layers].some((layer) => layer.closest('[data-phase="exiting"]') === null);
}

async function bookmarkCurrentLocation(): Promise<void> {
  const { session, explicitNavigationLocation } = useReaderStore.getState();
  if (!session) return;
  const { document: activeDocument, adapter } = session;
  const location = explicitNavigationLocation ?? adapter.getReadingLocation().location;
  const created = await useAnnotationStore.getState().create({
    documentId: activeDocument.id,
    type: 'bookmark',
    anchor: locationToAnchor(location),
    label: `Page ${String(adapter.getCurrentPage())}`,
  });
  if (!created) return;
  useUiStore.getState().showRightTab('annotations');
  // The panel this just opened may be scrolled anywhere; the new bookmark is
  // what the reader asked for, so it is what the list is brought to.
  useAnnotationStore.getState().requestReveal(created.documentId, created.id);
}

/** Single app-level command router. Editable controls and repeated key events
 * are deliberately excluded so browser/OS editing behavior remains intact. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useUiStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (event.repeat) return;

      if (event.key === 'Escape' && !meta && !event.altKey) {
        if (event.defaultPrevented) return;

        // 1. Topmost application dialogs
        if (store.shortcutsOpen) {
          event.preventDefault();
          store.setShortcutsOpen(false);
          return;
        }
        if (store.settingsOpen) {
          event.preventDefault();
          store.setSettingsOpen(false);
          return;
        }
        // 2. Nested Library modals or DOM popovers/menus
        if (libraryModalOwnsKeys() || hasOpenTopLayer()) {
          event.preventDefault();
          return;
        }
        // 3. Compact drawer (only when no nested modal/popover is active)
        if (store.compactActivePanel !== null) {
          event.preventDefault();
          store.setCompactActivePanel(null);
          return;
        }
        // 4. Distraction-free Focus Mode (only when neither modal nor drawer is open)
        if (store.focusMode) {
          event.preventDefault();
          store.toggleFocusMode();
          return;
        }
        return;
      }

      // F11 is an application-level desktop command, not text editing; keep
      // it deterministic even when focus happens to be in a form control.
      if (
        store.shortcutsOpen ||
        store.settingsOpen ||
        store.compactActivePanel !== null ||
        libraryModalOwnsKeys() ||
        hasOpenTopLayer()
      ) {
        return;
      }
      if (event.key === 'F11' && !meta && !event.altKey) {
        event.preventDefault();
        store.toggleFocusMode(isReaderReady(useReaderStore.getState()));
        return;
      }

      if (event.key === '?' && !meta && !event.altKey && !isEditableShortcutTarget(event.target)) {
        event.preventDefault();
        store.setShortcutsOpen(true);
        return;
      }

      if (!meta && !event.altKey && isReaderNavigationTarget(event.target, event.key)) {
        const reader = useReaderStore.getState();
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault();
          if (reader.currentPage > 1) void reader.goToPage(reader.currentPage - 1);
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault();
          if (reader.currentPage < reader.pageCount) void reader.goToPage(reader.currentPage + 1);
          return;
        }
        if (event.key.toLowerCase() === 't') {
          event.preventDefault();
          reader.toggleToc();
          return;
        }
      }

      if (!meta || event.altKey || isEditableShortcutTarget(event.target)) return;
      const key = event.key.toLowerCase();

      // Mirrors the File menu, whose accelerators do not reach tests or a
      // menu-less window; the command runner ignores a doubled request.
      if (key === 'o') {
        event.preventDefault();
        runFileShortcut(event);
        return;
      }
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault();
        store.showRightTab('search');
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[data-testid="document-search-input"]')?.focus();
        });
        return;
      }
      // On US keyboards Ctrl/Cmd+Plus is reported as key="+" with Shift=true;
      // only the literal plus variant accepts Shift. The documented Shift+A
      // and Shift+N commands are handled above and remain distinct.
      if (key === '+' || (key === '=' && !event.shiftKey)) {
        event.preventDefault();
        void useReaderStore.getState().zoomIn();
        return;
      }
      if ((key === '-' || key === '_') && !event.shiftKey) {
        event.preventDefault();
        void useReaderStore.getState().zoomOut();
        return;
      }
      if (key === '0' && !event.shiftKey) {
        event.preventDefault();
        void useReaderStore.getState().setZoom(1);
        return;
      }
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        void bookmarkCurrentLocation();
        return;
      }
      if (key === 'a' && event.shiftKey) {
        event.preventDefault();
        store.toggleRight();
        return;
      }
      if (key === 'n' && event.shiftKey) {
        event.preventDefault();
        store.showRightTab('annotations');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, []);
}
