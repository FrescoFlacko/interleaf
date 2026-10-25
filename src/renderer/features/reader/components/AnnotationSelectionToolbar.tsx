import { HIGHLIGHT_COLOR_OPTIONS } from '@shared/constants/annotations';
import { hasParagraphFormat } from '@shared/document-format-family';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HighlightColor } from '@shared/types/annotation';
import type { ReaderSelection } from '../types';
import { useAnnotationStore } from '../../../stores/use-annotation-store';
import { AppIcon } from '../../../components/AppIcon';
import { selectActiveDocument, useReaderStore } from '../../../stores/use-reader-store';
import { useUiStore } from '../../../stores/use-ui-store';
import { useChatStore } from '../../../stores/use-chat-store';
import { useAgentStore } from '../../../stores/use-agent-store';
import { NoteComposer, type NoteComposerClose, type NoteComposerHandle } from '../../../components/note/NoteComposer';
import { createThenUpdateNote } from '../../../hooks/note-persistence';
import { newNoteDraftKey } from '../../../hooks/note-drafts';
import type { NotePersistResult } from '../../../hooks/note-autosave';
import { bridge } from '../../../app/api-client';
import { Button } from '../../../components/ui/button';
import { selectionToolbarBounds, selectionToolbarStyle, toolbarAnchor, type ToolbarAnchor } from './selection-toolbar-position';
import { liveSelectionRange, paintSelectionNote } from '../annotations/selection-note-paint';
import type { HighlightEditing } from '../annotations/use-highlight-edit';
import {
  DeleteHighlightButton,
  useFocusOnKeyboardOpen,
  useRecolorHighlight,
  useSelectionToolbarTarget,
} from './highlight-edit-controls';

type AnnotationSelectionToolbarProps = {
  /** A saved highlight reopened by clicking its painted text, shown while no live selection exists. */
  readonly editing?: HighlightEditing | null;
};

/**
 * One opening of the note editor, frozen when "Add note" is pressed: the
 * passage, its document and anchor, and how a write is made. `key` gives each
 * opening its own composer and autosave session.
 */
type SelectionNoteSession = {
  /** The note's draft, which is also the composer's key. */
  readonly key: string;
  /** The toolbar target it was opened on, compared by identity when it closes. */
  readonly selection: object;
  readonly documentId: string;
  readonly quote: string | null;
  readonly persist: (text: string, id: string | null) => Promise<NotePersistResult>;
  /** Where the toolbar was when the note opened; the open box grows from there. */
  readonly anchor: ToolbarAnchor;
  /** The passage, kept marked while the note field holds focus. */
  readonly range: Range | null;
};

/** Where an open note grows from and what it marks, while it is open on `selection`. */
function openNoteTarget(noteOpen: boolean, session: SelectionNoteSession | null, selection: object | null): { anchor: ToolbarAnchor | null; range: Range | null } {
  if (!noteOpen || session?.selection !== selection) return { anchor: null, range: null };
  return { anchor: session.anchor, range: session.range };
}

