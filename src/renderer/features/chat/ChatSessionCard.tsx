import { useRef, useState, type SyntheticEvent } from 'react';
import type { ChatSession } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { CompanionCardBody } from '../../components/companion/CompanionCard';
import { ChatMenu, type ChatMenuItem } from './ChatMenu';
import { sessionMetaLine } from './session-labels';

/** Which inline editor, if any, this card is currently showing. */
export type SessionCardMode = 'idle' | 'rename' | 'delete';

type ChatSessionCardProps = {
  readonly session: ChatSession;
  readonly isCurrent: boolean;
  /** Real provider/model binding of this conversation, already resolved. */
  readonly bindingLabel: string;
  /**
   * Model half of the binding: the chip in reference 2b names only the model.
   * `null` when the conversation is on the provider's own default, which the
   * chip would only restate, so the card omits it.
   */
  readonly modelChipLabel: string | null;
  /** `null` while provider discovery is still running: unknown, not unavailable. */
  readonly providerReady: boolean | null;
  readonly isStreaming: boolean;
  /**
   * Whether this conversation is being compacted right now. Main refuses to
   * rename or delete a session while its `Clean Context` runs, so the card does
   * not offer either — and it is per conversation, so cleaning one card never
   * disables another.
   */
  readonly isCleaning: boolean;
  readonly mode: SessionCardMode;
  readonly renameDraft: string;
  readonly onOpen: () => void;
  readonly onRenameDraftChange: (value: string) => void;
  readonly onStartRename: () => void;
  readonly onCancelRename: () => void;
  readonly onSubmitRename: (event: SyntheticEvent) => void;
  readonly onStartDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: () => void;
};

/**
 * One conversation card from reference 2b: state dot, title, real message
 * preview, provider/model chip and update time, with the actions that belong to
 * this conversation. The current card carries them inline; any other card
 * exposes them through its overflow menu.
 */
export function ChatSessionCard(props: ChatSessionCardProps) {
  const { session, isCurrent, mode } = props;
  return (
    <li
      data-testid={`session-card-${session.id}`}
      data-current={isCurrent ? 'true' : 'false'}
      aria-current={isCurrent ? 'true' : undefined}
      className="companion-card chat-design-card"
    >
      <CompanionCardBody>
        {mode === 'rename' ? <RenameForm {...props} /> : <CardTitleRow {...props} />}
        <p className="chat-design-card-preview">
          {session.previewText ?? 'No messages yet.'}
        </p>
        <div className="chat-design-card-meta">
          {props.modelChipLabel !== null && (
            <span
              data-testid={`session-binding-${session.id}`}
              className="chat-design-card-chip"
              title={props.bindingLabel}
            >
              {props.modelChipLabel}
            </span>
          )}
          {/* The chip names the model, as 2b does; the provider it is bound to
              stays available to assistive technology and on hover. */}
          <span data-testid={`session-provider-${session.id}`} className="sr-only">
            {props.bindingLabel}
          </span>
          <span data-testid={`session-meta-${session.id}`} className="chat-design-card-metatext">
            {sessionMetaLine({
              messageCount: session.messageCount,
              updatedAt: session.updatedAt,
              isArchived: session.isArchived,
              providerReady: props.providerReady,
              now: new Date(),
            })}
          </span>
        </div>
      </CompanionCardBody>
      {mode === 'delete' && <DeleteConfirmation {...props} />}
      {mode !== 'delete' && isCurrent && <CurrentCardActions {...props} />}
      {/* Every card surface opens its conversation, the current one included:
          the card is the target, and the per-card controls that sit above it
          (overflow menu, footer actions, inline editors) keep their own
          behaviour. The overlay is a real button, so it is reachable and
          operable from the keyboard, and it is a sibling of those controls
          rather than their ancestor, so no interactive element is nested. */}
      {mode === 'idle' && (
        <button
          type="button"
          data-testid={`open-session-${session.id}`}
          aria-label={`Open ${session.title}`}
          onClick={props.onOpen}
          className="chat-design-card-open"
        />
      )}
    </li>
  );
}

