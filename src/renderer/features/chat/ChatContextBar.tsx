import type { ChatContextItem, ChatSession } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { AppIcon } from '../../components/AppIcon';
import { ChatContextMenu } from './ChatContextMenu';
import { ChatWholeDocumentButton } from './ChatWholeDocumentButton';
import { defaultLocation } from './chat-labels';

type ChatContextBarProps = {
  readonly activeDocument: DocumentMetadata;
  readonly currentPage: number;
  readonly explicitLocation: DocumentLocation | null;
  readonly activeSession: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  /** A running clean, a stream or an archived session withholds every context change. */
  readonly disabled: boolean;
  readonly addEntireDocument: (document: DocumentMetadata, location: DocumentLocation) => Promise<boolean>;
  readonly addPageRange: (document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>;
  readonly removeContext: (contextItemId: string) => Promise<void>;
};

function itemCountLabel(count: number): string {
  return count === 1 ? '1 item' : `${String(count)} items`;
}

/**
 * What the next turn reads, above the field: the `@ Add context` pill and the
 * count, then wrapping removable chips ending with the whole-document toggle.
 */
export function ChatContextBar({
  activeDocument,
  currentPage,
  explicitLocation,
  activeSession,
  contextItems,
  disabled,
  addEntireDocument,
  addPageRange,
  removeContext,
}: ChatContextBarProps) {
  return (
    <section aria-label="AI context" data-testid="chat-context-bar" data-context-layout="wrapping-chips" className="chat-design-context">
      <div data-testid="chat-context-summary" className="chat-design-context-summary">
        <ChatContextMenu activeDocument={activeDocument} currentPage={currentPage} disabled={disabled} addPageRange={addPageRange} />
        <span>Context · {itemCountLabel(contextItems.length)}</span>
      </div>
      <div data-testid="chat-context-list" data-context-list-layout="wrapping-chips" aria-label="Pinned AI context items" className="chat-design-chips">
        {/* The whole document is represented once, by the toggle below. A chip
          * for it would be the same attachment a second time, with a second way
          * to remove it. */}
        {contextItems.filter((item) => item.kind !== 'entire_document').map((item) => (
          <span key={item.id} data-kind={item.kind} className="chat-design-chip">
            <span title={item.displayLabel}>{item.displayLabel}</span>
            {!activeSession?.isArchived && (
              <button
                type="button"
                aria-label={`Remove ${item.displayLabel} from AI context`}
                title={`Remove ${item.displayLabel}`}
                disabled={disabled}
                onClick={() => { void removeContext(item.id); }}
              >
                <AppIcon name="close" size={12} />
              </button>
            )}
          </span>
        ))}
        <ChatWholeDocumentButton
          contextItems={contextItems}
          disabled={disabled}
          onAdd={() => {
            void addEntireDocument(activeDocument, explicitLocation ?? defaultLocation(activeDocument.format, currentPage));
          }}
          onRemove={(contextItemId) => { void removeContext(contextItemId); }}
        />
      </div>
    </section>
  );
}