export function AnnotationSelectionToolbar({ editing: reopened = null }: AnnotationSelectionToolbarProps) {
  const { selection, editing, resetKey, label: toolbarLabel } = useSelectionToolbarTarget(reopened);
  const createAnnotation = useAnnotationStore((state) => state.create);
  const requestAnnotationReveal = useAnnotationStore((state) => state.requestReveal);
  const setSelection = useAnnotationStore((state) => state.setSelection);
  const activeDocument = useReaderStore(selectActiveDocument);
  const showRightTab = useUiStore((state) => state.showRightTab);
  const addSelectionContext = useChatStore((state) => state.addSelectionContext);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteSession, setNoteSession] = useState<SelectionNoteSession | null>(null);
  const noteHandleRef = useRef<NoteComposerHandle>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  // Which swatch is currently pointed at, and which one holds focus. They are
  // tracked separately so hovering one swatch while another keeps keyboard
  // focus does not silence the focused one when the pointer leaves.
  const [hoveredColorLabel, setHoveredColorLabel] = useState<string | null>(null);
  const [focusedColorLabel, setFocusedColorLabel] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const noteButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  const recolorHighlight = useRecolorHighlight(editing, { setActionError, setStatus: setCopyStatus });
  useFocusOnKeyboardOpen(editing, toolbarRef);

  useEffect(() => {
    setNoteOpen(false);
    setNoteSession(null);
    setCopyStatus('');
    setActionError(null);
    setHoveredColorLabel(null);
    setFocusedColorLabel(null);
  }, [resetKey]);

  // An error or status line can widen and lengthen the open box, so it is
  // measured again and re-clamped rather than growing past the reader.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    setToolbarSize((size) => measuredSize(toolbar, size));
  }, [toolbarSize.width, toolbarSize.height, selection, noteOpen, actionError, copyStatus]);

  // The note field grows as the reader types without the toolbar re-rendering,
  // so the browser's own resize notice re-measures and re-clamps it as well.
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { setToolbarSize((size) => measuredSize(toolbar, size)); });
    observer.observe(toolbar);
    return () => { observer.disconnect(); };
  }, [selection]);

  // The note field takes focus and collapses the browser selection, so the
  // passage keeps a temporary mark of its own for as long as the note is open
  // on it. Closing, a new selection, a document change or unmounting clears it.
  const { anchor: openAt, range: paintRange } = openNoteTarget(noteOpen, noteSession, selection);
  useEffect(() => (paintRange ? paintSelectionNote(paintRange) : undefined), [paintRange]);

  // An open note stays where it opened, so a window resize is the one thing
  // that re-clamps it; nothing else re-renders the toolbar then.
  const [, setViewportVersion] = useState(0);
  useEffect(() => {
    if (!noteOpen) return;
    const reclamp = (): void => { setViewportVersion((version) => version + 1); };
    window.addEventListener('resize', reclamp);
    return () => { window.removeEventListener('resize', reclamp); };
  }, [noteOpen]);

  /**
   * The bare toolbar is itself a top layer (`hasOpenTopLayer`), so Escape has
   * to mean something here or it would be swallowed with nothing to show for
   * it. It dismisses the selection and hands the reader back its focus;
   * Focus Mode stays on, and the next Escape — with no top layer left — reaches
   * the app shortcut that exits it. While the note editor is open that dialog
   * owns Escape instead (below), which closes it without losing the selection.
   * A reopened highlight closes and returns focus to whatever opened it.
   */
  useEffect(() => {
    if (!selection || noteOpen) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (editing) {
        editing.close('escape');
        return;
      }
      setSelection(null, null);
      const readerViewport = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]');
      window.queueMicrotask(() => { readerViewport?.focus(); });
    };
    document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('keydown', dismiss); };
  }, [editing, noteOpen, selection, setSelection]);

  if (!selection || !activeDocument) return null;
  const readerRect = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]')?.getBoundingClientRect() ?? null;
  const bounds = selectionToolbarBounds(readerRect, { width: window.innerWidth, height: window.innerHeight });
  const size = {
    width: toolbarSize.width > 0 ? toolbarSize.width : 420,
    height: toolbarSize.height > 0 ? toolbarSize.height : (noteOpen ? 180 : 44),
  };
  const placement = selectionToolbarStyle(selection.clientRect, openAt, size, bounds);
  const { left, top } = placement;

  const clear = (): void => {
    setSelection(null, null);
    editing?.release();
    setNoteOpen(false);
    setActionError(null);
  };

  /**
   * A selection made in Focus Mode keeps this toolbar, so an action that opens
   * a companion panel has to leave Focus Mode itself. `toggleFocusMode`
   * restores the saved drawer/tab snapshot on exit, so it must run BEFORE
   * `showRightTab`, or the snapshot would overwrite the requested destination.
   * Highlight and note stay inside Focus Mode and never call this. Returns
   * whether this action actually left Focus Mode.
   */
  const exitFocusMode = (): boolean => {
    const ui = useUiStore.getState();
    if (!ui.focusMode) return false;
    ui.toggleFocusMode();
    return true;
  };

  /**
   * Claims focus for the panel this action just opened.
   *
   * Leaving Focus Mode makes `App` restore the saved return element inside a
   * `requestAnimationFrame` callback it registers when `focusMode` flips to
   * false. A microtask — or the same frame — would be overwritten by that
   * restoration, so an exiting action claims its destination in the frame after
   * Focus Mode has had its turn. Ordinary (non-exiting) actions keep the
   * microtask they always used.
   */
  const claimDestinationFocus = (selector: string, afterFocusModeExit: boolean): void => {
    const claim = (): void => { document.querySelector<HTMLElement>(selector)?.focus(); };
    if (!afterFocusModeExit) {
      window.queueMicrotask(claim);
      return;
    }
    window.requestAnimationFrame(() => { window.requestAnimationFrame(claim); });
  };

  /**
   * A note finished with Done opens Annotations — but not while Focus Mode is
   * on, which the reader chose and which note-taking deliberately keeps. Below 920px
   * `showRightTab` opens the companion drawer, which would appear over the
   * distraction-free reader and inert it. A highlight never calls this: it is
   * saved and painted in place, leaving the companion and its tab as they were.
   *
   * Opening the tab is not enough on its own: the panel keeps whatever scroll
   * position it had, so a reader deep in a long note would be shown the middle
   * of the list. The reveal is requested only here, where the panel is actually
   * being opened for a specific new annotation.
   */
  const showAnnotationsUnlessFocusMode = (annotationId: string, documentId = activeDocument.id): void => {
    if (useUiStore.getState().focusMode) return;
    showRightTab('annotations');
    // Bound to the book the annotation was made in: if the reader has moved on
    // by the time the row arrives, the request is simply not for that list.
    requestAnnotationReveal(documentId, annotationId);
  };

  const focusReaderAfterClear = (): void => {
    const readerViewport = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]');
    window.queueMicrotask(() => { readerViewport?.focus(); });
  };
  const validateAnnotationBounds = (sel: ReaderSelection): string | null => {
    if (sel.chatDescriptor.format === 'pdf' && sel.chatDescriptor.endPageIndex - sel.chatDescriptor.startPageIndex + 1 > 50) {
      return 'Highlights and notes are limited to 50 pages. Use Ask AI for large ranges.';
    }
    if (sel.chatDescriptor.format === 'markdown' && sel.chatDescriptor.endBlockIndex - sel.chatDescriptor.startBlockIndex + 1 > 100) {
      return 'Highlights and notes are limited to 100 blocks. Use Ask AI for large ranges.';
    }
    if (hasParagraphFormat(sel.chatDescriptor) && sel.chatDescriptor.endParagraphIndex - sel.chatDescriptor.startParagraphIndex + 1 > 100) {
      return 'Highlights and notes are limited to 100 paragraphs. Use Ask AI for large ranges.';
    }
    const totalLen = sel.totalSelectedLength;
    if (totalLen > 256_000) {
      return 'Highlights and notes are limited to 256,000 characters. Use Ask AI for large passages.';
    }
    if (!sel.anchor) {
      return 'Highlights and notes could not be mapped to document segments deterministically. Use Ask AI for this selection.';
    }
    const anchor = sel.anchor;
    if (anchor.format === 'pdf' && anchor.segments && anchor.segments.length > 1) {
      const pages = anchor.segments.map((s) => s.pageIndex);
      const span = Math.max(...pages) - Math.min(...pages) + 1;
      if (span > 50) {
        return 'Highlights and notes are limited to 50 pages. Use Ask AI for large ranges.';
      }
    }
    if (anchor.format === 'markdown' && anchor.segments && anchor.segments.length > 1) {
      const blocks = anchor.segments.map((s) => s.blockIndex);
      const span = Math.max(...blocks) - Math.min(...blocks) + 1;
      if (span > 100) {
        return 'Highlights and notes are limited to 100 blocks. Use Ask AI for large ranges.';
      }
    }
    if (hasParagraphFormat(anchor) && anchor.segments && anchor.segments.length > 1) {
      const paras = anchor.segments.map((s) => s.paragraphIndex);
      const span = Math.max(...paras) - Math.min(...paras) + 1;
      if (span > 100) {
        return 'Highlights and notes are limited to 100 paragraphs. Use Ask AI for large ranges.';
      }
    }
    return null;
  };

  /** A saved highlight with no chat route passed these bounds when it was created. */
  const targetBoundsError = (target: typeof selection): string | null =>
    target.chatDescriptor === null ? null : validateAnnotationBounds({ ...target, chatDescriptor: target.chatDescriptor });

  const createHighlight = async (color: HighlightColor): Promise<void> => {
    setActionError(null);
    const boundError = targetBoundsError(selection);
    if (boundError) {
      setActionError(boundError);
      return;
    }
    if (!selection.anchor) return;
    const created = await createAnnotation({
      documentId: activeDocument.id,
      type: 'highlight',
      anchor: selection.anchor,
      /**
       * The annotation contract requires `selectedText` to equal the anchor's
       * exact quote. `selection.selectedText` is the native `Selection`
       * string, which for a multi-line PDF drag carries the `<br>` newlines the
       * anchor quote (sliced from the layer's text content) cannot contain;
       * sourcing the payload from the anchor keeps the two consistent for every
       * format. Copy, Ask AI, and agent context continue to use the native
       * string above.
       */
      selectedText: selection.anchor.quote.exact,
      color,
    });
    if (created) {
      clear();
      focusReaderAfterClear();
    } else {
      setActionError(useAnnotationStore.getState().error ?? 'Could not create highlight.');
    }
  };

  /**
   * Opens the note editor on the passage as it is now. The bound checks, the
   * anchor and the anchor-quote contract (as for createHighlight above) are
   * fixed here, so every autosave of this note writes to the same place even if
   * the selection or the document changes while the editor is open. A passage
   * that cannot be annotated still opens the editor, and its first write
   * reports why instead of creating anything.
   */
  const openNote = (): void => {
    setActionError(null);
    const boundError = targetBoundsError(selection);
    const anchor = selection.anchor;
    const documentId = activeDocument.id;
    const blocked = boundError ?? 'Highlights and notes could not be mapped to document segments deterministically. Use Ask AI for this selection.';
    setNoteSession({
      key: newNoteDraftKey('selection'),
      selection,
      documentId,
      quote: anchor?.quote.exact ?? null,
      persist: boundError === null && anchor
        ? createThenUpdateNote({
            documentId,
            anchor,
            selectedText: anchor.quote.exact,
            // The passage stays selected, and this toolbar stays put, while
            // the note autosaves; the selection is cleared when it closes.
            keepSelection: true,
          })
        : () => Promise.resolve({ ok: false, message: blocked, retryable: false }),
      anchor: toolbarAnchor({ left, top }),
      range: editing ? null : liveSelectionRange(document.querySelector('[data-reader-focus-target="true"]'), selection.selectedText),
    });
    setNoteOpen(true);
  };

  /**
   * The composer has stored the newest text (or there was none) and closed.
   * Done keeps the Save behaviour: open Annotations on the new note (outside
   * Focus Mode), clear the passage and return to the reader. A dismissal never
   * opens a panel. Once a note exists the passage has done its job, so it is
   * cleared too; with no note the toolbar stays for another action. A click
   * elsewhere leaves focus where it landed and never clears a newer selection.
   */
  const closeNote = ({ reason, annotationId }: NoteComposerClose): void => {
    const opened = noteSession;
    if (annotationId === null || opened === null) {
      setNoteOpen(false);
      if (reason !== 'outside') window.queueMicrotask(() => { noteButtonRef.current?.focus(); });
      return;
    }
    if (reason === 'done') showAnnotationsUnlessFocusMode(annotationId, opened.documentId);
    if (reason === 'outside') {
      if (selection === opened.selection) clear();
      else setNoteOpen(false);
      return;
    }
    clear();
    focusReaderAfterClear();
  };

  /** A swatch recolours a reopened highlight in place, else highlights the selection. */
  const chooseColor = (color: HighlightColor): Promise<void> =>
    editing ? recolorHighlight(color) : createHighlight(color);

  /**
   * Close returns focus to what reopened a highlight, as Escape does. While the
   * note is expanded it is the note's only close: it writes the newest text
   * and closes the note as Escape would.
   */
  const closeToolbar = (): void => {
    if (noteOpen) noteHandleRef.current?.requestClose('close');
    else if (editing) editing.close('close-button');
    else clear();
  };

  /** The single chat-context action: attach the passage and ask about it. */
  const askAi = async (): Promise<void> => {
    setActionError(null);
    const descriptor = selection.chatDescriptor;
    if (!descriptor) {
      setActionError('This highlight has no section reference to attach. Select the text again to ask about it.');
      return;
    }
    const leftFocusMode = exitFocusMode();
    showRightTab('chat');
    const added = await addSelectionContext(activeDocument, descriptor, true);
    if (!added) return;
    clear();
    // The chat store already armed the composer (`composerFocusNonce`); this
    // makes the composer the last claim on focus even when Focus Mode's own
    // restoration runs after that effect.
    claimDestinationFocus('#chat-composer', leftFocusMode);
  };

  const submitToAgent = (): void => {
    setActionError(null);
    const totalLen = selection.totalSelectedLength;
    // The same limit the Agent panel's "+ Selection" and main's schema apply.
    if (totalLen > AGENT_MAX_CONTEXT_TEXT_LENGTH) {
      setActionError(`Agent context is limited to ${AGENT_MAX_CONTEXT_TEXT_LENGTH.toLocaleString('en-US')} characters. Narrow your selection or use Chat.`);
      return;
    }
    if (!selection.anchor) {
      setActionError('Agent context packets require a mapped document selection. Use Chat for this selection.');
      return;
    }
    // Every rejection above keeps Focus Mode and the error visible; only an
    // accepted packet leaves Focus Mode to open the Agent panel.
    const leftFocusMode = exitFocusMode();
    useAgentStore.getState().setSelection(activeDocument, selection.anchor, selection.selectedText);
    showRightTab('agent');
    clear();
    claimDestinationFocus('#agent-task-description', leftFocusMode);
  };

  return (
    <div
      ref={toolbarRef}
      data-testid="annotation-selection-toolbar"
      data-top-layer="selection-toolbar"
      role="toolbar"
      aria-label={toolbarLabel}
      data-editing-annotation-id={editing?.annotation.id}
      data-note-open={noteOpen ? 'true' : undefined}
      className={`fixed z-50 rounded-lg border p-2 text-xs ${noteOpen ? 'note-surface-panel' : 'border-border-subtle bg-bg-primary shadow-xl'}`}
      style={placement}
    >
      <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
        <div className="flex items-center gap-1 shrink-0">
          <span className="mr-0.5 font-medium text-text-secondary">Highlight</span>
          {HIGHLIGHT_COLOR_OPTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={`${item.label} highlight`}
              title={`${item.label} highlight`}
              aria-pressed={editing ? editing.annotation.color === item.id : undefined}
              data-testid={`highlight-color-button-${item.id}`}
              onClick={() => { void chooseColor(item.id); }}
              onMouseEnter={() => { setHoveredColorLabel(item.label); }}
              onMouseLeave={() => { setHoveredColorLabel(null); }}
              onFocus={() => { setFocusedColorLabel(item.label); }}
              onBlur={() => { setFocusedColorLabel(null); }}
              className="group flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-bg-surface"
            >
              {/*
                * The color itself is painted from the shared definition's hex
                * value as an inline style. The utility class this replaces was
                * interpolated per color, so the production build never emitted
                * it and every button rendered as a white circle with a letter.
                */}
              <span
                aria-hidden="true"
                data-testid={`highlight-color-swatch-${item.id}`}
                className="ml-highlight-swatch h-5 w-5 group-aria-pressed:outline-2 group-aria-pressed:outline-offset-2 group-aria-pressed:outline-text-primary"
                style={{ backgroundColor: item.hexValue }}
              />
            </button>
          ))}
          {/*
            * Color alone never carries the meaning (UX_SPEC §2). Pointing at or
            * keyboard-focusing a swatch names it here, in ordinary visible text
            * that lives inside the toolbar's own clamped box, so the name cannot
            * escape the viewport the way a floating tooltip could at 200%. The
            * slot keeps its width so naming a color never reflows the toolbar
            * under the pointer, and it is aria-hidden because the button's own
            * accessible name already says the same words.
            */}
          <span
            aria-hidden="true"
            data-testid="highlight-color-name"
            className="ml-0.5 min-w-[3.5rem] shrink-0 font-medium text-text-primary"
          >
            {hoveredColorLabel ?? focusedColorLabel ?? ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            ref={noteButtonRef}
            variant="ghost"
            size="chip"
            aria-expanded={noteOpen}
            aria-controls="selection-note-popover"
            onClick={() => {
              if (noteOpen) noteHandleRef.current?.requestClose();
              else openNote();
            }}
            className="px-2"
          >
            Add note
          </Button>
          <Button
            variant="ghost"
            size="chip"
            onClick={() => {
              void (async () => {
                try {
                  await bridge.clipboard.writeText(selection.selectedText);
                  setCopyStatus('Copied');
                } catch {
                  setCopyStatus('Copy failed');
                }
              })();
            }}
            className="px-2"
          >
            Copy
          </Button>
          <Button variant="ghost-accent" size="chip" onClick={() => { void askAi(); }} className="px-2">
            Ask AI
          </Button>
          <Button
            variant="ghost"
            size="chip"
            onClick={submitToAgent}
            aria-label="Submit selected passage to agent"
            className="px-2"
          >
            Submit to agent
          </Button>
          {editing && <DeleteHighlightButton editing={editing} setActionError={setActionError} setStatus={setCopyStatus} />}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={noteOpen ? 'Close note' : 'Close selection toolbar'}
            title={noteOpen ? 'Close note (Esc)' : undefined}
            onClick={closeToolbar}
            className="rounded px-1.5 py-1 text-text-secondary hover:bg-bg-surface shrink-0"
          >
            <AppIcon name="close" size={13} />
          </button>
        </div>
      </div>
      {copyStatus && <div role="status" className="mt-1 text-right text-2xs text-text-secondary">{copyStatus}</div>}
      {actionError && !noteOpen && <div role="alert" className="mt-1 text-2xs text-danger">{actionError}</div>}
      {noteOpen && noteSession && (
        <div className="note-surface-panel__body">
          <NoteComposer
            key={noteSession.key}
            handle={noteHandleRef}
            fieldId="selection-note"
            panelId="selection-note-popover"
            label="Note on selected text"
            context="Note on selection"
            contextIcon="add-note"
            quote={noteSession.quote}
            variant="embedded"
            role="group"
            testIdPrefix="selection-note"
            draftKey={noteSession.key}
            documentId={noteSession.documentId}
            autosave={{ initialText: '', initialId: null, allowEmpty: false, persist: noteSession.persist }}
            ignoreOutside={[noteButtonRef, closeButtonRef]}
            onClose={closeNote}
          />
        </div>
      )}
    </div>
  );
}

type MeasuredSize = { readonly width: number; readonly height: number };

/** The element's size now, or the previous size when it moved by a pixel or less. */
function measuredSize(element: HTMLElement, previous: MeasuredSize): MeasuredSize {
  const rect = element.getBoundingClientRect();
  const changed = Math.abs(rect.width - previous.width) > 1 || Math.abs(rect.height - previous.height) > 1;
  return changed ? { width: rect.width, height: rect.height } : previous;
}
