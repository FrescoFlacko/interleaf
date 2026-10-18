import { useState, useEffect, useRef, type SyntheticEvent } from 'react';
import type { DocumentMetadata, Folder } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';
import { formatFileSize } from '../document-format';
import { DocumentDetailsActionsMenu, type DetailsActionItem } from './DocumentDetailsActionsMenu';
import { EstimatedTokensRow } from './EstimatedTokensRow';
import { Select } from '../../../components/ui/select';
import { phaseAttributes, useModalPresence } from '../../../components/ui/popover-presence';
import { useDialogFocus } from './library-dialog-focus';

export { useDialogFocus } from './library-dialog-focus';

// New Folder Modal
export function NewFolderModal({
  open,
  parentId,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly parentId: string | null;
  readonly onClose: () => void;
  /** Resolves with the created folder, or `null` when nothing was created. */
  readonly onSubmit: (name: string, parentId?: string | null) => Promise<Folder | null>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialogFocus(open, onClose);
  const { shown, phase } = useModalPresence(open ? true : null);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (shown === null) return null;

  async function handleSave() {
    if (name.trim().length === 0) {
      setError('Folder name cannot be empty.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(name.trim(), parentId);
      if (result !== null) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={parentId ? 'Create new subfolder' : 'Create new folder'}
        tabIndex={-1}
        data-testid="new-folder-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-sm rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-text-primary">
          {parentId ? 'Create New Subfolder' : 'Create New Folder'}
        </h2>
        <form
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            void handleSave();
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <div>
            <label htmlFor="folder-name-input" className="block text-xs font-medium text-text-secondary">
              Folder Name
            </label>
            <input
              id="folder-name-input"
              data-testid="folder-name-input"
              aria-invalid={error !== null}
              aria-describedby={error ? 'new-folder-error' : undefined}
              type="text"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. Computer Science"
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-hidden"
            />
          </div>

          {error && <p id="new-folder-error" role="alert" className="text-xs text-danger">{error}</p>}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-folder-button"
              disabled={submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Rename Folder Modal
export function RenameFolderModal({
  folder: subject,
  onClose,
  onSubmit,
}: {
  readonly folder: Folder | null;
  readonly onClose: () => void;
  /** Resolves with the renamed folder, or `null` when nothing was renamed. */
  readonly onSubmit: (id: string, name: string) => Promise<Folder | null>;
}) {
  const { shown: folder, phase } = useModalPresence(subject);
  const [name, setName] = useState(folder?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialogFocus(subject !== null, onClose);

  useEffect(() => {
    if (folder) {
      setName(folder.name);
      setError(null);
      setSubmitting(false);
    }
  }, [folder]);

  if (!folder) return null;

  async function handleSave() {
    if (!folder) return;
    if (name.trim().length === 0) {
      setError('Folder name cannot be empty.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await onSubmit(folder.id, name.trim());
      if (result !== null) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename folder.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Rename folder"
        tabIndex={-1}
        data-testid="rename-folder-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-sm rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-text-primary">Rename Folder</h2>
        <form
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            void handleSave();
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <div>
            <label htmlFor="rename-folder-input" className="block text-xs font-medium text-text-secondary">
              Folder Name
            </label>
            <input
              id="rename-folder-input"
              data-testid="rename-folder-input"
              aria-invalid={error !== null}
              aria-describedby={error ? 'rename-folder-error' : undefined}
              type="text"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-surface px-3 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-hidden"
            />
          </div>

          {error && <p id="rename-folder-error" role="alert" className="text-xs text-danger">{error}</p>}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-rename-folder"
              disabled={submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Delete Folder Modal
export function DeleteFolderModal({
  folder: subject,
  onClose,
  onConfirm,
}: {
  readonly folder: Folder | null;
  readonly onClose: () => void;
  /** Resolves `false` when the deletion did not happen. */
  readonly onConfirm: (id: string) => Promise<boolean>;
}) {
  const { shown: folder, phase } = useModalPresence(subject);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus(subject !== null, onClose);

  useEffect(() => {
    if (folder) {
      setError(null);
      setSubmitting(false);
    }
  }, [folder]);

  if (!folder) return null;

  async function handleDelete() {
    if (!folder) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm(folder.id);
      if (result) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete folder.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete folder"
        tabIndex={-1}
        data-testid="delete-folder-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-sm rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-text-primary">Delete Folder</h2>
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">
          Are you sure you want to delete <span className="font-semibold text-text-primary">'{folder.name}'</span>?
          All nested subfolders will also be deleted. Documents in this folder tree will remain in your library and move to the root library.
        </p>
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-delete-folder"
            disabled={submitting}
            onClick={() => {
              void handleDelete();
            }}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-on-danger hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Deleting...' : 'Delete Folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Move Document Modal
export function MoveDocumentModal({
  document: subject,
  folders,
  onClose,
  onSubmit,
  focusReturnTarget,
}: {
  readonly document: DocumentMetadata | null;
  readonly folders: readonly Folder[];
  readonly onClose: () => void;
  /** Resolves `false` when the document was not moved. */
  readonly onSubmit: (documentId: string, folderId: string | null) => Promise<boolean>;
  readonly focusReturnTarget: HTMLElement | null;
}) {
  const { shown: doc, phase } = useModalPresence(subject);
  const [targetFolderId, setTargetFolderId] = useState<string | null>(doc?.folderId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus(subject !== null, onClose, { returnTarget: focusReturnTarget });

  useEffect(() => {
    if (doc) {
      setTargetFolderId(doc.folderId ?? null);
      setError(null);
      setSubmitting(false);
    }
  }, [doc]);

  if (!doc) return null;

  async function handleMove() {
    if (!doc) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(doc.id, targetFolderId);
      if (result) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move document.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Move document to folder"
        tabIndex={-1}
        data-testid="move-document-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-sm rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-text-primary">Move Document to Folder</h2>
        <p className="mt-1 truncate text-xs text-text-secondary">{doc.title}</p>

        <form
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            void handleMove();
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <div>
            <label htmlFor="folder-select" className="block text-xs font-medium text-text-secondary">
              Select Destination Folder
            </label>
            <Select
              id="folder-select"
              data-testid="target-folder-select"
              aria-invalid={error !== null}
              aria-describedby={error ? 'move-document-error' : undefined}
              value={targetFolderId ?? ''}
              options={[{ value: '', label: '(No folder — Root Library)' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
              onValueChange={(value) => { setTargetFolderId(value === '' ? null : value); }}
              size="sm"
              wrapperClassName="mt-1"
            />
          </div>

          {error && <p id="move-document-error" role="alert" className="text-xs text-danger">{error}</p>}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-move-document"
              disabled={submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Moving...' : 'Move'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Delete Document Modal
export function DeleteDocumentModal({
  document: subject,
  onClose,
  onConfirm,
  focusReturnTarget,
}: {
  readonly document: DocumentMetadata | null;
  readonly onClose: () => void;
  /** Resolves `false` when the deletion did not happen. */
  readonly onConfirm: (id: string) => Promise<boolean>;
  readonly focusReturnTarget: HTMLElement | null;
}) {
  const { shown: doc, phase } = useModalPresence(subject);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus(subject !== null, onClose, { returnTarget: focusReturnTarget });

  useEffect(() => {
    if (doc) {
      setError(null);
      setSubmitting(false);
    }
  }, [doc]);

  if (!doc) return null;

  async function handleDelete() {
    if (!doc) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm(doc.id);
      if (result) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div {...phaseAttributes(phase)} className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete document"
        tabIndex={-1}
        data-testid="delete-document-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-sm rounded-xl border border-border-subtle bg-bg-primary p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-text-primary">Delete Document</h2>
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">
          Are you sure you want to remove <span className="font-semibold text-text-primary">'{doc.title}'</span> from your library?
          {doc.storageMode === 'managed'
            ? ' The managed copy will be removed from your library disk storage.'
            : ' Your original file on disk will not be deleted.'}
        </p>

        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-delete-document"
            disabled={submitting}
            onClick={() => {
              void handleDelete();
            }}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-on-danger hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where an imported article came from.
 *
 * The address is the whole of what a reader needs here, and it already names
 * the site. The site name and capture time were restatements of it and of the
 * card's own web badge, so they are not printed: both remain stored on the
 * document's provenance, which is what deduplication, drift detection and the
 * badge read.
 */
function DocumentDetailsWebSource({ doc }: { readonly doc: DocumentMetadata }) {
  if (doc.source?.kind !== 'web') return null;
  return (
    <div className="flex justify-between gap-3">
      <span className="text-text-secondary">Source</span>
      <span
        data-testid="document-details-source-url"
        title={doc.source.url}
        className="max-w-[260px] truncate text-right text-text-primary"
      >
        {doc.source.url}
      </span>
    </div>
  );
}

// Document Details Modal
/**
 * The details dialog's overflow commands.
 *
 * Each one closes the dialog; Move and Delete hand off to their own dialog, so
 * the caller suppresses the focus return before closing. Remove from folder is a
 * move, not a deletion — the document stays in the library — so it needs no
 * confirmation, and it is offered only while the document is in a folder.
 */
function detailsActionItems(input: {
  readonly doc: DocumentMetadata;
  readonly onClose: () => void;
  readonly onMove: () => void;
  readonly onRemoveFromFolder: () => void;
  readonly onDelete: () => void;
}): readonly DetailsActionItem[] {
  const run = (action: () => void) => () => { action(); input.onClose(); };
  const inFolder: readonly DetailsActionItem[] = input.doc.folderId === null ? [] : [{
    id: 'remove-from-folder',
    label: 'Remove from folder',
    testId: 'remove-from-folder-button',
    title: 'Move this document out of its folder; it stays in the library',
    onSelect: run(input.onRemoveFromFolder),
  }];
  return [
    { id: 'move', label: 'Move...', testId: 'document-details-move', onSelect: run(input.onMove) },
    ...inFolder,
    // Still a hand-off to the confirmation dialog, never a deletion.
    { id: 'delete', label: 'Delete', testId: 'document-details-delete', danger: true, onSelect: run(input.onDelete) },
  ];
}

export function DocumentDetailsModal({
  document: subject,
  onClose,
  onOpen,
  onMove,
  onRemoveFromFolder,
  onDelete,
}: {
  readonly document: DocumentMetadata | null;
  readonly onClose: () => void;
  readonly onOpen: (doc: DocumentMetadata) => void;
  readonly onMove: (doc: DocumentMetadata, focusReturnTarget: HTMLElement | null) => void;
  /** Takes the document out of its folder; it stays in the library. */
  readonly onRemoveFromFolder: (doc: DocumentMetadata) => void;
  readonly onDelete: (doc: DocumentMetadata, focusReturnTarget: HTMLElement | null) => void;
}) {
  const { shown: doc, phase } = useModalPresence(subject);
  const transitionRef = useRef(false);
  const returnTargetRef = useRef<HTMLElement | null>(null);
  const dialogRef = useDialogFocus(subject !== null, onClose, {
    returnTargetRef,
    suppressReturnRef: transitionRef,
  });
  if (!doc) return null;

  return (
    <div
      {...phaseAttributes(phase)}
      className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="document-details-backdrop"
      onMouseDown={(event) => {
        // The dialog owns its controls; only a genuine backdrop click closes it.
        if (event.target === event.currentTarget) {
          // Keep the trigger as the browser's focus target while the dialog
          // cleanup restores it. Without this, Chromium can focus the backdrop
          // between mousedown and React's unmount.
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Document details"
        tabIndex={-1}
        data-testid="document-details-modal"
        data-phase={phase}
        className="ui-dialog w-full max-w-md rounded-xl border border-border-subtle bg-bg-primary p-6 shadow-lg"
      >
        <div className="flex items-start justify-between">
          <span className="rounded-md border border-border-subtle bg-bg-surface px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-text-primary">
            {doc.format}
          </span>
          <button
            type="button"
            aria-label="Close document details"
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>

        <h2 id="document-details-title" className="mt-3 text-base font-semibold text-text-primary">{doc.title}</h2>
        <p className="text-xs text-text-secondary">{doc.author ?? 'Unknown author'}</p>

        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-surface p-3 text-xs">
          <div className="flex justify-between">
            <span className="text-text-secondary">Storage Mode</span>
            <span className="font-medium text-text-primary">
              {doc.storageMode === 'managed' ? 'Managed Copy' : 'Link in Place'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">File Size</span>
            <span className="font-medium text-text-primary">{formatFileSize(doc.fileSize)}</span>
          </div>
          {doc.pageCount && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Page Count</span>
              <span className="font-medium text-text-primary">{doc.pageCount}</span>
            </div>
          )}
          <DocumentDetailsWebSource doc={doc} />
          <EstimatedTokensRow documentId={doc.id} documentHash={doc.fileHash} />
          <div className="flex justify-between">
            <span className="text-text-secondary">Storage Health</span>
            <span
              className={`font-medium ${
                doc.storageHealth === 'ok'
                  ? 'text-success'
                  : doc.storageHealth === 'missing'
                  ? 'text-danger'
                  : doc.storageHealth === 'checking'
                  ? 'text-text-secondary'
                  : 'text-warning'
              }`}
            >
              {doc.storageHealth.toUpperCase()}
              {doc.storageHealthMessage ? ` (${doc.storageHealthMessage})` : ''}
            </span>
          </div>
          {/* The content hash is not printed here: it is machine identity, not
            * something a reader acts on, and it stays on the document record
            * where deduplication, drift detection and storage health use it. */}
          {doc.readingPosition && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Reading Progress</span>
              <span className="font-medium text-text-primary">
                {Math.round(doc.readingPosition.progress * 100)}%
              </span>
            </div>
          )}
        </div>

        {/* Read is the one thing most readers open this dialog to do, so it is
          * the only visible command. Move, Remove from folder and Delete are
          * real but occasional, and they used to sit here as four more buttons of
          * the same weight beside a Close that merely restated the header X,
          * Escape and the backdrop. They now share one compact overflow menu. */}
        <div className="mt-5 flex items-center justify-between gap-2 border-t border-border-subtle pt-4">
          <DocumentDetailsActionsMenu
            items={detailsActionItems({
              doc,
              onClose,
              onMove: () => {
                transitionRef.current = true;
                onMove(doc, returnTargetRef.current);
              },
              onRemoveFromFolder: () => { onRemoveFromFolder(doc); },
              onDelete: () => {
                transitionRef.current = true;
                onDelete(doc, returnTargetRef.current);
              },
            })}
          />

          <button
            type="button"
            data-testid="open-reader-button"
            onClick={() => {
              onClose();
              onOpen(doc);
            }}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 shadow-xs"
          >
            Read
          </button>
        </div>
      </div>
    </div>
  );
}
