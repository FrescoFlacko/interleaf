import type { ChatContextItem } from '@shared/types/ai';
import { WholeDocumentChip } from '../../components/companion/WholeDocumentChip';

type ChatWholeDocumentButtonProps = {
  readonly contextItems: readonly ChatContextItem[];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (contextItemId: string) => void;
};

/**
 * The one control that says whether the whole document is attached.
 *
 * The attachment used to be shown twice — as a removable chip and again as a
 * checked button — so the same fact appeared in two places and only one of them
 * could undo it. It is a single state of the session, so it gets a single
 * toggle: pressing it attaches the document, pressing it again removes the
 * stored item by its own id.
 *
 * Main remains the authority. This control reports the attachment main holds
 * and asks main to change it; it never decides the outcome itself.
 */
export function ChatWholeDocumentButton({
  contextItems,
  disabled,
  onAdd,
  onRemove,
}: ChatWholeDocumentButtonProps) {
  const attached = contextItems.find((item) => item.kind === 'entire_document');
  const isAttached = attached !== undefined;
  return (
    <WholeDocumentChip
      attached={isAttached}
      data-testid="chat-whole-document-toggle"
      aria-label="Entire document"
      aria-pressed={isAttached}
      title={
        isAttached
          ? 'The entire document is in AI context. Select to remove it.'
          : 'Add the entire document to AI context.'
      }
      disabled={disabled}
      onClick={() => {
        if (attached !== undefined) {
          onRemove(attached.id);
          return;
        }
        onAdd();
      }}
    />
  );
}
