import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { DocumentMetadata } from '@shared/types/document';
import { isDocumentDrag, readDocumentDragPayload, setDocumentDragPayload } from './document-drag';

/**
 * The two halves of dragging a book into a folder, kept out of the components
 * that use them: a card is the drag source, and a folder row — or the library
 * root — is a drop target. Each side hands its component a ready-to-spread set
 * of props and the class its affordance wears, so the components stay markup.
 *
 * Neither side is a security boundary. The payload is the opaque id defined in
 * `document-drag.ts`, the id is matched against known documents before any
 * request is made, and the main process validates the move again.
 */

/** The tint a surface wears while a book is held over it, in every theme. */
const DROP_TARGET_CLASS = 'bg-accent/10 ring-2 ring-accent';

/** The dragged card's own state while it is in flight. */
const DRAG_SOURCE_CLASS = `opacity-60 ${DROP_TARGET_CLASS}`;

type DragSourceProps = {
  readonly draggable: true;
  readonly 'data-dragging': 'true' | undefined;
  readonly onDragStart: (event: ReactDragEvent) => void;
  readonly onDragEnd: () => void;
  readonly onClickCapture: (event: ReactMouseEvent) => void;
};

/**
 * How long after a drag ends a click is still treated as that drag's own.
 *
 * A trailing click arrives immediately or not at all, so this only has to
 * outlast the browser's own event dispatch. It must stay far below the time a
 * reader needs to aim and press deliberately, because everything inside it is
 * swallowed.
 */
const CLICK_SUPPRESSION_WINDOW_MS = 50;

export function useDocumentDragSource(documentId: string): {
  readonly dragProps: DragSourceProps;
  readonly dragClass: string;
} {
  const [isDragging, setIsDragging] = useState(false);
  const suppressNextClick = useRef(false);
  const expiryTimer = useRef<number | null>(null);

  /**
   * Disarms suppression and cancels any pending expiry.
   *
   * Every path that ends the post-drag window goes through here, so a second
   * drag, a consumed click and unmounting all leave the same clean state and
   * no timer outlives the component that scheduled it.
   */
  const disarm = (): void => {
    suppressNextClick.current = false;
    if (expiryTimer.current === null) return;
    window.clearTimeout(expiryTimer.current);
    expiryTimer.current = null;
  };

  useEffect(() => disarm, []);

  return {
    dragClass: isDragging ? DRAG_SOURCE_CLASS : '',
    dragProps: {
      draggable: true,
      'data-dragging': isDragging ? 'true' : undefined,
      onDragStart: (event) => {
        disarm();
        suppressNextClick.current = true;
        setIsDragging(true);
        setDocumentDragPayload(event.dataTransfer, documentId);
      },
      /**
       * Ends the drag and starts the clock on its trailing click.
       *
       * Chromium usually delivers no click at all after a drag, so suppression
       * has to expire on its own: left armed, it would silently eat the
       * reader's next deliberate press on this card instead.
       */
      onDragEnd: () => {
        setIsDragging(false);
        if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
        expiryTimer.current = window.setTimeout(disarm, CLICK_SUPPRESSION_WINDOW_MS);
      },
      /**
       * Swallows the click a finished drag can still deliver.
       *
       * A drag that ends over a non-target — or is cancelled — can still
       * produce one, and "I filed the book" must never become "the reader is
       * now in the book".
       */
      onClickCapture: (event) => {
        if (!suppressNextClick.current) return;
        disarm();
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}

type DropTargetProps = {
  readonly 'data-drop-active': 'true' | undefined;
  readonly onDragOver: (event: ReactDragEvent) => void;
  readonly onDragLeave: (event: ReactDragEvent) => void;
  readonly onDrop: (event: ReactDragEvent) => void;
};

/**
 * A surface a book can be dropped on, filing it at `destination`.
 *
 * `onDropDocument` is undefined where the surface takes no drops, and a
 * foreign drag is left entirely alone: without `preventDefault` the surface
 * never lights up and the browser's own handling of that drag is untouched.
 */
export function useDocumentDropTarget<Destination>(
  onDropDocument: ((documentId: string, destination: Destination) => void) | undefined,
  destination: Destination
): { readonly dropProps: DropTargetProps; readonly dropClass: string } {
  const [isActive, setIsActive] = useState(false);
  const accepts = (event: ReactDragEvent): boolean =>
    onDropDocument !== undefined && isDocumentDrag(event.dataTransfer);

  return {
    dropClass: isActive ? DROP_TARGET_CLASS : '',
    dropProps: {
      'data-drop-active': isActive ? 'true' : undefined,
      onDragOver: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setIsActive(true);
      },
      onDragLeave: (event) => {
        // Moving between a surface's own children is not leaving the surface.
        const moved = event.relatedTarget;
        if (moved instanceof Node && event.currentTarget.contains(moved)) return;
        setIsActive(false);
      },
      onDrop: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setIsActive(false);
        const documentId = readDocumentDragPayload(event.dataTransfer);
        if (documentId !== null) onDropDocument?.(documentId, destination);
      },
    },
  };
}

/**
 * Files a dropped book, or — with no folder — takes it out of the one it is in.
 *
 * The drag carried nothing but an id, so it is matched against the documents
 * this renderer currently knows before anything is asked of the main process:
 * an id from another window, a stale card, or a payload that was never ours
 * simply does nothing. A drop that would change nothing is also nothing, so no
 * request follows it. The move itself is the route the Move dialog uses, which
 * refreshes the view and the folder counts and reports its own outcome.
 */
export function applyDocumentDrop(
  documents: readonly DocumentMetadata[],
  moveDocument: (documentId: string, folderId: string | null) => Promise<boolean>,
  documentId: string,
  folderId: string | null
): void {
  const dropped = documents.find((doc) => doc.id === documentId);
  if (dropped === undefined || (dropped.folderId ?? null) === folderId) return;
  void moveDocument(documentId, folderId);
}
