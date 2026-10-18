import { HIGHLIGHT_COLOR_CONFIGS, HIGHLIGHT_COLOR_OPTIONS, type HighlightColorConfig } from '@shared/constants/annotations';
import { reportRejection } from '@shared/models/caught-error';
import { hasParagraphFormat, type ParagraphFormat } from '@shared/document-format-family';
import { useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationSort, AnnotationType } from '@shared/types/annotation';
import { AppIcon } from '../../components/AppIcon';
import { useAnnotationStore } from '../../stores/use-annotation-store';
import { selectActiveDocument, selectAdapter, useReaderStore } from '../../stores/use-reader-store';
import {
  NOTE_SAVE_SHORTCUT_HINT,
  handleNoteSaveShortcut,
} from '../../hooks/note-save-shortcut';
import { anchorToLocation } from '../reader/annotations/dom-anchors';
import { AnnotationBody } from './AnnotationBody';
import { REVEAL_VIEW, annotationPageKey, useAnnotationReveal } from './use-annotation-reveal';
import {
  ANNOTATION_ROW,
  ANNOTATION_ROW_ACTIONS,
  ANNOTATION_ROW_CONTENT,
  ANNOTATION_ROW_PRIMARY_TEXT,
} from './annotation-row-styles';
import { bridge } from '../../app/api-client';
import { Select } from '../../components/ui/select';
import {
  MENU_CHECK_SLOT_CLASS,
  MENU_DANGER_ITEM_CLASS,
  MENU_SURFACE_CLASS,
  dismissMenuOnKey,
  phaseAttributes,
  usePopoverPresence,
} from '../../components/ui/popover-presence';
import type { SelectOption } from '../../components/ui/select-model';

type TypeFilter = AnnotationType | 'all';

const ANNOTATION_SORT_OPTIONS: readonly SelectOption<AnnotationSort>[] = [
  { value: 'updated_desc', label: 'Recent' },
  { value: 'created_desc', label: 'Newest' },
  { value: 'created_asc', label: 'Oldest' },
];

function paragraphAnchorLabel(anchor: Extract<Annotation['anchor'], { readonly format: ParagraphFormat }>): string {
  const page = String((anchor.renderedPageIndex ?? 0) + 1);
  if (anchor.format === 'pptx') return `Slide ${page}`;
  if (anchor.segments && anchor.segments.length > 1) {
    const first = anchor.segments[0];
    const last = anchor.segments[anchor.segments.length - 1];
    const firstPara = (first?.paragraphIndex ?? 0) + 1;
    const lastPara = (last?.paragraphIndex ?? 0) + 1;
    return `Page ${page} · paragraphs ${String(firstPara)}–${String(lastPara)}`;
  }
  return `Page ${page} · paragraph ${String(anchor.paragraphIndex + 1)}`;
}

/** Full wording, used where a control needs an unambiguous accessible name. */
function locationLabel(annotation: Annotation): string {
  const anchor = annotation.anchor;
  if (anchor.format === 'pdf') {
    if (anchor.segments && anchor.segments.length > 1) {
      const first = anchor.segments[0];
      const last = anchor.segments[anchor.segments.length - 1];
      const firstLabel = first?.pageLabel ?? String((first?.pageIndex ?? 0) + 1);
      const lastLabel = last?.pageLabel ?? String((last?.pageIndex ?? 0) + 1);
      return firstLabel !== lastLabel ? `Pages ${firstLabel}–${lastLabel}` : `Page ${firstLabel}`;
    }
    return anchor.pageLabel ? `Page ${anchor.pageLabel}` : `Page ${String(anchor.pageIndex + 1)}`;
  }
  if (hasParagraphFormat(anchor)) return paragraphAnchorLabel(anchor);
  if (anchor.format === 'markdown') {
    if (anchor.segments && anchor.segments.length > 1) {
      const first = anchor.segments[0];
      const last = anchor.segments[anchor.segments.length - 1];
      const firstBlock = (first?.blockIndex ?? 0) + 1;
      const lastBlock = (last?.blockIndex ?? 0) + 1;
      return `Blocks ${String(firstBlock)}–${String(lastBlock)}`;
    }
    return `Block ${String(anchor.blockIndex + 1)}`;
  }
  if (anchor.format === 'mobi') return `Section ${String(anchor.sectionIndex + 1)}`;
  return anchor.spineHref ? `Section ${anchor.spineHref}` : 'EPUB location';
}

