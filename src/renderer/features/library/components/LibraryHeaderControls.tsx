import { useLayoutEffect, useState, type ReactElement } from 'react';
import { AppIcon } from '../../../components/AppIcon';
import { Select } from '../../../components/ui/select';
import { useLibraryStore } from '../../../stores/use-library-store';
import { FORMAT_FILTER_OPTIONS, SORT_OPTIONS } from '../library-select-options';

type StripOverflow = { readonly start: boolean; readonly end: boolean };

const NO_OVERFLOW: StripOverflow = { start: false, end: false };

/**
 * Which edges of a horizontal scroller have content past them. Remeasured on
 * scroll and whenever the strip or one of its controls changes size (the
 * search field widens on focus and with a query, so content can grow while
 * the strip itself does not).
 */
function useStripOverflow(strip: HTMLElement | null): StripOverflow {
  const [overflow, setOverflow] = useState<StripOverflow>(NO_OVERFLOW);

  useLayoutEffect(() => {
    if (strip === null) return undefined;
    const measure = (): void => {
      const start = strip.scrollLeft > 1;
      const end = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1;
      setOverflow((current) => (current.start === start && current.end === end ? current : { start, end }));
    };
    measure();
    strip.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    for (const child of Array.from(strip.children)) observer?.observe(child);
    return () => {
      strip.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [strip]);

  return overflow;
}

/**
 * The library header's filters: search, format, sort and the view toggle, as
 * one strip that scrolls rather than wraps. At ordinary desktop widths it is
 * at its natural size and nothing scrolls; when the window is narrow or zoomed
 * it gives up width instead of height, because the row must stay exactly as
 * tall as the companion tab bar beside it.
 *
 * The scrollbar stays hidden (a gutter would cost more of this row than it
 * explains), so an edge with controls past it fades, as the Settings rail does,
 * and a chevron beside it scrolls the strip there. While anything overflows,
 * both chevrons keep their place (the one with nothing past it is hidden), so
 * scrolling never changes the strip's width under a control focus has just
 * brought into view. Tab still reaches every control and scrolls it fully
 * into view; the chevrons are a pointer affordance and stay out of the tab
 * order.
 */
export function LibraryHeaderControls(): ReactElement {
  const viewMode = useLibraryStore((s) => s.viewMode);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const formatFilter = useLibraryStore((s) => s.formatFilter);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const setViewMode = useLibraryStore((s) => s.setViewMode);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const setFormatFilter = useLibraryStore((s) => s.setFormatFilter);
  const setSortBy = useLibraryStore((s) => s.setSortBy);

  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const overflow = useStripOverflow(strip);
  const overflowing = overflow.start || overflow.end;
  const scrollStrip = (direction: -1 | 1): void => {
    strip?.scrollBy({ left: direction * Math.max(48, strip.clientWidth * 0.8) });
  };

  return (
    <div className="flex min-w-0 shrink items-center">
      {overflowing && (
        <StripScrollButton direction={-1} hidden={!overflow.start} onScroll={scrollStrip} />
      )}
      <div
        ref={setStrip}
        data-testid="library-header-controls"
        data-overflow-start={overflow.start ? '' : undefined}
        data-overflow-end={overflow.end ? '' : undefined}
        className="library-header-controls flex min-w-0 shrink items-center gap-2 overflow-x-auto text-xs"
        onFocus={(event) => {
          revealFocused(event.currentTarget, event.target);
        }}
      >
        {/* Search bar. The one control that gives up width before the strip
            scrolls: at a 1280 px window it narrows instead of pushing the
            sort and view controls out of sight or cutting the title. Its
            placeholder is one word, and below the width that word and the
            field's padding need, the field shows only its icon rather than a
            cut word. Focused, it widens to read what is typed (the strip
            scrolls it into view if needed); holding a query, it keeps enough
            room to show its start. */}
        <div className="@container relative w-44 min-w-8 shrink focus-within:min-w-28 has-[input:not(:placeholder-shown)]:min-w-16">
          <AppIcon
            name="search"
            size={14}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-secondary"
          />
          <input
            type="search"
            aria-label="Search library by title or author"
            data-testid="library-search-input"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            placeholder="Search"
            className="w-full text-ellipsis rounded-md border border-border-subtle bg-bg-surface py-1.5 pr-2 pl-7 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-hidden @max-[5.75rem]:placeholder:text-transparent"
          />
        </div>

        <Select
          aria-label="Filter by document format"
          data-testid="format-filter-select"
          value={formatFilter}
          options={FORMAT_FILTER_OPTIONS}
          onValueChange={setFormatFilter}
          size="sm"
          wrapperClassName="shrink-0"
        />

        <Select
          aria-label="Sort documents"
          data-testid="sort-by-select"
          value={sortBy}
          options={SORT_OPTIONS}
          onValueChange={setSortBy}
          size="sm"
          wrapperClassName="shrink-0"
        />

        <div className="flex shrink-0 rounded-md border border-border-subtle bg-bg-surface p-0.5">
          <ViewToggle mode="grid" active={viewMode === 'grid'} onSelect={setViewMode} />
          <ViewToggle mode="list" active={viewMode === 'list'} onSelect={setViewMode} />
        </div>
      </div>
      {overflowing && (
        <StripScrollButton direction={1} hidden={!overflow.end} onScroll={scrollStrip} />
      )}
    </div>
  );
}

/** Width of the faded band at an edge with controls past it (see global.css). */
const STRIP_FADE_PX = 24;

/**
 * Scrolls a control that just took focus into the strip: clear of both faded
 * edges when it fits between them, whole and centred when it only fits the
 * strip, and from its start when it is wider than the strip. Chromium's own
 * focus scroll can leave a control that is already partly in view cut at the
 * strip's edge.
 */
function revealFocused(strip: HTMLElement, control: Element): void {
  const bounds = strip.getBoundingClientRect();
  const box = control.getBoundingClientRect();
  const clearance = Math.max(0, Math.min(STRIP_FADE_PX, (bounds.width - box.width) / 2));
  if (box.left < bounds.left + clearance || box.width > bounds.width) {
    strip.scrollLeft -= bounds.left + clearance - box.left;
  } else if (box.right > bounds.right - clearance) {
    strip.scrollLeft += box.right - (bounds.right - clearance);
  }
}

function StripScrollButton({
  direction,
  hidden,
  onScroll,
}: {
  readonly direction: -1 | 1;
  readonly hidden: boolean;
  readonly onScroll: (direction: -1 | 1) => void;
}): ReactElement {
  const forward = direction === 1;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={forward ? 'library-header-scroll-end' : 'library-header-scroll-start'}
      aria-label={forward ? 'Show more library controls' : 'Show earlier library controls'}
      title={forward ? 'More controls' : 'Earlier controls'}
      onClick={() => {
        onScroll(direction);
      }}
      className={`flex h-7 w-5 shrink-0 items-center justify-center rounded-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary ${hidden ? 'invisible' : ''}`}
    >
      <AppIcon name={forward ? 'next-page' : 'previous-page'} size={13} />
    </button>
  );
}

const VIEW_TOGGLE = {
  grid: { testId: 'grid-view-toggle', label: 'Grid View', icon: 'view-grid' },
  list: { testId: 'list-view-toggle', label: 'List View', icon: 'view-list' },
} as const;

function ViewToggle({
  mode,
  active,
  onSelect,
}: {
  readonly mode: keyof typeof VIEW_TOGGLE;
  readonly active: boolean;
  readonly onSelect: (mode: keyof typeof VIEW_TOGGLE) => void;
}): ReactElement {
  const toggle = VIEW_TOGGLE[mode];
  return (
    <button
      type="button"
      data-testid={toggle.testId}
      aria-label={toggle.label}
      onClick={() => {
        onSelect(mode);
      }}
      className={`rounded-sm px-2 py-1 ${
        active
          ? 'bg-bg-primary font-semibold text-text-primary shadow-2xs'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      <AppIcon name={toggle.icon} size={14} />
    </button>
  );
}
