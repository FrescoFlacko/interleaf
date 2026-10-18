import type { DocumentMetadata } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';
import { DocumentSourceBadge } from './DocumentSourceBadge';
import { formatBadgeClass, formatFileSize } from '../document-format';

type DocumentListItemProps = {
  readonly document: DocumentMetadata;
  readonly onOpen: (document: DocumentMetadata) => void;
  readonly onDetails: (document: DocumentMetadata) => void;
};

export function DocumentListItem({ document: doc, onOpen, onDetails }: DocumentListItemProps) {
  const progressPercent = doc.readingPosition ? Math.round(doc.readingPosition.progress * 100) : 0;

  return (
    <div
      data-testid={`document-row-${doc.id}`}
      className="group flex cursor-pointer items-center justify-between gap-4 border-b border-border-subtle/60 px-3 py-2.5 text-xs transition-colors hover:bg-bg-surface"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) return;
        onOpen(doc);
      }}
    >
      <button
        type="button"
        data-testid={`read-row-doc-${doc.id}`}
        aria-label={`Open ${doc.title}`}
        onClick={() => { onOpen(doc); }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${formatBadgeClass(
            doc.format
          )}`}
        >
          {doc.format}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-text-primary" title={doc.title}>
            {doc.title}
          </p>
          <p className="truncate text-2xs text-text-secondary">
            {doc.author ?? 'Unknown author'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-6 text-text-secondary">
          <div className="flex items-center gap-2">
            <DocumentSourceBadge source={doc.source} docId={doc.id} />
            {doc.storageMode === 'link' && (
              <span className="rounded-md border border-border-subtle bg-bg-primary px-1.5 py-0.5 text-2xs">
                Linked
              </span>
            )}
            {doc.storageHealth === 'missing' && (
              <span className="rounded-md border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-2xs font-medium text-danger">
                Missing
              </span>
            )}
            {doc.storageHealth === 'changed' && (
              <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-2xs font-medium text-warning">
                Changed
              </span>
            )}
            {doc.storageHealth === 'checking' && (
              <span className="rounded-md border border-border-subtle bg-bg-surface px-1.5 py-0.5 text-2xs text-text-secondary">
                Checking...
              </span>
            )}
          </div>

          <div className="w-24 text-right">
            {doc.readingPosition && doc.readingPosition.progress > 0 ? (
              <span className="font-medium text-text-primary">{progressPercent}%</span>
            ) : (
              <span className="text-text-secondary">—</span>
            )}
          </div>

          <div className="w-20 text-right">{formatFileSize(doc.fileSize)}</div>

          <div className="w-24 text-right">
            {new Date(doc.createdAt).toLocaleDateString()}
          </div>
        </div>
      </button>

      <button
        type="button"
        data-testid={`document-menu-${doc.id}`}
        aria-haspopup="dialog"
        aria-label={`More actions for ${doc.title}`}
        title="More document actions"
        onClick={(event) => {
          event.stopPropagation();
          onDetails(doc);
        }}
        className="shrink-0 rounded-sm p-1 text-sm font-semibold text-text-secondary hover:bg-border-subtle hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-accent"
      >
        <AppIcon name="more-horizontal" size={14} />
      </button>
    </div>
  );
}
