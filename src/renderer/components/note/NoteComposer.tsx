import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { AppIcon, type AppIconName } from '../AppIcon';
import { Button } from '../ui/button';
import { useReaderStore } from '../../stores/use-reader-store';
import { NOTE_DONE_SHORTCUT_HINT, handleNoteSaveShortcut } from '../../hooks/note-save-shortcut';
import type { NoteAutosaveOptions, NoteSaveStatus } from '../../hooks/note-autosave';
import { useNoteAutosave } from '../../hooks/use-note-autosave';
import './note-composer.css';

/**
 * Why the composer closed. `done` is the explicit commit (button or
 * Cmd/Ctrl+Enter); `escape` and `close` are keyboard and close-icon dismissals;
 * `outside` is a click elsewhere, which must not move focus; `discard` gives up
 * unsaved text after a failure; `request` is the owner closing it (its toggle).
 */
export type NoteComposerCloseReason = 'done' | 'escape' | 'close' | 'outside' | 'discard' | 'request';

export type NoteComposerClose = {
  readonly reason: NoteComposerCloseReason;
  /** The annotation this session created or updated, if any write happened or it already existed. */
  readonly annotationId: string | null;
};

export type NoteComposerHandle = {
  /**
   * Writes the newest text and closes, as Escape does. An embedded composer's
   * owner passes `close` from its own close action, which stands in for the icon.
   */
  readonly requestClose: (reason?: 'request' | 'close') => void;
};

type NoteComposerProps = {
  /** The field id; the label, status and hint ids derive from it. */
  readonly fieldId: string;
  /** The dialog or group id, referenced by the invoking control's `aria-controls`. */
  readonly panelId?: string;
  /** The field's and the card's accessible name, e.g. "Note on selected text". */
  readonly label: string;
  /** The muted line naming where the note is anchored, built from real data only. */
  readonly context: string;
  readonly contextIcon: AppIconName;
  /** The anchored passage, when there is one. */
  readonly quote?: string | null;
  /**
   * `popover` floats over the reader; `inline` sits in a list row with a
   * shallower shadow; `embedded` is part of a panel that owns the surface and
   * the close action, so it draws no card or close icon of its own.
   */
  readonly variant: 'popover' | 'inline' | 'embedded';
  readonly role: 'dialog' | 'group';
  /** Prefix for the `*-shortcut-hint` test id the editors already expose. */
  readonly testIdPrefix: string;
  /**
   * The draft the composer shows (`note-drafts.ts`). A draft still saving or
   * kept after a failure is continued; otherwise one is made from `autosave`.
   */
  readonly draftKey: string;
  /** The document the note belongs to, so a kept draft returns with its book. */
  readonly documentId: string;
  readonly autosave: NoteAutosaveOptions;
  /** False when the card is shown without the reader asking, so focus stays put. */
  readonly autoFocus?: boolean;
  /** Elements whose pointer presses are not "outside", such as the invoking button. */
  readonly ignoreOutside?: readonly RefObject<HTMLElement | null>[];
  readonly onClose: (close: NoteComposerClose) => void;
  readonly handle?: Ref<NoteComposerHandle>;
};

const NOTE_FONT = { system: 'serif', serif: 'serif', sans: 'sans', dyslexic: 'dyslexic' } as const;

function statusText(status: NoteSaveStatus, closing: boolean): string {
  switch (status.kind) {
    case 'idle': return 'Saves as you type';
    case 'pending': return closing ? 'Saving…' : 'Unsaved changes';
    case 'saving': return 'Saving…';
    case 'saved': return 'Saved';
    case 'error': return 'Not saved';
    case 'blocked': return 'Not saved';
  }
}

/** The card's own close; an embedded note is closed by the panel around it. */
function NoteCloseIcon({ variant, onClose }: { readonly variant: NoteComposerProps['variant']; readonly onClose: () => void }) {
  if (variant === 'embedded') return null;
  return (
    <button
      type="button"
      aria-label="Close note"
      title="Close note (Esc)"
      onClick={onClose}
      className="note-composer__icon-button"
    >
      <AppIcon name="close" size={13} />
    </button>
  );
}

/**
 * The margin sticky note: one editor for a location note, a note on a selected
 * passage, and an existing note's text in the Annotations panel.
 *
 * Text is saved a moment after the reader pauses (`note-autosave.ts`), so there
 * is no Save or Cancel. Done, Cmd/Ctrl+Enter, Escape, the close icon and a
 * click elsewhere each write the newest text first and close only once it is
 * stored; if the write fails the card stays open with the text and a Retry.
 * When the card goes away for another reason (another row, another book), the
 * draft is still written, and a failed one is kept to be shown again.
 * Plain Enter is a newline.
 */
