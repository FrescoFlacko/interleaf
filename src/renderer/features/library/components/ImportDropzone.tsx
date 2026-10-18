import { useState, useRef } from 'react';
import type { StorageMode } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';

type ImportDropzoneProps = {
  readonly isImporting: boolean;
  readonly defaultStorageMode?: StorageMode;
  readonly onImportDroppedFiles: (files: readonly File[], storageMode: StorageMode) => void;
  readonly onOpenFileDialog: (storageMode: StorageMode) => void;
  /** Opens the URL dialog. */
  readonly onImportFromWeb: () => void;
};

function ImportDropzoneWebAction({
  onImportFromWeb,
}: {
  readonly onImportFromWeb: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="dropzone-import-web-button"
      onClick={onImportFromWeb}
      className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent rounded-sm px-1 py-0.5"
    >
      <AppIcon name="import-from-web" size={13} />
      <span>or import from web URL</span>
    </button>
  );
}

export function ImportDropzone({
  isImporting,
  defaultStorageMode = 'managed',
  onImportDroppedFiles,
  onOpenFileDialog,
  onImportFromWeb,
}: ImportDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>(defaultStorageMode);
  const dropRef = useRef<HTMLDivElement>(null);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current && !dropRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      onImportDroppedFiles(files, storageMode);
    }
  }

  return (
    <div
      ref={dropRef}
      data-testid="import-dropzone"
      aria-label="Add books to your library"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
        isDragOver
          ? 'border-accent bg-accent/5'
          : 'border-border-subtle bg-bg-surface/50 hover:border-border-strong hover:bg-bg-surface'
      }`}
    >
      <div className="flex max-w-md flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border-subtle bg-bg-primary text-xl shadow-xs">
          {/* The heading beside this circle already says which state the zone
            * is in, so the glyph is decorative in both. */}
          {isImporting ? (
            <AppIcon name="busy" size={22} className="animate-spin text-accent motion-reduce:animate-none" />
          ) : (
            <AppIcon name="library-empty" size={22} className="text-text-secondary" />
          )}
        </div>

        <div className="flex flex-col">
          <h2 className="text-sm font-semibold text-text-primary">
            {isImporting ? 'Importing documents...' : 'Add books to your library'}
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            Drag and drop files here, or click to browse. Supports PDF, EPUB, MOBI/AZW3, DOCX, and Markdown.
          </p>
        </div>

        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            data-testid="select-files-button"
            disabled={isImporting}
            onClick={() => {
              onOpenFileDialog(storageMode);
            }}
            className="rounded-md bg-accent px-4 py-2 text-xs font-medium text-on-accent shadow-xs hover:opacity-90 disabled:opacity-50"
          >
            Select Documents...
          </button>
        </div>
        <ImportDropzoneWebAction onImportFromWeb={onImportFromWeb} />

        <div className="mt-2 flex items-center gap-3 rounded-md border border-border-subtle bg-bg-primary px-3 py-1.5 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">Storage mode:</span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="storageMode"
              value="managed"
              checked={storageMode === 'managed'}
              onChange={() => {
                setStorageMode('managed');
              }}
            />
            <span>Managed Copy (Default)</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="storageMode"
              value="link"
              checked={storageMode === 'link'}
              onChange={() => {
                setStorageMode('link');
              }}
            />
            <span>Link in Place</span>
          </label>
        </div>
      </div>
    </div>
  );
}
