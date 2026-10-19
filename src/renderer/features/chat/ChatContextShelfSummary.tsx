import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ChatContextItem } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import type { SlidePhase } from '../../components/slide-presence';
import { useShelfPopover, useShelfPopoverState } from './use-shelf-popover';

type ChatContextShelfSummaryProps = {
  /** At least one item, in shelf order: the whole document first. */
  readonly items: readonly ChatContextItem[];
  /** An archived conversation shows what it read but offers no removal. */
  readonly canRemove: boolean;
  readonly disabled: boolean;
  readonly addContextRef: RefObject<HTMLButtonElement | null>;
  readonly removeContext: (contextItemId: string) => Promise<void>;
};

const POPOVER_ID = 'chat-context-manage';

function itemCountLabel(count: number): string {
  return count === 1 ? '1 item' : `${String(count)} items`;
}

/**
 * Once a removal has landed, focus stays on a surviving control: the remove
 * button now in the removed one's place, the one before it, or — after the
 * last item — the composer's Add button. A removal that failed leaves its own
 * button in place and focused, so nothing moves.
 */
function keepFocusAfterRemoval(index: number, addContextRef: RefObject<HTMLButtonElement | null>): void {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const survivors = [...document.querySelectorAll<HTMLElement>(`#${POPOVER_ID} [data-context-remove]`)];
    (survivors[Math.min(index, survivors.length - 1)] ?? addContextRef.current)?.focus();
  }, 0);
}

/**
 * The shelf's summary — `Context`, the first attachment's label and `+N` for
 * the rest — and the anchored list it opens, where every attachment is shown
 * whole and can be removed.
 */
export function ChatContextShelfSummary(props: ChatContextShelfSummaryProps) {
  const { items } = props;
  const popover = useShelfPopoverState();
  const presence = usePopoverPresence(popover.open);
  const first = items[0];
  if (first === undefined) return null;
  const more = items.length - 1;

  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        data-testid="chat-context-summary"
        aria-label={`Context, ${itemCountLabel(items.length)}: ${first.displayLabel}`}
        title={first.displayLabel}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? POPOVER_ID : undefined}
        onClick={popover.toggle}
        className="chat-context-shelf-summary"
      >
        <span aria-hidden="true" className="chat-context-shelf-kicker">Context</span>
        <span aria-hidden="true" data-kind={first.kind} className="chat-context-shelf-label">{first.displayLabel}</span>
        {more > 0 && <span aria-hidden="true" className="chat-context-shelf-count">+{String(more)}</span>}
        <AppIcon name="menu-caret" size={12} className="chat-context-shelf-caret" />
      </button>
      {presence.present && (
        <ManageContextPopover {...props} phase={presence.phase} triggerRef={popover.triggerRef} onClose={popover.close} />
      )}
    </>
  );
}

function ManageContextPopover({
  items,
  canRemove,
  disabled,
  addContextRef,
  removeContext,
  phase,
  triggerRef,
  onClose,
}: ChatContextShelfSummaryProps & {
  readonly phase: SlidePhase;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorStyle = useAnchoredPosition(triggerRef, popoverRef, 'top');
  const handleKeyDown = useShelfPopover({ popoverRef, triggerRef, leaving: phase === 'exiting', onClose });

  const remove = async (item: ChatContextItem, index: number): Promise<void> => {
    await removeContext(item.id);
    keepFocusAfterRemoval(index, addContextRef);
  };

  return createPortal(
    <div
      ref={popoverRef}
      {...phaseAttributes(phase)}
      id={POPOVER_ID}
      data-testid="chat-context-manage"
      role="dialog"
      aria-labelledby="chat-context-manage-title"
      onKeyDown={handleKeyDown}
      style={anchorStyle}
      className="ui-popover chat-design-popover chat-context-manage"
    >
      <h3 id="chat-context-manage-title" className="text-xs font-semibold text-text-primary">
        AI context · {itemCountLabel(items.length)}
      </h3>
      <ul data-testid="chat-context-list" aria-label="Pinned AI context items" className="chat-context-manage-list">
        {items.map((item, index) => (
          <li key={item.id} data-kind={item.kind} className="chat-context-manage-item">
            <span title={item.displayLabel} className="chat-context-manage-label">{item.displayLabel}</span>
            {canRemove && (
              <button
                type="button"
                data-context-remove=""
                aria-label={`Remove ${item.displayLabel} from AI context`}
                title={`Remove ${item.displayLabel}`}
                disabled={disabled}
                onClick={() => { void remove(item, index); }}
              >
                <AppIcon name="close" size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="chat-context-close" onClick={() => { onClose(); }}>Close</button>
    </div>,
    document.body
  );
}
