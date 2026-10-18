import type { DocumentMetadata } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';
import { Button } from '../../../components/ui/button';
import { useDocumentDragSource } from '../use-document-drag';
import { DocumentCover } from './DocumentCover';
import { useDocumentPreview } from './DocumentPreview';

/**
 * The library grid card (reference 7a): the cover is the card. A full-bleed
 * 2:3 surface carries the artwork or its generated stand-in, the title and
 * author sit on a scrim at the bottom, the ellipsis sits over the artwork, and
 * reading progress is a hairline on the bottom edge that carries its own
 * progressbar semantics instead of a second, visible percentage.
 */

type DocumentCardProps = {
  readonly document: DocumentMetadata;
  /** Opens the document in the reader from the primary card surface. */
  readonly onOpen: (document: DocumentMetadata) => void;
  /** Opens the details/actions surface from the ellipsis button. */
  readonly onDetails: (document: DocumentMetadata) => void;
};

/** Shared chrome for the status chips that sit over the artwork. */
const STATUS_CHIP = 'rounded-md px-1.5 py-0.5 text-2xs font-medium';

function storageHealthChip(doc: DocumentMetadata) {
  switch (doc.storageHealth) {
    case 'missing':
      return {
        text: 'Missing',
        title: doc.storageHealthMessage ?? 'File missing from original path',
        className: `${STATUS_CHIP} border border-danger/40 bg-bg-primary/90 text-danger`,
      };
    case 'changed':
      return {
        text: 'Changed',
        title: doc.storageHealthMessage ?? 'File changed on disk',
        className: `${STATUS_CHIP} border border-warning/40 bg-bg-primary/90 text-warning`,
      };
    case 'checking':
      return {
        text: 'Checking...',
        title: doc.storageHealthMessage ?? 'Checking storage health...',
        className: `${STATUS_CHIP} border border-border-subtle bg-bg-primary/90 text-text-secondary`,
      };
    default:
      return null;
  }
}

export function DocumentCard({
  document: doc,
  onOpen,
  onDetails,
}: DocumentCardProps) {
  const preview = useDocumentPreview(doc);
  // The card is the drag handle for its own book. The payload is the document
  // id alone (see `document-drag.ts`); the folder rail decides what a drop
  // means, and the hook also swallows the click a finished drag can deliver.
  const { dragProps, dragClass } = useDocumentDragSource(doc.id);
  const progressPercent = doc.readingPosition ? Math.round(doc.readingPosition.progress * 100) : 0;
  const hasStartedReading = Boolean(doc.readingPosition && doc.readingPosition.progress > 0);
  const author = doc.author ?? 'Unknown author';
  const healthChip = storageHealthChip(doc);
  const isLinked = doc.storageMode === 'link';
  const hasStatusRow = healthChip !== null || isLinked;

  return (
    <div
      data-testid={`document-card-${doc.id}`}
      {...dragProps}
      // `ml-card-hover` (global.css) owns the resting ring and shadow and their
      // hover-gated change; the card itself never moves.
      className={`group ml-card-hover relative aspect-2/3 w-full cursor-pointer overflow-hidden rounded-lg bg-bg-surface ${dragClass}`}
      onClick={(event) => {
        // The card is a pointer affordance, while every nested button remains an
        // independent action. The primary content button owns its own activation.
        if (event.target instanceof Element && event.target.closest('button')) return;
        onOpen(doc);
      }}
    >
      <DocumentCover document={doc} preview={preview} />

      {/* Storage and provenance stay available without competing with the
          artwork: one chip row at the top, over a short scrim so a light chip
          reads against a dark cover and a dark one against a pale page. */}
      {hasStatusRow && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-end gap-1.5 bg-linear-to-b from-black/30 to-transparent px-2.5 pb-6 pt-2.5">
          {isLinked && (
            <span
              data-testid={`storage-mode-${doc.id}`}
              className={`${STATUS_CHIP} border border-border-subtle bg-bg-primary/90 text-text-secondary`}
              title="Link in Place"
            >
              Linked
            </span>
          )}
          {healthChip && (
            <span
              data-testid={`health-badge-${doc.id}`}
              className={healthChip.className}
              title={healthChip.title}
            >
              <AppIcon name="warning" size={10} className="mr-0.5 inline-block align-[-1px]" />
              {healthChip.text}
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        data-testid={`read-doc-${doc.id}`}
        aria-label={`Open ${doc.title}`}
        onClick={() => { onOpen(doc); }}
        // The open surface covers the whole cover, so its focus indicator is
        // drawn on artwork the app does not control. Two inset bands — white
        // outermost, near-black just inside — guarantee that one of them
        // contrasts with any image. Neither paints unless the button is
        // focused, so the unfocused card keeps the reference's clean edge.
        className="absolute inset-0 z-10 flex w-full flex-col justify-end text-left focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_3px_#ffffff,inset_0_0_0_6px_rgba(10,10,12,0.92)]"
      >
        <span className="flex w-full min-w-0 flex-col gap-1.5 bg-linear-to-b from-transparent via-[rgba(10,10,12,0.72)] to-[rgba(10,10,12,0.92)] px-3 pb-3 pt-8">
          {/* Where you are in the document is the one chip the cover keeps. A
              web article still names its site in the generated cover's own
              attribution line; the grid does not repeat it as a badge. */}
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              data-testid={`preview-location-badge-${doc.id}`}
              className="min-w-0 truncate rounded-md bg-white/16 px-2 py-0.5 font-mono text-2xs font-medium uppercase leading-[1.3] text-white"
            >
              {preview.locationLabel}
            </span>
          </span>
          {/* The right padding is the ellipsis button's reserved lane, so a long
              title truncates beside it rather than running underneath it. */}
          <span className="flex min-w-0 flex-col gap-1 pr-9">
            {/* The title is the card's heading, but it lives inside the open
                button, where an <h2> would be invalid nesting. ARIA carries the
                level so the library still exposes a heading per document. */}
            <span
              data-testid={`document-title-${doc.id}`}
              role="heading"
              aria-level={2}
              className="truncate text-sm font-semibold leading-[1.3] text-white"
              title={doc.title}
            >
              {doc.title}
            </span>
            <span
              data-testid={`document-meta-${doc.id}`}
              className="truncate text-2xs leading-[1.3] text-white"
              title={author}
            >
              {/* Author alone: file size is a details-and-list-view fact, and
                  on the cover it competed with the title for the one line the
                  scrim has. */}
              <span data-testid={`document-author-${doc.id}`}>{author}</span>
            </span>
          </span>
        </span>
      </button>

      <Button
        variant="overlay"
        size="icon"
        data-testid={`document-menu-${doc.id}`}
        aria-haspopup="dialog"
        aria-label={`More actions for ${doc.title}`}
        title="More document actions"
        onClick={(event) => {
          event.stopPropagation();
          onDetails(doc);
        }}
        className="absolute bottom-3 right-3 z-20"
      >
        <AppIcon name="more-horizontal" size={16} />
      </Button>

      {/* The hairline is the only reading-progress element left on the card, so
          it carries the value itself rather than duplicating a visible
          percentage on the scrim. */}
      {hasStartedReading && (
        <div
          data-testid={`reading-progress-track-${doc.id}`}
          role="progressbar"
          aria-label={`Reading progress for ${doc.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-valuetext={`${String(progressPercent)}% read`}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[3px] bg-white/22"
        >
          <div
            data-testid={`reading-progress-bar-${doc.id}`}
            className="h-full bg-white"
            style={{ width: `${String(progressPercent)}%` }}
          />
        </div>
      )}
    </div>
  );
}
