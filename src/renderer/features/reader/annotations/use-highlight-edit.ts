import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation } from '@shared/types/annotation';
import { useAnnotationStore } from '../../../stores/use-annotation-store';
import {
  getNotePointerSurfaces,
  subscribeNotePointerRepaints,
  subscribeNotePointerSurfaces,
} from './note-pointer';
import { savedHighlightTarget, type SelectionActionTarget } from './saved-highlight-target';
import {
  computeFocusProxies,
  repositionFromSurfaces,
  type EntrySelector,
  type HighlightPointerRoute,
  type NoteCloseReason,
  type NoteFocusProxy,
  type OpenNote,
} from './use-note-pointer';

const highlightEntriesOf: EntrySelector = (surface) => surface.highlightEntries;
const HIGHLIGHT_FOCUS_FALLBACK_LABEL = 'highlighted text';
const TOOLBAR_SELECTOR = '[data-testid="annotation-selection-toolbar"]';

/** A saved highlight reopened in the selection toolbar. */
export type HighlightEditing = {
  readonly annotation: Annotation;
  readonly target: SelectionActionTarget;
  /** Keyboard activation moves focus into the toolbar; a pointer click leaves it. */
  readonly focusToolbar: boolean;
  readonly close: (reason?: NoteCloseReason) => void;
  /** Closes after an action finished with it, leaving focus where the action put it. */
  readonly release: () => void;
};

type OpenHighlight = OpenNote & { readonly focusToolbar: boolean };

function isEditableHighlight(annotation: Annotation | undefined): annotation is Annotation {
  return annotation?.type === 'highlight' && annotation.color !== null;
}

function isInsideToolbar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TOOLBAR_SELECTOR) !== null;
}

/**
 * Click-to-edit for saved highlights, sharing the note pointer's surfaces,
 * geometry, and dismissal rules.
 *
 * The open highlight is held apart from the store's live selection, so the
 * reader's own selection-clearing (a click collapses the native selection)
 * never closes it, while a new live selection takes over the toolbar and
 * closes it. It follows its painted fragment across repaints and closes when
 * the highlight is no longer painted, deleted, or no longer a coloured
 * highlight, on a document switch, a scroll, a click away, or Escape.
 *
 * Focus follows the note policy: Escape and the explicit close button return
 * focus to whatever opened the editor; every other close leaves focus alone.
 */
export function useHighlightEdit(
  annotations: readonly Annotation[],
  documentId: string | null
): {
  readonly editing: HighlightEditing | null;
  readonly route: HighlightPointerRoute;
  readonly highlightFocusProxies: readonly NoteFocusProxy[];
  readonly openHighlightFromProxy: (annotationId: string, opener: Element | null) => void;
} {
  const [open, setOpen] = useState<OpenHighlight | null>(null);
  const openRef = useRef<OpenHighlight | null>(null);
  openRef.current = open;
  const openerRef = useRef<Element | null>(null);

  const close = useCallback((reason: NoteCloseReason = 'close-button'): void => {
    const opener = openerRef.current;
    openerRef.current = null;
    openRef.current = null;
    setOpen(null);
    if ((reason === 'escape' || reason === 'close-button') && opener instanceof HTMLElement) opener.focus();
  }, []);

  const release = useCallback((): void => { close('repaint'); }, [close]);

  const route = useMemo<HighlightPointerRoute>(() => ({
    open: (next, opener) => {
      openerRef.current = opener;
      setOpen({ ...next, focusToolbar: false });
    },
    isOpen: () => openRef.current !== null,
    close,
  }), [close]);

  // Follow the activated fragment across repaint/reflow; a highlight no longer
  // painted on any surface (removed, recoloured away, section discarded) closes.
  useEffect(() => subscribeNotePointerRepaints(() => {
    const current = openRef.current;
    if (current === null) return;
    const next = repositionFromSurfaces(current.annotationId, current.fragment, current.rect, highlightEntriesOf);
    if (next === null) {
      close('repaint');
      return;
    }
    setOpen({ ...current, rect: next.rect, fragment: next.fragment });
  }), [close]);

  const annotation = open === null ? undefined : annotations.find((a) => a.id === open.annotationId);
  const editable = isEditableHighlight(annotation);
  useEffect(() => {
    if (openRef.current !== null && !editable) close('repaint');
  }, [editable, close]);

  // Nothing survives a document switch (the first mount is not a switch).
  const previousDocumentRef = useRef(documentId);
  useEffect(() => {
    if (previousDocumentRef.current === documentId) return;
    previousDocumentRef.current = documentId;
    close('document-change');
  }, [documentId, close]);

  // A new live selection owns the toolbar.
  const selection = useAnnotationStore((state) => state.selection);
  useEffect(() => {
    if (selection !== null && openRef.current !== null) close('outside-click');
  }, [selection, close]);

  // A press anywhere in the top document outside the toolbar dismisses; the
  // surface's own click then opens whatever highlight or note it lands on.
  // Escape typed inside a section iframe never reaches the toolbar's own
  // top-document listener, so the surface documents are covered here.
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!isInsideToolbar(event.target)) close('outside-click');
    };
    const onFrameKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close('escape');
    };
    const frames = getNotePointerSurfaces().map((surface) => surface.doc).filter((doc) => doc !== document);
    document.addEventListener('pointerdown', onPointerDown, true);
    for (const frame of frames) frame.addEventListener('keydown', onFrameKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      for (const frame of frames) frame.removeEventListener('keydown', onFrameKeyDown, true);
    };
  }, [isOpen, close]);

  const [highlightFocusProxies, setProxies] = useState<readonly NoteFocusProxy[]>([]);
  useEffect(() => {
    const refresh = (): void => { setProxies(computeFocusProxies(highlightEntriesOf, HIGHLIGHT_FOCUS_FALLBACK_LABEL)); };
    refresh();
    const unsubscribeRepaints = subscribeNotePointerRepaints(refresh);
    const unsubscribeSurfaces = subscribeNotePointerSurfaces(refresh);
    return () => {
      unsubscribeRepaints();
      unsubscribeSurfaces();
    };
  }, []);

  const openHighlightFromProxy = useCallback((annotationId: string, opener: Element | null): void => {
    const next = repositionFromSurfaces(annotationId, null, null, highlightEntriesOf);
    if (next === null) return;
    openerRef.current = opener;
    setOpen({ annotationId, rect: next.rect, fragment: next.fragment, focusToolbar: true });
  }, []);

  const rect = open?.rect ?? null;
  const focusToolbar = open?.focusToolbar ?? false;
  const editing = useMemo<HighlightEditing | null>(() => {
    if (rect === null || !isEditableHighlight(annotation)) return null;
    return { annotation, target: savedHighlightTarget(annotation, rect), focusToolbar, close, release };
  }, [annotation, rect, focusToolbar, close, release]);

  return { editing, route, highlightFocusProxies, openHighlightFromProxy };
}