export function NoteComposer({
  fieldId,
  panelId,
  label,
  context,
  contextIcon,
  quote = null,
  variant,
  role,
  testIdPrefix,
  draftKey,
  documentId,
  autosave,
  autoFocus = true,
  ignoreOutside = [],
  onClose,
  handle,
}: NoteComposerProps) {
  const { session, status } = useNoteAutosave(draftKey, autosave, { documentId, label, context, quote });
  const [text, setText] = useState(session.text);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fontFamily = useReaderStore((state) => state.reflowFontFamily);
  // Read through refs so the document listeners below are registered once,
  // yet always reach the newest close handler and ignore list.
  const onCloseRef = useRef(onClose);
  const ignoreRef = useRef(ignoreOutside);
  onCloseRef.current = onClose;
  ignoreRef.current = ignoreOutside;

  useEffect(() => {
    mountedRef.current = true;
    // Editing an existing note continues it, so the caret starts at its end.
    const field = fieldRef.current;
    if (field) field.setSelectionRange(field.value.length, field.value.length);
    return () => { mountedRef.current = false; };
  }, []);

  const finishRef = useRef<((reason: NoteComposerCloseReason) => Promise<void>) | null>(null);
  finishRef.current = async (reason) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const result = await session.flush();
    if (!mountedRef.current) return;
    closingRef.current = false;
    setClosing(false);
    if (result === 'error' || result === 'blocked') {
      // The text is still here; keyboard closes return to it, a click
      // elsewhere leaves focus wherever the reader put it.
      if (reason !== 'outside') fieldRef.current?.focus();
      return;
    }
    onCloseRef.current({ reason, annotationId: session.annotationId });
  };

  useImperativeHandle(handle, () => ({
    requestClose: (reason = 'request') => { void finishRef.current?.(reason); },
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      void finishRef.current?.('escape');
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target)) return;
      if (ignoreRef.current.some((ref) => ref.current?.contains(target) === true)) return;
      void finishRef.current?.('outside');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const labelId = `${fieldId}-label`;
  const contextId = `${fieldId}-context`;
  const statusId = `${fieldId}-status`;
  const errorId = `${fieldId}-error`;
  const problem = status.kind === 'error' || status.kind === 'blocked' ? status : null;
  // A list row is named by its context line, so the row's field keeps the only
  // "Note text" name in the list; a dialog or an embedded note by its field.
  const namedByField = variant !== 'inline';

  return (
    <div
      ref={cardRef}
      id={panelId}
      role={role}
      aria-modal={role === 'dialog' ? false : undefined}
      aria-labelledby={namedByField ? labelId : contextId}
      aria-describedby={namedByField ? contextId : undefined}
      aria-busy={closing || status.kind === 'saving' ? true : undefined}
      data-variant={variant}
      data-note-font={NOTE_FONT[fontFamily]}
      data-save-status={status.kind}
      data-testid={`${testIdPrefix}-composer`}
      className="note-composer"
    >
      <div className="note-composer__head">
        <AppIcon name={contextIcon} size={13} className="note-composer__context-icon" />
        <p id={contextId} className="note-composer__context" title={context}>{context}</p>
        <NoteCloseIcon variant={variant} onClose={() => { void finishRef.current?.('close'); }} />
      </div>
      {quote !== null && quote !== '' && (
        <blockquote className="note-composer__quote" data-testid={`${testIdPrefix}-quote`}>{quote}</blockquote>
      )}
      <label id={labelId} htmlFor={fieldId} className="sr-only">{label}</label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        autoFocus={autoFocus}
        maxLength={100_000}
        value={text}
        placeholder="Write a note…"
        aria-describedby={problem ? `${statusId} ${errorId}` : statusId}
        onChange={(event) => {
          setText(event.target.value);
          session.input(event.target.value);
        }}
        onKeyDown={(event) => {
          handleNoteSaveShortcut(event, !closingRef.current, () => { void finishRef.current?.('done'); });
        }}
        className="note-composer__field"
      />
      {problem && (
        <div id={errorId} role="alert" data-testid={`${testIdPrefix}-error`} className="note-composer__error">
          <p className="break-words">{problem.message}</p>
          {problem.kind === 'error' && <p>Your note is still here, so you can try again.</p>}
          <div className="note-composer__error-actions">
            {problem.kind === 'error' && problem.retryable && (
              <Button variant="outline" size="chip" disabled={closing} onClick={() => { void session.flush(); }}>
                <AppIcon name="retry" size={12} />
                Retry
              </Button>
            )}
            <Button
              variant="ghost"
              size="chip"
              disabled={closing}
              onClick={() => {
                session.discard();
                onCloseRef.current({ reason: 'discard', annotationId: session.annotationId });
              }}
            >
              {session.annotationId === null ? 'Discard note' : 'Discard unsaved text'}
            </Button>
          </div>
        </div>
      )}
      <div className="note-composer__foot">
        <span id={statusId} role="status" className="note-composer__status" data-testid={`${testIdPrefix}-save-status`}>
          {status.kind === 'saved' && <AppIcon name="check" size={12} />}
          {statusText(status, closing)}
        </span>
        <button
          type="button"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-disabled={closing ? true : undefined}
          onClick={() => { void finishRef.current?.('done'); }}
          className="note-composer__done"
        >
          Done
          <kbd className="note-composer__kbd" data-testid={`${testIdPrefix}-shortcut-hint`}>{NOTE_DONE_SHORTCUT_HINT}</kbd>
        </button>
      </div>
    </div>
  );
}
