import type { DocumentSource } from '@shared/types/document';

/**
 * The provenance badge for a document captured from the web, as it appears in
 * the list view and other themed surfaces. The grid card no longer shows it:
 * the cover-first card leaves provenance to the generated cover's own
 * attribution line, so there is no overlay presentation to maintain.
 *
 * A page names itself, so the site name arrives at whatever length the
 * publisher chose. The badge therefore keeps a fixed pixel cap and truncates,
 * which bounds the badge's intrinsic width as well as its painted one: a
 * percentage cap here would be unresolvable while a flex parent measures its
 * max-content size, and the row around it would grow with the name instead.
 * The full name stays in the tooltip and the accessible text.
 */

type DocumentSourceBadgeProps = {
  readonly source: DocumentSource | null | undefined;
  readonly docId: string;
};

export function DocumentSourceBadge({ source, docId }: DocumentSourceBadgeProps) {
  if (source?.kind !== 'web') return null;
  const trimmed = source.siteName?.trim();
  const rawSite = trimmed !== undefined && trimmed.length > 0 ? trimmed : 'the web';
  const siteName = rawSite.length > 80 ? `${rawSite.slice(0, 79)}…` : rawSite;
  const label = trimmed !== undefined && trimmed.length > 0 ? trimmed : 'Web';

  return (
    <span
      data-testid={`source-badge-${docId}`}
      className="inline-block min-w-0 max-w-[140px] shrink truncate rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent"
      title={`Web snapshot from ${siteName}`}
    >
      {label}
    </span>
  );
}
