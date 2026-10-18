import { useState } from 'react';
import type { FolderTree, Folder } from '@shared/types/document';
import { AppIcon } from '../../../components/AppIcon';
import { useDocumentDropTarget } from '../use-document-drag';

type FolderTreeItemProps = {
  readonly node: FolderTree;
  readonly depth?: number;
  readonly selectedFolderId: string | null;
  readonly onSelect: (folderId: string) => void;
  readonly onNewSubfolder: (parentFolderId: string) => void;
  readonly onRename: (folder: Folder) => void;
  readonly onDelete: (folder: Folder) => void;
  /** Accepts a book dropped on this folder. */
  readonly onDropDocument: (documentId: string, folderId: string) => void;
};

export function FolderTreeItem({
  node,
  depth = 0,
  selectedFolderId,
  onSelect,
  onNewSubfolder,
  onRename,
  onDelete,
  onDropDocument,
}: FolderTreeItemProps) {
  const [expanded, setExpanded] = useState(true);
  const { dropProps, dropClass } = useDocumentDropTarget(onDropDocument, node.id);
  const isSelected = selectedFolderId === node.id;
  const hasChildren = node.children.length > 0;
  const childListId = `folder-children-${node.id}`;

  return (
    <li className="flex flex-col select-none">
      <div
        data-testid={`folder-drop-target-${node.id}`}
        {...dropProps}
        className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
          isSelected
            ? 'bg-bg-surface font-semibold text-text-primary'
            : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
        } ${dropClass}`}
        style={{ paddingLeft: `${String(depth * 12 + 8)}px` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
              aria-expanded={expanded}
              aria-controls={childListId}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-text-secondary hover:text-text-primary"
            >
              <AppIcon name={expanded ? 'disclosure-expanded' : 'disclosure-collapsed'} size={12} />
            </button>
          ) : (
            <span className="h-4 w-4 shrink-0" />
          )}

          <button
            type="button"
            data-testid={`folder-item-${node.id}`}
            aria-current={isSelected ? 'page' : undefined}
            onClick={() => {
              onSelect(node.id);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left focus:outline-hidden focus-visible:ring-1 focus-visible:ring-accent rounded-sm"
          >
            <AppIcon name="folder" size={13} className="shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        <div className="flex items-center gap-1">
          {node.documentCount > 0 && (
            <span
              data-testid={`folder-count-${node.id}`}
              className="rounded-full bg-border-subtle px-1.5 py-0.2 text-2xs text-text-secondary group-hover:hidden group-focus-within:hidden"
            >
              {node.documentCount}
            </span>
          )}

          <div className="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
            <button
              type="button"
              title="New Subfolder"
              aria-label={`Add subfolder to ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onNewSubfolder(node.id);
              }}
              className="rounded-sm p-0.5 text-text-secondary hover:bg-border-subtle hover:text-text-primary"
            >
              <AppIcon name="folder-add" size={13} />
            </button>
            <button
              type="button"
              title="Rename Folder"
              aria-label={`Rename ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRename(node);
              }}
              className="rounded-sm p-0.5 text-text-secondary hover:bg-border-subtle hover:text-text-primary"
            >
              <AppIcon name="rename" size={13} />
            </button>
            <button
              type="button"
              title="Delete Folder"
              aria-label={`Delete ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node);
              }}
              className="rounded-sm p-0.5 text-danger hover:bg-border-subtle"
            >
              <AppIcon name="delete" size={13} />
            </button>
          </div>
        </div>
      </div>

      {hasChildren && expanded && (
        <ul id={childListId} aria-label={`Subfolders of ${node.name}`} className="flex flex-col">
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onNewSubfolder={onNewSubfolder}
              onRename={onRename}
              onDelete={onDelete}
              onDropDocument={onDropDocument}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
