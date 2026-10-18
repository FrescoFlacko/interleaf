import { AppIcon, type AppIconName } from '../../../components/AppIcon';
import { useDocumentDropTarget } from '../use-document-drag';

/**
 * One destination in the library rail.
 *
 * All Documents is the library root, so a book dropped on it leaves whichever
 * folder it was in; the other entries are computed views, not places a book can
 * be put, and `acceptsDrop` is false for them, which leaves their drags alone.
 */
export function LibraryNavItem({
  label,
  icon,
  testId,
  isActive,
  acceptsDrop,
  onSelect,
  onDropDocument,
}: {
  readonly label: string;
  readonly icon: AppIconName;
  readonly testId: string;
  readonly isActive: boolean;
  readonly acceptsDrop: boolean;
  readonly onSelect: () => void;
  /** Called with no folder: the book is removed from the one it is in. */
  readonly onDropDocument: (documentId: string, folderId: null) => void;
}) {
  const handler = acceptsDrop ? onDropDocument : undefined;
  const { dropProps, dropClass } = useDocumentDropTarget(handler, null);
  const activeClass = isActive
    ? 'bg-bg-surface font-semibold text-text-primary'
    : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary';

  return (
    <button
      type="button"
      data-testid={testId}
      {...dropProps}
      onClick={onSelect}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${activeClass} ${dropClass}`}
    >
      <AppIcon name={icon} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}
