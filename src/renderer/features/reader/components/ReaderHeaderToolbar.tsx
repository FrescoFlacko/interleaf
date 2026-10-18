import { useEffect, useRef, useState } from 'react';
import { isReaderReady, selectActiveDocument, selectAdapter, useReaderStore } from '../../../stores/use-reader-store';
import { useUiStore } from '../../../stores/use-ui-store';
import { useAnnotationStore } from '../../../stores/use-annotation-store';
import { locationToAnchor } from '../annotations/dom-anchors';
import { AppIcon } from '../../../components/AppIcon';
import { phaseAttributes, usePopoverPresence } from '../../../components/ui/popover-presence';
import { Select } from '../../../components/ui/select';
import { LINE_SPACING_OPTIONS, MARGIN_OPTIONS, parseZoomChoice, zoomOptions, zoomSelectValue } from './reader-display-options';
import {
  NOTE_SAVE_SHORTCUT_HINT,
  canSaveNoteDraft,
  handleNoteSaveShortcut,
} from '../../../hooks/note-save-shortcut';


const REFLOWABLE_FORMATS: ReadonlySet<string> = new Set(['epub', 'mobi', 'docx', 'pptx', 'markdown']);

function isReflowableFormat(format: string | undefined): boolean {
  return format !== undefined && REFLOWABLE_FORMATS.has(format);
}