/**
 * Whether the annotation's text anchor could not be found on the live page.
 * A bookmark marks a place rather than a passage, so it has no text to lose:
 * the page it names is where it goes, and it is never offered re-attachment.
 */
function lostItsPlace(annotation: Annotation): boolean {
  return annotation.type !== 'bookmark' && annotation.status !== 'anchored';
}

/** A bookmark's action says where it goes; other rows jump to their passage. */
function jumpLabel(annotation: Annotation): string {
  return annotation.type === 'bookmark' ? 'Go to page' : 'Jump';
}

function jumpAccessibleName(annotation: Annotation): string | undefined {
  return annotation.type === 'bookmark' ? `Go to ${locationLabel(annotation)}` : undefined;
}

function typeLabel(annotation: Annotation): string {
  if (annotation.type === 'highlight') return `${annotation.color ?? 'Unknown'} highlight`;
  if (annotation.type === 'bookmark') return 'Bookmark';
  return annotation.isLocationNote ? 'Location note' : 'Text note';
}

/** Single word naming the row's kind on its metadata line. */
function metaTypeLabel(annotation: Annotation): string {
  if (annotation.type === 'highlight') return 'Highlight';
  if (annotation.type === 'bookmark') return 'Bookmark';
  return 'Note';
}

function highlightConfig(color: Annotation['color']): HighlightColorConfig {
  return HIGHLIGHT_COLOR_CONFIGS[color ?? 'yellow'];
}

/**
 * The edge rail carries the annotation's own marker colour, so a row is
 * identifiable before a word of it is read. An annotation that lost its place
 * gives the rail up to the warning colour instead: that is the one thing about
 * a row worth saying before its contents.
 */
function railColor(annotation: Annotation, color: HighlightColorConfig): string {
  if (annotation.status !== 'anchored') return 'var(--color-warning)';
  if (annotation.type === 'highlight') return color.hexValue;
  return 'var(--color-text-primary)';
}

const PAGE_SIZE = 50;

const CHIP_BASE =
  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs leading-none focus:outline-none focus:ring-2 focus:ring-focus-ring';
const CHIP_ACTIVE = 'bg-text-primary font-medium text-bg-primary';
const CHIP_IDLE = 'border border-border-subtle text-text-secondary hover:text-text-primary';
const ACTION_PRIMARY =
  'rounded text-xs font-medium leading-none text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-focus-ring';
const ACTION_SECONDARY =
  'rounded text-xs leading-none text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring';

/**
 * Reference 4a: the note's own ink leads each row, the quote it came from is
 * demoted to supporting text, and the annotation's colour lives on an edge rail
 * instead of a badge. Anchoring is only spoken about when it broke — a working
 * anchor is the expectation, so it gets no chrome.
 */