function CardTitleRow({ session, isCurrent, isStreaming, isCleaning, onStartRename, onStartDelete }: ChatSessionCardProps) {
  return (
    <div className="chat-design-card-title-row">
      <span aria-hidden="true" className="chat-design-card-dot" />
      <span className="chat-design-card-title" title={session.title}>{session.title}</span>
      {isCurrent ? (
        <span className="chat-design-card-current">CURRENT</span>
      ) : (
        <CardOverflowMenu
          session={session}
          isStreaming={isStreaming || isCleaning}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
        />
      )}
    </div>
  );
}

function CardOverflowMenu({
  session,
  isStreaming,
  onStartRename,
  onStartDelete,
}: {
  readonly session: ChatSession;
  readonly isStreaming: boolean;
  readonly onStartRename: () => void;
  readonly onStartDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) window.queueMicrotask(() => { triggerRef.current?.focus(); });
  };
  const menuId = `session-menu-${session.id}`;
  const items: readonly ChatMenuItem[] = [
    {
      id: 'rename',
      label: 'Rename',
      kind: 'action',
      testId: `rename-session-${session.id}`,
      onSelect: () => { close(false); onStartRename(); },
    },
    {
      id: 'delete',
      label: 'Delete',
      kind: 'action',
      tone: 'danger',
      testId: `delete-session-${session.id}`,
      onSelect: () => { close(false); onStartDelete(); },
    },
  ];
  return (
    <span className="chat-design-card-overflow-wrap">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`session-actions-${session.id}`}
        aria-label={`Actions for ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={isStreaming}
        onClick={() => { setOpen(!open); }}
        className="chat-design-card-overflow focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-40"
      >
        <AppIcon name="more-horizontal" size={14} />
      </button>
      <ChatMenu
        open={open}
        id={menuId}
        label={`Actions for ${session.title}`}
        items={items}
        placement="bottom"
        triggerRef={triggerRef}
        onDismiss={close}
      />
    </span>
  );
}

function CurrentCardActions({ isStreaming, isCleaning, onOpen, onStartRename, onStartDelete }: ChatSessionCardProps) {
  return (
    <div className="chat-design-card-footer">
      <button type="button" data-testid="resume-chat-session" onClick={onOpen} className="chat-design-resume">
        Resume <AppIcon name="forward" size={12} />
      </button>
      <button
        type="button"
        data-testid="rename-chat-session"
        disabled={isCleaning}
        onClick={onStartRename}
        className="chat-design-rename disabled:opacity-40"
      >
        Rename
      </button>
      <button
        type="button"
        data-testid="delete-chat-session"
        disabled={isStreaming || isCleaning}
        onClick={onStartDelete}
        className="chat-design-delete disabled:opacity-40"
      >
        Delete
      </button>
    </div>
  );
}

function RenameForm({ renameDraft, onRenameDraftChange, onSubmitRename, onCancelRename }: ChatSessionCardProps) {
  return (
    <form onSubmit={onSubmitRename} className="flex items-center gap-2">
      <input
        type="text"
        aria-label="Edit chat session title"
        value={renameDraft}
        onChange={(event) => { onRenameDraftChange(event.target.value); }}
        autoFocus
        className="min-w-0 flex-1 rounded border border-border-subtle bg-bg-primary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      />
      <button
        type="submit"
        disabled={!renameDraft.trim()}
        className="shrink-0 rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancelRename}
        className="shrink-0 rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary"
      >
        Cancel
      </button>
    </form>
  );
}

function DeleteConfirmation({ onConfirmDelete, onCancelDelete }: ChatSessionCardProps) {
  return (
    <div
      data-testid="delete-session-confirmation"
      className="flex items-center justify-between gap-2 border-t border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger"
    >
      <span className="truncate font-medium">Delete this conversation?</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="confirm-delete-session"
          aria-label="Confirm delete conversation"
          onClick={onConfirmDelete}
          className="rounded bg-danger px-2 py-0.5 text-xs font-medium text-on-danger hover:opacity-90"
        >
          Delete
        </button>
        <button
          type="button"
          data-testid="cancel-delete-session"
          aria-label="Cancel delete conversation"
          onClick={onCancelDelete}
          className="rounded border border-border-subtle bg-bg-surface px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
