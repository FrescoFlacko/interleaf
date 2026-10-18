import type { DocumentMetadata } from '@shared/types/document';
import type { DocumentPreviewState } from './DocumentPreview';

/**
 * The full-bleed cover surface of a library card (reference 7a).
 *
 * Only PDFs ever get real page-one artwork, so most documents — every EPUB,
 * DOCX, Markdown file and web-article snapshot — would otherwise show an empty
 * rectangle. They get a generated typographic cover instead: a dark gradient
 * chosen deterministically from the document id, then title-led type built
 * from metadata the library already holds. No document-supplied media is
 * rendered, extracted or executed here; a generated cover is the app's own
 * drawing of text the library already stores.
 */

/**
 * Dark grounds in the reference's family. The gradient is fixed rather than
 * themed: it is the backdrop for the same white scrim that has to sit legibly
 * over arbitrary artwork, so it cannot follow the reading palette. Every entry
 * is dark enough that the eyebrow and attribution below clear AA at their
 * chosen opacities against the lightest stop, which is what bounds how muted
 * the reference's secondary type can safely be.
 */
const COVER_GRADIENTS = [
  'bg-[linear-gradient(160deg,#2c4256_0%,#1a2733_100%)]',
  'bg-[linear-gradient(160deg,#4a4667_0%,#282538_100%)]',
  'bg-[linear-gradient(160deg,#2f4a42_0%,#172a25_100%)]',
  'bg-[linear-gradient(160deg,#4c3b3b_0%,#241c1c_100%)]',
  'bg-[linear-gradient(160deg,#33405c_0%,#1b2136_100%)]',
  'bg-[linear-gradient(160deg,#4a4232_0%,#241f16_100%)]',
] as const;

/**
 * FNV-1a over the document id. A document keeps the same cover for its whole
 * life and across restarts, which is what makes a generated cover usable as a
 * recognition cue rather than decoration.
 */
export function coverGradientClass(documentId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < documentId.length; index += 1) {
    hash ^= documentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length] ?? COVER_GRADIENTS[0];
}

/** Long titles step down instead of overflowing the cover into the scrim. */
function titleTypeClass(title: string): string {
  if (title.length <= 22) return 'text-xl leading-[1.24]';
  if (title.length <= 48) return 'text-lg leading-[1.28]';
  return 'text-base leading-[1.32]';
}

type DocumentCoverProps = {
  readonly document: DocumentMetadata;
  readonly preview: DocumentPreviewState;
};

export function DocumentCover({ document: doc, preview }: DocumentCoverProps) {
  const webSource = doc.source?.kind === 'web' ? doc.source : null;
  const siteName = webSource?.siteName?.trim() ?? '';
  const attribution = siteName.length > 0 ? siteName : doc.author ?? '';

  return (
    <div
      ref={preview.containerRef}
      data-testid={`document-preview-${doc.id}`}
      aria-label={`Preview of ${doc.title} (${preview.locationLabel})`}
      role="group"
      className="absolute inset-0 select-none overflow-hidden bg-bg-surface"
    >
      {preview.coverAssetUrl === null ? (
        <div
          data-testid={`generated-cover-${doc.id}`}
          // The card's aspect is fixed, so width-relative padding reproduces
          // the reference's 24px/18px/78px inset on a 200x300 card at every
          // column width. A height-relative bottom inset is not available:
          // percentage padding always resolves against the inline size.
          className={`flex h-full w-full flex-col gap-2.5 px-[9%] pt-[12%] pb-[39%] ${coverGradientClass(doc.id)}`}
        >
          {webSource !== null && (
            <span className="font-mono text-2xs font-medium uppercase leading-[1.3] tracking-[0.14em] text-white">
              Web article
            </span>
          )}
          <span
            className={`line-clamp-4 font-semibold tracking-[-0.02em] text-white ${titleTypeClass(doc.title)}`}
          >
            {doc.title}
          </span>
          {attribution !== '' && (
            <span className="mt-auto truncate font-mono text-2xs leading-[1.3] text-white">
              {attribution}
            </span>
          )}
        </div>
      ) : (
        <img
          data-testid={`preview-cover-image-${doc.id}`}
          src={preview.coverAssetUrl}
          alt={`Cover of ${doc.title}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-top"
          onLoad={preview.onCoverLoad}
          onError={preview.onCoverError}
        />
      )}
    </div>
  );
}
