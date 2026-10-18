/**
 * The library's private drag payload.
 *
 * A dragged book carries one thing: the opaque document id the renderer
 * already holds. No filesystem path, no title, and no document content ever
 * enters a `DataTransfer`, because a drag is readable by whatever the pointer
 * ends up over — including content outside this app.
 *
 * The custom MIME type is what makes the payload ours: a file dragged in from
 * Finder, a text selection dragged from a web page, or any other external drag
 * simply does not carry it, so a drop target can tell "a book from this
 * library" apart from "something else" before it reads a single byte.
 */
export const DOCUMENT_DRAG_MIME = 'application/x-interleaf-document-id';

/** The shared identifier bound (`identifierSchema`); real ids are UUIDs. */
const MAX_ID_LENGTH = 128;

/** Starts a document drag. The id is the entire payload. */
export function setDocumentDragPayload(dataTransfer: DataTransfer, documentId: string): void {
  dataTransfer.setData(DOCUMENT_DRAG_MIME, documentId);
  dataTransfer.effectAllowed = 'move';
}

/** Whether this drag is a library book rather than a file or foreign payload. */
export function isDocumentDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && [...dataTransfer.types].includes(DOCUMENT_DRAG_MIME);
}

/**
 * Reads the dragged document id, or `null` if this drag is not one of ours.
 *
 * Drag data is renderer input like any other, so the string is bounded here and
 * matched against the documents the caller actually knows before it is used.
 * Neither check is the security boundary: the main process validates the move
 * request again, and it remains the authority.
 */
export function readDocumentDragPayload(dataTransfer: DataTransfer | null): string | null {
  if (!isDocumentDrag(dataTransfer) || dataTransfer === null) return null;
  const raw = dataTransfer.getData(DOCUMENT_DRAG_MIME);
  if (raw.length === 0 || raw.length > MAX_ID_LENGTH) return null;
  // Whitespace never appears in an identifier, so its presence marks the
  // payload as something other than one of ours regardless of its length.
  return /^\S+$/u.test(raw) ? raw : null;
}