export function AnnotationBrowser() {
  const activeDocument = useReaderStore(selectActiveDocument);
  const adapter = useReaderStore(selectAdapter);
  const goToLocation = useReaderStore((state) => state.goToLocation);
  const overlayError = useAnnotationStore((state) => state.error);
  const mutationRevision = useAnnotationStore((state) => state.mutationRevision);
  const update = useAnnotationStore((state) => state.update);
  const remove = useAnnotationStore((state) => state.remove);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [sort, setSort] = useState<AnnotationSort>('updated_desc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Shared by the Save button and the Cmd/Ctrl+Enter shortcut so a second
  // press while the update is in flight cannot write the edit twice.
  const [savingEdit, setSavingEdit] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [items, setItems] = useState<readonly Annotation[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Readonly<Record<AnnotationType, number>> | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [reattachNotice, setReattachNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  /**
   * Identifies the request the rendered rows came from, recorded only when a
   * page settles. A reveal waits for this to name its own document and view,
   * which is what keeps a superseded, foreign or failed page from standing in
   * for the row it is waiting on.
   */
  const [pageKey, setPageKey] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useAnnotationReveal({
    items,
    listRef,
    pageKey,
    documentId: activeDocument?.id ?? null,
    normalizeView: () => {
      setQuery(REVEAL_VIEW.query);
      setType(REVEAL_VIEW.type);
      setSort(REVEAL_VIEW.sort);
      setPageIndex(REVEAL_VIEW.pageIndex);
    },
  });

  useEffect(() => {
    setPageIndex(0);
  }, [activeDocument?.id, query, sort, type]);

  useEffect(() => {
    if (!activeDocument) return;
    let cancelled = false;
    setIsLoading(true);
    setBrowserError(null);
    // Recorded only on success, so a failed page leaves the previously
    // rendered rows described by the key they actually came from.
    const key = annotationPageKey(activeDocument.id, { query, type, sort, pageIndex });
    const timer = window.setTimeout(() => {
      void reportRejection(bridge.annotations.page(activeDocument.id, {
        offset: pageIndex * PAGE_SIZE,
        limit: PAGE_SIZE,
        sort,
        ...(type === 'all' ? {} : { type }),
        ...(query.trim() ? { searchQuery: query.trim() } : {}),
      }).then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
        setIsLoading(false);
        setPageKey(key);
      }), (caught) => {
        if (cancelled) return;
        setBrowserError(caught === null ? 'Could not load annotations.' : caught.message);
        setIsLoading(false);
      });
    }, query ? 150 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeDocument, mutationRevision, pageIndex, query, sort, type]);

  /**
   * Chip counts are read from the same store as the list, one bounded count
   * query per type, rather than counted from whatever happens to be loaded in
   * the overlay: the overlay list is scoped and capped, so counting it would
   * quietly understate a large document.
   */
  useEffect(() => {
    if (!activeDocument) return;
    let cancelled = false;
    const searchQuery = query.trim();
    const timer = window.setTimeout(() => {
      void Promise.all(
        (['highlight', 'note', 'bookmark'] as const).map((countType) =>
          bridge.annotations.page(activeDocument.id, {
            offset: 0,
            limit: 1,
            sort: 'updated_desc',
            type: countType,
            ...(searchQuery ? { searchQuery } : {}),
          }).then((page) => page.total)
        )
      ).then(([highlight = 0, note = 0, bookmark = 0]) => {
        if (cancelled) return;
        setCounts({ highlight, note, bookmark });
      }).catch(() => {
        // A failed count must not blank the list; the chips simply omit counts.
        if (!cancelled) setCounts(null);
      });
    }, query ? 150 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeDocument, mutationRevision, query]);

  const jump = async (annotation: Annotation): Promise<void> => {
    if (adapter) await adapter.goToAnnotation(annotation);
    else await goToLocation(anchorToLocation(annotation.anchor));
  };

  /**
   * The re-attach route is the reader itself: opening the recorded location
   * makes the adapter resolve this annotation against the live page, and a
   * successful resolution is written back through the existing repair path. No
   * claim is made that re-attaching always succeeds — if the text really is
   * gone, the note stays flagged and readable.
   */
  const reattach = async (annotation: Annotation): Promise<void> => {
    setReattachNotice(null);
    await jump(annotation);
    setReattachNotice(
      'Opened the recorded location. If the moved text is on that page, its place is restored automatically.'
    );
  };

  const beginEdit = (annotation: Annotation): void => {
    setOpenMenuId(null);
    setEditingId(annotation.id);
    setSavingEdit(false);
    setDraft(annotation.type === 'bookmark' ? annotation.label ?? '' : annotation.note ?? '');
  };

  /**
   * The one save path for the inline editor. The Save button and the
   * Cmd/Ctrl+Enter shortcut both call exactly this, so the per-type validation
   * — a note may not be emptied, a highlight note or bookmark label may — holds
   * whichever way the reader commits the edit.
   */
  const saveEdit = async (annotation: Annotation): Promise<void> => {
    if (savingEdit) return;
    const trimmed = draft.trim();
    setSavingEdit(true);
    const result = await (annotation.type === 'bookmark'
      ? update({ documentId: annotation.documentId, id: annotation.id, label: trimmed.length > 0 ? trimmed : null })
      : annotation.type === 'highlight'
        ? update({ documentId: annotation.documentId, id: annotation.id, note: trimmed.length > 0 ? trimmed : null })
        : trimmed
          ? update({ documentId: annotation.documentId, id: annotation.id, note: trimmed })
          : Promise.resolve(null)
    ).finally(() => { setSavingEdit(false); });
    if (result) setEditingId(null);
  };

  /** Mirrors the Save button's own disabled condition, plus "not already saving". */
  const canSaveEdit = (annotation: Annotation): boolean =>
    !savingEdit && !(annotation.type === 'note' && draft.trim().length === 0);

  if (!activeDocument) {
    return <p className="p-4 text-sm text-text-secondary">Open a document to browse its annotations.</p>;
  }

  const chipCount = (chip: TypeFilter): string => {
    if (counts === null) return '';
    if (chip === 'all') return String(counts.highlight + counts.note + counts.bookmark);
    return String(counts[chip]);
  };

  const filterChips: readonly { readonly id: TypeFilter; readonly label: string; readonly swatch?: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'highlight', label: 'Highlights', swatch: HIGHLIGHT_COLOR_CONFIGS.yellow.hexValue },
    { id: 'note', label: 'Notes' },
    { id: 'bookmark', label: 'Bookmarks' },
  ];

  return (
    <section
      aria-labelledby="annotations-heading"
      data-testid="annotation-browser"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-3 pt-4">
        <div className="flex items-baseline gap-2">
          <h2
            id="annotations-heading"
            className="mr-auto text-lg font-semibold leading-tight tracking-[-0.015em] text-text-primary"
          >
            Annotations
          </h2>
          <p
            data-testid="annotation-count-label"
            title={activeDocument.title}
            className="min-w-0 truncate text-2xs leading-none text-text-secondary"
          >
            {String(total)} in this document
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-bg-surface px-3 py-2 focus-within:ring-2 focus-within:ring-focus-ring">
          <AppIcon name="search" size={13} className="shrink-0 text-text-secondary" />
          <label htmlFor="annotation-search" className="sr-only">Search annotations</label>
          <input
            id="annotation-search"
            type="search"
            value={query}
            maxLength={200}
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder="Quote, note, label…"
            className="min-w-0 flex-1 bg-transparent text-sm leading-none text-text-primary placeholder:text-text-secondary focus:outline-none"
          />
        </div>

        <div data-testid="annotation-filter-chips" className="flex flex-wrap items-center gap-1.5">
          {filterChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={type === chip.id}
              onClick={() => { setType(chip.id); }}
              className={`${CHIP_BASE} ${type === chip.id ? CHIP_ACTIVE : CHIP_IDLE}`}
            >
              {chip.swatch !== undefined && (
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: chip.swatch }} />
              )}
              {chip.label}
              {chipCount(chip.id) && <span className="tabular-nums">{chipCount(chip.id)}</span>}
            </button>
          ))}
          <Select
            variant="inline"
            id="annotation-sort"
            aria-label="Sort annotations"
            value={sort}
            options={ANNOTATION_SORT_OPTIONS}
            onValueChange={setSort}
            wrapperClassName="ml-auto"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
        {(browserError ?? overlayError) && (
          <p role="alert" className="m-4 rounded-md border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
            {browserError ?? overlayError}
          </p>
        )}
        {reattachNotice !== null && (
          <p role="status" data-testid="annotation-reattach-notice" className="mx-4 mt-3 text-2xs text-text-secondary">
            {reattachNotice}
          </p>
        )}
        {isLoading && <p role="status" className="p-4 text-xs text-text-secondary">Loading annotations…</p>}
        {!isLoading && items.length === 0 && (
          <p className="m-4 rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-text-secondary">
            {total === 0 && !query && type === 'all'
              ? 'Select text, add a note, or bookmark a location to begin.'
              : 'No annotations match these filters.'}
          </p>
        )}

        {/* `overflow-anchor:none` keeps the browser's own scroll anchoring from
            re-pinning the row that was visible before the refresh, which would
            immediately undo the reveal above. */}
        <ol
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
          aria-label="Saved annotations"
          data-testid="annotation-page-list"
        >
          {items.map((annotation) => {
            const color = highlightConfig(annotation.color);
            const isHighlight = annotation.type === 'highlight';
            const isUnanchored = lostItsPlace(annotation);
            // A quote inside a highlight keeps the marker; a quote under a note
            // is supporting text and stays unpainted.
            const quoteMarker = isHighlight
              ? { 'data-testid': 'annotation-quote-marker', style: { background: color.cssRgba } }
              : {};
            return (
              <li
                key={annotation.id}
                data-testid="annotation-row"
                data-annotation-status={annotation.status}
                className={ANNOTATION_ROW}
              >
                <span
                  aria-hidden="true"
                  data-testid="annotation-rail"
                  className="w-[3px] shrink-0 rounded-full"
                  style={{ background: railColor(annotation, color) }}
                />
                <div className={ANNOTATION_ROW_CONTENT}>
                  {/* Plain words, as everywhere else: "Note · Block 3", not
                      an abbreviated uppercase code. */}
                  <div className="flex items-baseline gap-1.5">
                    <span
                      data-testid="annotation-meta-type"
                      className="text-2xs font-medium leading-none text-text-secondary"
                    >
                      {metaTypeLabel(annotation)}
                    </span>
                    <span aria-hidden="true" className="text-2xs leading-none text-text-secondary">·</span>
                    <span
                      data-testid="annotation-meta-location"
                      className="min-w-0 truncate text-2xs leading-none text-text-secondary"
                    >
                      {locationLabel(annotation)}
                    </span>
                    <AnnotationRowMenu
                      annotation={annotation}
                      isOpen={openMenuId === annotation.id}
                      onOpenChange={(open) => { setOpenMenuId(open ? annotation.id : null); }}
                      onDelete={() => {
                        if (window.confirm('Delete this annotation? This cannot be undone.')) {
                          void remove(annotation.documentId, annotation.id);
                        }
                      }}
                    />
                  </div>

                  {editingId === annotation.id ? (
                    <div>
                      <label htmlFor={`annotation-edit-${annotation.id}`} className="text-2xs font-medium text-text-secondary">
                        {annotation.type === 'bookmark' ? 'Bookmark label' : 'Note text'}
                      </label>
                      <textarea
                        id={`annotation-edit-${annotation.id}`}
                        autoFocus
                        maxLength={annotation.type === 'bookmark' ? 500 : 100_000}
                        value={draft}
                        onChange={(event) => { setDraft(event.target.value); }}
                        onKeyDown={(event) => {
                          handleNoteSaveShortcut(event, canSaveEdit(annotation), () => { void saveEdit(annotation); });
                        }}
                        className="mt-1 h-20 w-full resize-y rounded-md border border-border-subtle bg-bg-primary p-2 text-xs text-text-primary"
                      />
                      <div className="mt-1 flex items-center justify-end gap-2">
                        <span className="mr-auto text-2xs text-text-secondary" data-testid="annotation-edit-shortcut-hint">
                          {NOTE_SAVE_SHORTCUT_HINT}
                        </span>
                        <button type="button" onClick={() => { setEditingId(null); }} className="rounded px-2 py-1 text-xs text-text-secondary">Cancel</button>
                        <button
                          type="button"
                          disabled={!canSaveEdit(annotation)}
                          onClick={() => { void saveEdit(annotation); }}
                          className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-40"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* The note's own words lead; the passage it came from supports them. */}
                      <AnnotationBody annotation={annotation} />

                      {annotation.selectedText && (
                        annotation.note === null && isHighlight ? (
                          <p data-testid="annotation-quote" className={ANNOTATION_ROW_PRIMARY_TEXT}>
                            <span
                              data-testid="annotation-quote-marker"
                              className="box-decoration-clone px-0 py-px"
                              style={{ background: color.cssRgba }}
                            >
                              “{annotation.selectedText}”
                            </span>
                          </p>
                        ) : (
                          <blockquote
                            data-testid="annotation-quote"
                            className="line-clamp-4 border-l-2 border-border-subtle pl-2.5 text-xs leading-[1.5] text-text-secondary [overflow-wrap:anywhere]"
                          >
                            <span {...quoteMarker}>“{annotation.selectedText}”</span>
                          </blockquote>
                        )
                      )}

                      {isUnanchored && (
                        <p
                          data-testid="annotation-unanchored-warning"
                          className="rounded-md bg-warning/10 px-2 py-2 text-2xs font-medium leading-[1.3] text-warning"
                        >
                          Text moved — this {metaTypeLabel(annotation).toLowerCase()} lost its place
                          in the page
                        </p>
                      )}

                      <div data-testid="annotation-row-actions" className={ANNOTATION_ROW_ACTIONS}>
                        {isUnanchored ? (
                          <>
                            <button type="button" onClick={() => { beginEdit(annotation); }} className={ACTION_SECONDARY}>
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => { void reattach(annotation); }}
                              aria-label={`Re-attach ${typeLabel(annotation)} by opening ${locationLabel(annotation)}`}
                              className={ACTION_PRIMARY}
                            >
                              Re-attach
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => { void jump(annotation); }}
                              aria-label={jumpAccessibleName(annotation)}
                              className={ACTION_PRIMARY}
                            >
                              {jumpLabel(annotation)}
                            </button>
                            <button type="button" onClick={() => { beginEdit(annotation); }} className={ACTION_SECONDARY}>
                              {isHighlight && !annotation.note ? 'Add note' : 'Edit'}
                            </button>
                          </>
                        )}

                        {isHighlight && (
                          // The painted swatch stays 13px, but the thing a
                          // finger has to hit is the 24x24 button around it, and
                          // the gap is dropped so neighbouring centres land
                          // exactly 24px apart (WCAG 2.2 SC 2.5.8). The negative
                          // margin pulls the last button's slack back so the
                          // swatches themselves still sit where they did.
                          <span className="-mr-1.5 ml-auto flex shrink-0 items-center">
                            {HIGHLIGHT_COLOR_OPTIONS.map((option) => {
                              const selected = (annotation.color ?? 'yellow') === option.id;
                              return (
                                <button
                                  key={option.id}
                                  type="button"
                                  data-testid="annotation-color-swatch"
                                  aria-pressed={selected}
                                  aria-label={`${option.label} highlight for ${locationLabel(annotation)}`}
                                  onClick={() => {
                                    void update({
                                      documentId: annotation.documentId,
                                      id: annotation.id,
                                      color: option.id,
                                    });
                                  }}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                                >
                                  <span
                                    aria-hidden="true"
                                    className={
                                      'h-[13px] w-[13px] rounded-sm ' +
                                      (selected
                                        ? 'ring-2 ring-text-primary ring-offset-2 ring-offset-bg-primary'
                                        : '')
                                    }
                                    style={{ background: option.hexValue }}
                                  />
                                </button>
                              );
                            })}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {total > PAGE_SIZE && (
        <nav aria-label="Annotation pages" className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-4 py-2">
          <button
            type="button"
            disabled={pageIndex === 0 || isLoading}
            onClick={() => { setPageIndex((value) => Math.max(0, value - 1)); }}
            className="rounded border border-border-subtle px-2 py-1 text-xs disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-text-secondary" aria-live="polite">
            Page {String(pageIndex + 1)} of {String(Math.ceil(total / PAGE_SIZE))}
          </span>
          <button
            type="button"
            disabled={(pageIndex + 1) * PAGE_SIZE >= total || isLoading}
            onClick={() => { setPageIndex((value) => value + 1); }}
            className="rounded border border-border-subtle px-2 py-1 text-xs disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

/**
 * The row's overflow actions. Destructive work lives here rather than in the
 * row itself, so a crowded row cannot put Delete under a mis-aimed click, and
 * the menu stays a normal keyboard surface: Escape closes it and returns focus
 * to the trigger that opened it.
 */
function AnnotationRowMenu({
  annotation,
  isOpen,
  onOpenChange,
  onDelete,
}: {
  readonly annotation: Annotation;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const presence = usePopoverPresence(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => { document.removeEventListener('pointerdown', handlePointerDown); };
  }, [isOpen, onOpenChange]);

  const close = (returnFocus: boolean): void => {
    onOpenChange(false);
    if (returnFocus) window.queueMicrotask(() => { triggerRef.current?.focus(); });
  };

  return (
    <span className="relative ml-auto shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="annotation-row-menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`More actions for ${typeLabel(annotation)} at ${locationLabel(annotation)}`}
        onClick={() => { onOpenChange(!isOpen); }}
        className="rounded p-0.5 text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        <AppIcon name="more-horizontal" size={13} />
      </button>
      {presence.present && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${typeLabel(annotation)} at ${locationLabel(annotation)}`}
          onKeyDown={(event) => { dismissMenuOnKey(event, () => { close(false); }, triggerRef.current); }}
          {...phaseAttributes(presence.phase)}
          className={`${MENU_SURFACE_CLASS} absolute right-0 top-full z-20 mt-1 min-w-32 origin-top-right`}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              close(true);
              onDelete();
            }}
            className={MENU_DANGER_ITEM_CLASS}
          >
            <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS} />
            Delete
          </button>
        </div>
      )}
    </span>
  );
}
