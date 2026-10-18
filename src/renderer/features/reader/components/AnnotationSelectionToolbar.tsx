import { HIGHLIGHT_COLOR_OPTIONS } from '@shared/constants/annotations';
import { hasParagraphFormat } from '@shared/document-format-family';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HighlightColor } from '@shared/types/annotation';
import { useAnnotationStore } from '../../../stores/use-annotation-store';
import { AppIcon } from '../../../components/AppIcon';
import { selectActiveDocument, useReaderStore } from '../../../stores/use-reader-store';
import { useUiStore } from '../../../stores/use-ui-store';
import { useChatStore } from '../../../stores/use-chat-store';
import { useAgentStore } from '../../../stores/use-agent-store';
import {
  NOTE_SAVE_SHORTCUT_HINT,
  canSaveNoteDraft,
  handleNoteSaveShortcut,
} from '../../../hooks/note-save-shortcut';
import { bridge } from '../../../app/api-client';
import { Button } from '../../../components/ui/button';
import { selectionToolbarBounds, selectionToolbarPosition } from './selection-toolbar-position';

export function AnnotationSelectionToolbar() {
  const selection = useAnnotationStore((state) => state.selection);
  const createAnnotation = useAnnotationStore((state) => state.create);
  const requestAnnotationReveal = useAnnotationStore((state) => state.requestReveal);
  const setSelection = useAnnotationStore((state) => state.setSelection);
  const activeDocument = useReaderStore(selectActiveDocument);
  const showRightTab = useUiStore((state) => state.showRightTab);
  const addSelectionContext = useChatStore((state) => state.addSelectionContext);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  // One note per Save: the button and the Cmd/Ctrl+Enter shortcut share this
  // gate, so a second press while the create is in flight cannot make two.
  const [savingNote, setSavingNote] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  // Which swatch is currently pointed at, and which one holds focus. They are
  // tracked separately so hovering one swatch while another keeps keyboard
  // focus does not silence the focused one when the pointer leaves.
  const [hoveredColorLabel, setHoveredColorLabel] = useState<string | null>(null);
  const [focusedColorLabel, setFocusedColorLabel] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const noteButtonRef = useRef<HTMLButtonElement>(null);
  const notePanelRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    setNoteOpen(false);
    setNoteDraft('');
    setSavingNote(false);
    setCopyStatus('');
    setActionError(null);
    setHoveredColorLabel(null);
    setFocusedColorLabel(null);
  }, [selection]);

  // An error or status line can widen and lengthen the open box, so it is
  // measured again and re-clamped rather than growing past the reader.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    setToolbarSize((size) => measuredSize(toolbar, size));
  }, [toolbarSize.width, toolbarSize.height, selection, noteOpen, actionError, copyStatus]);

  // Dragging the note field's resize handle changes the box without a render,
  // so the browser's own resize notice re-measures and re-clamps it as well.
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { setToolbarSize((size) => measuredSize(toolbar, size)); });
    observer.observe(toolbar);
    return () => { observer.disconnect(); };
  }, [selection]);

  /**
   * The bare toolbar is itself a top layer (`hasOpenTopLayer`), so Escape has
   * to mean something here or it would be swallowed with nothing to show for
   * it. It dismisses the selection and hands the reader back its focus;
   * Focus Mode stays on, and the next Escape — with no top layer left — reaches
   * the app shortcut that exits it. While the note editor is open that dialog
   * owns Escape instead (below), which closes it without losing the selection.
   */
  useEffect(() => {
    if (!selection || noteOpen) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setSelection(null, null);
      const readerViewport = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]');
      window.queueMicrotask(() => { readerViewport?.focus(); });
    };
    document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('keydown', dismiss); };
  }, [noteOpen, selection, setSelection]);

  useEffect(() => {
    if (!noteOpen) return;
    const dismiss = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
      } else {
        const target = event.target;
        if (target instanceof Node && (notePanelRef.current?.contains(target) || noteButtonRef.current?.contains(target))) return;
      }
      setNoteOpen(false);
      window.queueMicrotask(() => { noteButtonRef.current?.focus(); });
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [noteOpen]);

  if (!selection || !activeDocument) return null;
  const readerRect = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]')?.getBoundingClientRect() ?? null;
  const bounds = selectionToolbarBounds(readerRect, { width: window.innerWidth, height: window.innerHeight });
  const { left, top, maxWidth } = selectionToolbarPosition(selection.clientRect, {
    width: toolbarSize.width > 0 ? toolbarSize.width : 420,
    height: toolbarSize.height > 0 ? toolbarSize.height : (noteOpen ? 180 : 44),
  }, bounds);

  const clear = (): void => {
    setSelection(null, null);
    setNoteOpen(false);
    setNoteDraft('');
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
   * A created highlight or note opens Annotations — but not while Focus Mode is
   * on, which the reader chose and which these two actions deliberately keep.
   * Below 920px `showRightTab` opens the companion drawer, which would appear
   * over the distraction-free reader and inert it.
   *
   * Opening the tab is not enough on its own: the panel keeps whatever scroll
   * position it had, so a reader deep in a long note would be shown the middle
   * of the list. The reveal is requested only here, where the panel is actually
   * being opened for a specific new annotation.
   */
  const showAnnotationsUnlessFocusMode = (annotationId: string): void => {
    if (useUiStore.getState().focusMode) return;
    showRightTab('annotations');
    // Bound to the book the annotation was made in: if the reader has moved on
    // by the time the row arrives, the request is simply not for that list.
    requestAnnotationReveal(activeDocument.id, annotationId);
  };

  const focusReaderAfterClear = (): void => {
    const readerViewport = document.querySelector<HTMLElement>('[data-reader-focus-target="true"]');
    window.queueMicrotask(() => { readerViewport?.focus(); });
  };
  const validateAnnotationBounds = (sel: NonNullable<typeof selection>): string | null => {
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

  const createHighlight = async (color: HighlightColor): Promise<void> => {
    setActionError(null);
    const boundError = validateAnnotationBounds(selection);
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
      showAnnotationsUnlessFocusMode(created.id);
      clear();
      focusReaderAfterClear();
    } else {
      setActionError(useAnnotationStore.getState().error ?? 'Could not create highlight.');
    }
  };

  /**
   * The one save path for this editor. The Save button and the Cmd/Ctrl+Enter
   * shortcut both call exactly this, so the bound validation, the anchor-quote
   * contract, the reveal, and the error message cannot differ between them.
   */
  const createNote = async (): Promise<void> => {
    if (savingNote) return;
    setActionError(null);
    const boundError = validateAnnotationBounds(selection);
    if (boundError) {
      setActionError(boundError);
      return;
    }
    if (!selection.anchor) return;
    setSavingNote(true);
    const created = await createAnnotation({
      documentId: activeDocument.id,
      type: 'note',
      anchor: selection.anchor,
      // Same anchor-quote contract as createHighlight above.
      selectedText: selection.anchor.quote.exact,
      note: noteDraft,
    }).finally(() => { setSavingNote(false); });
    if (created) {
      showAnnotationsUnlessFocusMode(created.id);
      clear();
      focusReaderAfterClear();
    } else {
      setActionError(useAnnotationStore.getState().error ?? 'Could not create note.');
    }
  };

  const canSaveNote = canSaveNoteDraft(noteDraft, savingNote);

  /** The single chat-context action: attach the passage and ask about it. */
  const askAi = async (): Promise<void> => {
    setActionError(null);
    const leftFocusMode = exitFocusMode();
    showRightTab('chat');
    const added = await addSelectionContext(activeDocument, selection.chatDescriptor, true);
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
      setActionError(`Agent context is limited to ${AGENT_MAX_CONTEXT_TEXT_LENGTH.toLocaleString('en-US')} characters. Narrow your selection or use AI Chat.`);
      return;
    }
    if (!selection.anchor) {
      setActionError('Agent context packets require a mapped document selection. Use AI Chat for this selection.');
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
      aria-label="Selection actions"
      className="fixed z-50 rounded-lg border border-border-subtle bg-bg-primary p-2 text-xs shadow-xl"
      style={{ left, top, maxWidth }}
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
              data-testid={`highlight-color-button-${item.id}`}
              onClick={() => { void createHighlight(item.id); }}
              onMouseEnter={() => { setHoveredColorLabel(item.label); }}
              onMouseLeave={() => { setHoveredColorLabel(null); }}
              onFocus={() => { setFocusedColorLabel(item.label); }}
              onBlur={() => { setFocusedColorLabel(null); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-bg-surface"
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
                className="ml-highlight-swatch h-5 w-5"
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
              if (noteOpen) {
                setNoteOpen(false);
                window.queueMicrotask(() => { noteButtonRef.current?.focus(); });
              } else {
                setNoteOpen(true);
              }
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
          <button
            type="button"
            aria-label="Close selection toolbar"
            onClick={clear}
            className="rounded px-1.5 py-1 text-text-secondary hover:bg-bg-surface shrink-0"
          >
            <AppIcon name="close" size={13} />
          </button>
        </div>
      </div>
      {copyStatus && <div role="status" className="mt-1 text-right text-2xs text-text-secondary">{copyStatus}</div>}
      {actionError && !noteOpen && <div role="alert" className="mt-1 text-2xs text-danger">{actionError}</div>}
      {noteOpen && (
        <div
          ref={notePanelRef}
          id="selection-note-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="selection-note-label"
          className="mt-2 border-t border-border-subtle pt-2"
        >
          <label id="selection-note-label" htmlFor="selection-note" className="block font-medium text-text-primary">Note on selected text</label>
          <textarea
            id="selection-note"
            autoFocus
            maxLength={100_000}
            value={noteDraft}
            onChange={(event) => { setNoteDraft(event.target.value); }}
            onKeyDown={(event) => {
              handleNoteSaveShortcut(event, canSaveNote, () => { void createNote(); });
            }}
            aria-describedby={noteFieldDescription(noteDraft, actionError)}
            className="mt-1 h-20 max-h-[40vh] w-full max-w-full min-w-0 resize-y rounded-md border border-border-subtle bg-bg-surface p-2 text-text-primary"
          />
          {noteDraft.trim() === '' && (
            <p id="selection-note-empty" data-testid="selection-note-empty" className="mt-1 text-2xs text-text-secondary">
              Write something to save this note.
            </p>
          )}
          {/* A failed save is not invalid note content, so the field is
              described by the error rather than marked invalid. The recovery
              hint is its own line, apart from the main error's diagnostic ID. */}
          {actionError && (
            <div id="selection-note-error" role="alert" data-testid="selection-note-error" className="mt-1 text-2xs text-danger">
              <p className="break-words">{actionError}</p>{' '}
              <p className="mt-0.5">Your note is still here, so you can try again.</p>
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-2xs text-text-secondary" data-testid="selection-note-shortcut-hint">
              {NOTE_SAVE_SHORTCUT_HINT}
            </span>
            <Button
              variant="ghost"
              size="chip"
              onClick={() => {
                setNoteOpen(false);
                window.queueMicrotask(() => { noteButtonRef.current?.focus(); });
              }}
              className="px-2"
            >Cancel</Button>
            <Button variant="primary" size="chip" disabled={!canSaveNote} aria-busy={savingNote} onClick={() => { void createNote(); }}>
              Save note
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The note field's description: the empty-draft hint, else a failed save. */
function noteFieldDescription(draft: string, error: string | null): string | undefined {
  if (draft.trim() === '') return 'selection-note-empty';
  return error === null ? undefined : 'selection-note-error';
}

type MeasuredSize = { readonly width: number; readonly height: number };

/** The element's size now, or the previous size when it moved by a pixel or less. */
function measuredSize(element: HTMLElement, previous: MeasuredSize): MeasuredSize {
  const rect = element.getBoundingClientRect();
  const changed = Math.abs(rect.width - previous.width) > 1 || Math.abs(rect.height - previous.height) > 1;
  return changed ? { width: rect.width, height: rect.height } : previous;
}