export function ReaderHeaderToolbar({ hidden }: { readonly hidden: boolean }) {
  const activeDocument = useReaderStore(selectActiveDocument);
  const adapter = useReaderStore(selectAdapter);
  const currentPage = useReaderStore((s) => s.currentPage);
  const pageCount = useReaderStore((s) => s.pageCount);
  const zoom = useReaderStore((s) => s.zoom);
  const zoomMode = useReaderStore((s) => s.zoomMode);
  const reflowLineHeight = useReaderStore((s) => s.reflowLineHeight);
  const reflowHorizontalMarginRem = useReaderStore((s) => s.reflowHorizontalMarginRem);
  const tableOfContents = useReaderStore((s) => s.tableOfContents);
  const isTocOpen = useReaderStore((s) => s.isTocOpen);
  const explicitNavigationLocation = useReaderStore((s) => s.explicitNavigationLocation);
  const readerReady = useReaderStore(isReaderReady);

  const goToPage = useReaderStore((s) => s.goToPage);
  const setZoom = useReaderStore((s) => s.setZoom);
  const zoomIn = useReaderStore((s) => s.zoomIn);
  const zoomOut = useReaderStore((s) => s.zoomOut);
  const setReflowLineHeight = useReaderStore((s) => s.setReflowLineHeight);
  const setReflowHorizontalMargin = useReaderStore((s) => s.setReflowHorizontalMargin);
  const toggleToc = useReaderStore((s) => s.toggleToc);

  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocusMode = useUiStore((s) => s.toggleFocusMode);
  const showRightTab = useUiStore((s) => s.showRightTab);
  const createAnnotation = useAnnotationStore((s) => s.create);
  const requestAnnotationReveal = useAnnotationStore((s) => s.requestReveal);

  const [pageInput, setPageInput] = useState(String(currentPage));
  const [locationNoteOpen, setLocationNoteOpen] = useState(false);
  const [locationNoteDraft, setLocationNoteDraft] = useState('');
  // Shared by the Save button and the shortcut so one note cannot be created
  // twice by a second press while the first create is still in flight.
  const [savingLocationNote, setSavingLocationNote] = useState(false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const displaySettingsPresence = usePopoverPresence(displaySettingsOpen);
  const locationNotePresence = usePopoverPresence(locationNoteOpen);
  const locationNoteButtonRef = useRef<HTMLButtonElement>(null);
  const locationNotePanelRef = useRef<HTMLDivElement>(null);
  const displaySettingsButtonRef = useRef<HTMLButtonElement>(null);
  const displaySettingsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    if (!locationNoteOpen) return;
    const dismiss = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
      } else {
        const target = event.target;
        if (target instanceof Node && (locationNotePanelRef.current?.contains(target) || locationNoteButtonRef.current?.contains(target))) return;
      }
      setLocationNoteOpen(false);
      window.queueMicrotask(() => { locationNoteButtonRef.current?.focus(); });
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [locationNoteOpen]);

  useEffect(() => {
    if (!displaySettingsOpen) return;
    const dismiss = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
      } else {
        const target = event.target;
        if (target instanceof Node && (displaySettingsPanelRef.current?.contains(target) || displaySettingsButtonRef.current?.contains(target))) return;
      }
      setDisplaySettingsOpen(false);
      window.queueMicrotask(() => { displaySettingsButtonRef.current?.focus(); });
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [displaySettingsOpen]);

  // Deliberate focus: opening the dialog moves focus to its surface so
  // keyboard and pointer users land inside the settings context.
  const displaySettingsShown = displaySettingsOpen && displaySettingsPresence.present;
  useEffect(() => {
    if (!displaySettingsShown) return;
    displaySettingsPanelRef.current?.focus();
  }, [displaySettingsShown]);

  const handlePageSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isNaN(parsed)) void goToPage(Math.max(1, Math.min(pageCount || 1, parsed)));
    setPageInput(String(currentPage));
  };

  const handleZoomSelect = (value: string): void => {
    const choice = parseZoomChoice(value);
    if (choice !== null) void setZoom(choice);
  };

  const formattedZoomPercentage = `${String(Math.round(zoom * 100))}%`;
  const isReflowable = isReflowableFormat(activeDocument?.format);

  const addBookmark = async (): Promise<void> => {
    if (!activeDocument || !adapter) return;
    const created = await createAnnotation({
      documentId: activeDocument.id,
      type: 'bookmark',
      anchor: locationToAnchor(explicitNavigationLocation ?? adapter.getReadingLocation().location),
      label: `Page ${String(adapter.getCurrentPage())}`,
    });
    if (created) {
      showRightTab('annotations');
      requestAnnotationReveal(created.documentId, created.id);
    }
  };

  /**
   * The one save path for the location note. The Save button and the
   * Cmd/Ctrl+Enter shortcut both call exactly this, so neither can skip the
   * blank-draft guard or the reveal that follows a successful create.
   */
  const addLocationNote = async (): Promise<void> => {
    if (!activeDocument || !adapter || !locationNoteDraft.trim() || savingLocationNote) return;
    setSavingLocationNote(true);
    const created = await createAnnotation({
      documentId: activeDocument.id,
      type: 'note',
      anchor: locationToAnchor(explicitNavigationLocation ?? adapter.getReadingLocation().location),
      note: locationNoteDraft,
      isLocationNote: true,
    }).finally(() => { setSavingLocationNote(false); });
    if (created) {
      setLocationNoteDraft('');
      setLocationNoteOpen(false);
      showRightTab('annotations');
      requestAnnotationReveal(created.documentId, created.id);
      window.queueMicrotask(() => { locationNoteButtonRef.current?.focus(); });
    }
  };

  const canSaveLocationNote = canSaveNoteDraft(locationNoteDraft, savingLocationNote);

  return (
    <div className="relative min-w-0 max-w-full @container" data-testid="reader-header-toolbar-wrapper">
      <header
        data-testid="reader-header-toolbar"
        hidden={hidden}
        aria-hidden={hidden ? true : undefined}
        /* The height is the shared workspace row height rather than this row's
           own padding: the companion tab bar beside it takes the same value, so
           the two dividers meet at one line. Vertical padding would reintroduce
           the 2px step it replaces. */
        className="flex h-[var(--workspace-header-row-height)] flex-nowrap items-center justify-between gap-2 border-b border-border-subtle bg-bg-primary px-4 text-xs shadow-2xs select-none min-w-0 max-w-full relative z-10"
      >
      {/* Identity cluster absorbs all horizontal pressure: flex-1 gives it
          exactly the leftover width after the right cluster's natural size and
          min-w-0 lets the title ellipsize, so the right cluster can never be
          pushed off-viewport. The clip belongs to the title alone (below) —
          clipping the whole cluster would also cut the outline the leading
          control paints outside its own box when focused by keyboard.
          Compact tier: <= 920px container the action labels collapse to
          icons (same regime as the app shell's compact presentation), which
          leaves the title a meaningful visible width even in ~456px reader
          columns. Popovers are not anchored here. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 @max-[920px]:gap-2">
        {/* Outline leads the header. It is the one control that acts on the
            document's own structure, so it sits with the title rather than with
            the page/display actions on the right, in the position the Library
            control used to hold. shrink-0 keeps it whole while the title
            absorbs the horizontal pressure beside it. */}
        {tableOfContents.length > 0 && (
          <button
            type="button"
            data-testid="toggle-toc-button"
            aria-label="Toggle table of contents"
            aria-pressed={isTocOpen}
            onClick={toggleToc}
            className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              isTocOpen
                ? 'border-accent bg-accent/10 text-accent font-semibold'
                : 'border-border-subtle bg-bg-surface text-text-secondary hover:text-text-primary'
            }`}
            title="Table of Contents (T)"
          >
            <AppIcon name="outline" size={14} />
            <span className="@max-[920px]:hidden">Outline</span>
          </button>
        )}

        {activeDocument && (
          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
            {/* The title is the header's subject and now carries the weight the
                format badge used to take: the format is already evident from
                the document itself, so the row spends that width on the name
                instead. Truncation is unchanged, so the right-side controls
                still keep their full size in a narrow reader column. */}
            <h1
              data-testid="reader-document-title"
              title={activeDocument.title}
              className="min-w-0 truncate text-base font-bold text-text-primary"
            >
              {activeDocument.title}
            </h1>
          </div>
        )}
      </div>

      {/* Right section: page navigation, display settings menu, bookmark/note, focus.
          shrink-0 keeps every action fully visible: the identity cluster absorbs
          all horizontal pressure instead. At <= 920px container width the text
          labels collapse to icon-only (aria-labels keep the full names). */}
      <div className="flex items-center justify-end gap-1.5 @max-[920px]:gap-1 shrink-0">
        <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-bg-surface p-0.5">
          <button
            type="button"
            data-testid="prev-page-button"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => {
              void goToPage(currentPage - 1);
            }}
            className="rounded-sm px-2 py-1 text-xs text-text-primary hover:bg-bg-primary disabled:opacity-40 @max-[920px]:px-1.5"
          >
            <AppIcon name="previous-page" size={13} />
          </button>

          <form onSubmit={handlePageSubmit} className="flex items-center gap-1 px-1">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              data-testid="page-number-input"
              aria-label="Page number"
              value={pageInput}
              onChange={(e) => {
                setPageInput(e.target.value);
              }}
              onBlur={handlePageSubmit}
              className="w-10 @max-[920px]:w-8 rounded border border-border-subtle bg-bg-primary px-1 py-0.5 text-center text-xs text-text-primary focus:border-accent focus:outline-hidden"
            />
            <span data-testid="total-pages" className="text-text-secondary text-2xs">
              / {pageCount}
            </span>
          </form>

          <button
            type="button"
            data-testid="next-page-button"
            aria-label="Next page"
            disabled={currentPage >= pageCount}
            onClick={() => {
              void goToPage(currentPage + 1);
            }}
            className="rounded-sm px-2 py-1 text-xs text-text-primary hover:bg-bg-primary disabled:opacity-40 @max-[920px]:px-1.5"
          >
            <AppIcon name="next-page" size={13} />
          </button>
        </div>

        <div className="relative">
          <button
            ref={displaySettingsButtonRef}
            type="button"
            data-testid="document-settings-button"
            aria-expanded={displaySettingsOpen}
            aria-controls="document-settings-popover"
            aria-haspopup="dialog"
            aria-label="Display settings"
            onClick={() => {
              if (displaySettingsOpen) {
                setDisplaySettingsOpen(false);
                window.queueMicrotask(() => { displaySettingsButtonRef.current?.focus(); });
              } else {
                setDisplaySettingsOpen(true);
              }
            }}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors @max-[920px]:px-1.5 ${
              displaySettingsOpen
                ? 'border-accent bg-accent/10 text-accent font-semibold'
                : 'border-border-subtle bg-bg-surface text-text-secondary hover:text-text-primary'
            }`}
            title="Document display settings (line spacing, margins, zoom)"
          >
            <AppIcon name="display-settings" size={14} />
            <span className="@max-[920px]:hidden">Display settings</span>
          </button>
          {displaySettingsPresence.present && (
            <div
              ref={displaySettingsPanelRef}
              {...phaseAttributes(displaySettingsPresence.phase)}
              id="document-settings-popover"
              data-top-layer="popover"
              data-testid="document-settings-popover"
              role="dialog"
              aria-modal="false"
              aria-labelledby="document-settings-label"
              tabIndex={-1}
              className="ui-popover absolute right-0 top-full z-40 mt-2 w-64 origin-top-right rounded-md border border-border-subtle bg-bg-surface-elevated p-3 shadow-popover focus:outline-none"
            >
              <p id="document-settings-label" className="mb-2 block text-left text-xs font-semibold text-text-primary">Document settings</p>

              <label htmlFor="line-spacing-select" className="mt-1 block text-left text-xs font-medium text-text-secondary">Line spacing</label>
              <Select
                id="line-spacing-select"
                data-testid="line-spacing-select"
                aria-label="Line spacing"
                disabled={!isReflowable}
                value={String(reflowLineHeight)}
                options={LINE_SPACING_OPTIONS}
                onValueChange={(value) => { void setReflowLineHeight(Number.parseFloat(value)); }}
                wrapperClassName="mt-1"
                size="sm"
              />
              {!isReflowable && (
                <p className="mt-1 text-2xs text-text-secondary">Line spacing applies to reflowable formats.</p>
              )}

              <label htmlFor="reader-margin-select" className="mt-3 block text-left text-xs font-medium text-text-secondary">Reading margins</label>
              <Select
                id="reader-margin-select"
                data-testid="reader-margin-select"
                aria-label="Reading margins"
                disabled={!isReflowable}
                value={String(reflowHorizontalMarginRem)}
                options={MARGIN_OPTIONS}
                onValueChange={(value) => { void setReflowHorizontalMargin(Number.parseFloat(value)); }}
                wrapperClassName="mt-1"
                size="sm"
              />
              {!isReflowable && (
                <p className="mt-1 text-2xs text-text-secondary">Margins apply to reflowable formats.</p>
              )}

              <label htmlFor="zoom-mode-select" className="mt-3 block text-left text-xs font-medium text-text-secondary">Zoom preset</label>
              <Select
                id="zoom-mode-select"
                data-testid="zoom-mode-select"
                aria-label="Zoom level"
                value={zoomSelectValue(zoomMode, zoom)}
                options={zoomOptions(zoomMode, zoom)}
                onValueChange={handleZoomSelect}
                wrapperClassName="mt-1"
                size="sm"
              />

              <div className="mt-3 flex items-center gap-1 rounded-md border border-border-subtle bg-bg-surface p-0.5">
                <button
                  type="button"
                  data-testid="zoom-out-button"
                  aria-label="Zoom out"
                  onClick={() => {
                    void zoomOut();
                  }}
                  className="rounded-sm px-2 py-1 text-xs text-text-primary hover:bg-bg-primary"
                  title="Zoom Out (Ctrl+-)"
                >
                  <AppIcon name="zoom-out" size={13} />
                </button>
                <span data-testid="zoom-percentage" className="flex-1 text-center text-2xs text-text-secondary">{formattedZoomPercentage}</span>
                <button
                  type="button"
                  data-testid="zoom-in-button"
                  aria-label="Zoom in"
                  onClick={() => {
                    void zoomIn();
                  }}
                  className="rounded-sm px-2 py-1 text-xs text-text-primary hover:bg-bg-primary"
                  title="Zoom In (Ctrl++)"
                >
                  <AppIcon name="zoom-in" size={13} />
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          data-testid="add-bookmark-button"
          aria-label="Add Bookmark"
          onClick={() => { void addBookmark(); }}
          className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-xs font-medium text-text-secondary hover:border-accent hover:text-text-primary"
        >
          <AppIcon name="bookmark" size={14} />
          <span className="@max-[920px]:hidden">Bookmark</span>
        </button>
        <div className="relative">
          <button
            ref={locationNoteButtonRef}
            type="button"
            aria-expanded={locationNoteOpen}
            aria-controls="location-note-popover"
            aria-label="Add note"
            onClick={() => {
              if (locationNoteOpen) {
                setLocationNoteOpen(false);
                window.queueMicrotask(() => { locationNoteButtonRef.current?.focus(); });
              } else {
                setLocationNoteOpen(true);
              }
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-xs font-medium text-text-secondary hover:border-accent hover:text-text-primary"
          >
            <AppIcon name="add-note" size={14} />
            <span className="@max-[920px]:hidden">Note</span>
          </button>
          {locationNotePresence.present && (
            <div
              ref={locationNotePanelRef}
              {...phaseAttributes(locationNotePresence.phase)}
              id="location-note-popover"
              data-top-layer="popover"
              role="dialog"
              aria-modal="false"
              aria-labelledby="location-note-label"
              className="ui-popover absolute right-0 top-full z-40 mt-2 w-72 origin-top-right rounded-md border border-border-subtle bg-bg-surface-elevated p-3 shadow-popover"
            >
              <label id="location-note-label" htmlFor="location-note" className="block text-left text-xs font-medium text-text-primary">Note at current location</label>
              <textarea
                id="location-note"
                autoFocus
                maxLength={100_000}
                value={locationNoteDraft}
                onChange={(event) => { setLocationNoteDraft(event.target.value); }}
                onKeyDown={(event) => {
                  handleNoteSaveShortcut(event, canSaveLocationNote, () => { void addLocationNote(); });
                }}
                className="mt-1 h-24 w-full resize-y rounded-md border border-border-subtle bg-bg-surface p-2 text-xs text-text-primary"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <span className="mr-auto text-2xs text-text-secondary" data-testid="location-note-shortcut-hint">
                  {NOTE_SAVE_SHORTCUT_HINT}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLocationNoteOpen(false);
                    window.queueMicrotask(() => { locationNoteButtonRef.current?.focus(); });
                  }}
                  className="rounded px-2 py-1 text-text-secondary"
                >Cancel</button>
                <button
                  type="button"
                  disabled={!canSaveLocationNote}
                  onClick={() => { void addLocationNote(); }}
                  className="rounded bg-accent px-2 py-1 font-medium text-on-accent disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        {readerReady && (
          <button
            type="button"
            data-testid="reader-focus-button"
            aria-label="Enter distraction-free focus mode"
            aria-pressed={focusMode}
            onClick={() => { toggleFocusMode(readerReady); }}
            className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-accent hover:bg-bg-primary hover:text-text-primary"
            title="Focus Mode (Esc)"
          >
            <AppIcon name="focus-mode" size={14} />
            <span className="@max-[920px]:hidden">Focus</span>
          </button>
        )}
      </div>
      </header>
    </div>
  );
}
