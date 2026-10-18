import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AppIcon } from '../../../components/AppIcon';
import {
  MENU_CHECK_SLOT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SURFACE_CLASS,
  phaseAttributes,
  useModalPresence,
} from '../../../components/ui/popover-presence';
import type { DocumentMetadata, DocumentLocation, TableOfContentsItem } from '@shared/types/document';
import { selectActiveDocument, selectAdapter, useReaderStore } from '../../../stores/use-reader-store';
import { useChatStoreApi } from '../../../stores/use-chat-store';
import { useAgentStore } from '../../../stores/use-agent-store';
import { useUiStore } from '../../../stores/use-ui-store';
import type { DocumentAdapter } from '../types';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { takeCodePointPrefix } from '@shared/agent-context';
import {
  deriveTocContextRange,
  flattenTableOfContents,
  tocContextUnavailableMessage,
  tocRangeToChatDescriptor,
  tocRangeUnit,
  UNRESOLVED_TOC_DESTINATION_ERROR,
  type TocContextRange,
} from '../toc-context-range';

type MenuState = {
  readonly itemId: string;
  readonly x: number;
  readonly y: number;
};

type RangeText = {
  readonly text: string;
  readonly unitCount: number;
  readonly unitReferences: ReadonlyMap<number, string>;
  /** Section text was cut at the Agent context limit. */
  readonly truncated: boolean;
};

function unitForLocation(location: DocumentLocation): number | null {
  return tocRangeUnit(location);
}

type BoundedText = { readonly chunks: string[]; length: number; truncated: boolean };

/** Appends section text up to the Agent context limit, noting any cut. */
function appendBounded(text: BoundedText, chunk: string): void {
  const separatorLength = text.chunks.length > 0 ? 2 : 0;
  const remaining = Math.max(0, AGENT_MAX_CONTEXT_TEXT_LENGTH - text.length - separatorLength);
  const bounded = remaining > 0 ? takeCodePointPrefix(chunk, remaining) : '';
  if (bounded.length < chunk.length) text.truncated = true;
  if (bounded.length === 0) return;
  text.chunks.push(bounded);
  text.length += separatorLength + bounded.length;
}

async function extractRangeText(adapter: DocumentAdapter, range: TocContextRange): Promise<RangeText> {
  const startUnit = unitForLocation(range.startLocation);
  if (startUnit === null) return { text: '', unitCount: 0, unitReferences: new Map(), truncated: false };
  const boundaryUnit = range.nextBoundaryLocation === null ? null : unitForLocation(range.nextBoundaryLocation);
  const endUnit = boundaryUnit === null ? Number.POSITIVE_INFINITY : Math.max(startUnit, boundaryUnit - 1);
  const text: BoundedText = { chunks: [], length: 0, truncated: false };
  let highestUnit = startUnit;
  const unitReferences = new Map<number, string>();

  for await (const chunk of adapter.extractText()) {
    if (chunk.location.format !== range.startLocation.format) continue;
    const unit = unitForLocation(chunk.location);
    if (unit === null) continue;
    highestUnit = Math.max(highestUnit, unit);
    if (
      chunk.location.format === 'epub' &&
      unit >= startUnit &&
      unit <= endUnit &&
      chunk.location.spineHref &&
      !unitReferences.has(unit)
    ) {
      unitReferences.set(unit, chunk.location.spineHref);
    }
    if (unit >= startUnit && unit <= endUnit && chunk.text.trim().length > 0) appendBounded(text, chunk.text);
  }

  return { text: text.chunks.join('\n\n'), unitCount: highestUnit + 1, unitReferences, truncated: text.truncated };
}

function sectionLabel(range: TocContextRange, unitCount: number): string {
  const start = unitForLocation(range.startLocation) ?? 0;
  const boundary = range.nextBoundaryLocation === null ? null : unitForLocation(range.nextBoundaryLocation);
  const end = boundary === null ? Math.max(start, unitCount - 1) : Math.max(start, boundary - 1);
  const format = range.startLocation.format;
  const noun = format === 'docx' || format === 'pptx' ? 'Paragraph' : format === 'markdown' ? 'Block' : 'Section';
  const first = start + 1;
  const last = end + 1;
  return first === last ? `${noun} ${String(first)}` : `${noun}s ${String(first)}–${String(last)}`;
}

/** How an Agent trigger ended: superseded means a newer choice replaced it. */
type AgentAttachOutcome =
  | { readonly kind: 'attached' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'superseded' };

function clampMenuPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, Math.max(margin, window.innerWidth - width - margin))),
    y: Math.max(margin, Math.min(y, Math.max(margin, window.innerHeight - height - margin))),
  };
}

function OutlineNode({
  item,
  currentPage,
  onSelect,
  onOpenMenu,
  activeMenuItemId,
}: {
  readonly item: TableOfContentsItem;
  readonly currentPage: number;
  readonly onSelect: (item: TableOfContentsItem) => void;
  readonly onOpenMenu: (item: TableOfContentsItem, x: number, y: number, returnFocus?: HTMLElement | null) => void;
  readonly activeMenuItemId: string | null;
}) {
  const location = item.location;
  const isSelected =
    (location?.format === 'pdf' && location.pageIndex + 1 === currentPage) ||
    (location?.format === 'mobi' && location.sectionIndex + 1 === currentPage);
  // The document carries no resolvable destination for this entry. It stays in
  // the outline — removing it would hide a heading the book has — but it shows
  // no page and goes nowhere, because any page shown here would be invented.
  const unresolved = location === null;

  const paddingLeft = `${String(Math.min(item.level * 16 + 12, 64))}px`;

  const openFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenMenu(item, rect.left + Math.min(rect.width, 24), rect.bottom, event.currentTarget);
  };

  const openFromPointer = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    onOpenMenu(item, event.clientX, event.clientY, event.currentTarget);
  };

  return (
    <div className="flex flex-col" data-testid={`toc-row-${item.id}`}>
      <div className="flex min-w-0 items-stretch">
        <button
          type="button"
          data-testid={`toc-item-${item.id}`}
          data-destination={unresolved ? 'unresolved' : 'resolved'}
          aria-label={unresolved ? `${item.title} (no destination in this document)` : `Go to ${item.title}`}
          aria-disabled={unresolved}
          title={unresolved ? UNRESOLVED_TOC_DESTINATION_ERROR : undefined}
          onClick={() => { if (!unresolved) onSelect(item); }}
          onContextMenu={openFromPointer}
          onKeyDown={openFromKeyboard}
          style={{ paddingLeft }}
          className={`flex min-w-0 flex-1 items-center justify-between py-1.5 pr-1 text-left text-xs transition-colors hover:bg-bg-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring ${
            isSelected
              ? 'border-l-2 border-accent font-semibold text-accent bg-accent/5'
              : 'text-text-primary'
          }`}
        >
          <span className="truncate">{item.title}</span>
          {location?.format === 'pdf' && (
            <span data-testid={`toc-page-${item.id}`} className="ml-2 shrink-0 text-2xs text-text-secondary">
              {location.pageIndex + 1}
            </span>
          )}
          {unresolved && (
            <span data-testid={`toc-page-unavailable-${item.id}`} aria-hidden="true" className="ml-2 shrink-0 text-2xs text-text-secondary">
              —
            </span>
          )}
        </button>
        <button
          type="button"
          data-testid={`toc-menu-${item.id}`}
          aria-label={`More actions for ${item.title}`}
          aria-haspopup="menu"
          aria-expanded={activeMenuItemId === item.id}
          aria-controls={activeMenuItemId === item.id ? 'reader-toc-context-menu' : undefined}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(item, rect.right, rect.bottom, event.currentTarget);
          }}
          className="shrink-0 rounded-sm px-2 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
        >
          <AppIcon name="more-horizontal" size={14} />
        </button>
      </div>

      {item.children.length > 0 && (
        <div className="flex flex-col">
          {item.children.map((child) => (
            <OutlineNode
              key={child.id}
              item={child}
              currentPage={currentPage}
              onSelect={onSelect}
              onOpenMenu={onOpenMenu}
              activeMenuItemId={activeMenuItemId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ReaderOutlineSidebar() {
  const chatStore = useChatStoreApi();
  const tableOfContents = useReaderStore((s) => s.tableOfContents);
  const currentPage = useReaderStore((s) => s.currentPage);
  const pageCount = useReaderStore((s) => s.pageCount);
  const adapter = useReaderStore(selectAdapter);
  const activeDocument = useReaderStore(selectActiveDocument);
  const isTocOpen = useReaderStore((s) => s.isTocOpen);
  const setTocOpen = useReaderStore((s) => s.setTocOpen);
  const goToLocation = useReaderStore((s) => s.goToLocation);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const closeMenu = (restoreFocus = true): void => {
    setMenu(null);
    if (restoreFocus) window.queueMicrotask(() => { returnFocusRef.current?.focus(); });
  };

  const openMenu = (item: TableOfContentsItem, x: number, y: number, returnFocus?: HTMLElement | null): void => {
    returnFocusRef.current = returnFocus ?? null;
    setMenu({ itemId: item.id, x, y });
    setMenuPosition({ x, y });
  };

  useLayoutEffect(() => {
    if (menu === null || menuRef.current === null) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = clampMenuPosition(menu.x, menu.y, rect.width, rect.height);
    setMenuPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [menu]);

  useEffect(() => {
    if (menu === null) return;
    const handleOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }
    };
    const handleResize = (): void => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const next = clampMenuPosition(menu.x, menu.y, rect.width, rect.height);
      setMenuPosition((current) => current.x === next.x && current.y === next.y ? current : next);
    };
    document.addEventListener('pointerdown', handleOutsidePointer);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [menu]);

  useEffect(() => {
    if (!isTocOpen || activeDocument === null) closeMenu(false);
  }, [activeDocument, isTocOpen]);

  const selectedMenuItem = useMemo(
    () => menu === null
      ? null
      : flattenTableOfContents(tableOfContents).find(({ item }) => item.id === menu.itemId)?.item ?? null,
    [menu, tableOfContents],
  );
  // The menu keeps its section through the 100ms exit fade.
  const { shown: shownMenuItem, phase: menuPhase } = useModalPresence(selectedMenuItem);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (menu !== null && selectedMenuItem === null) closeMenu(false);
  }, [menu, selectedMenuItem]);
  const menuShown = selectedMenuItem !== null && shownMenuItem !== null;
  useEffect(() => {
    if (!menuShown) return;
    window.queueMicrotask(() => { menuItemRefs.current[0]?.focus(); });
  }, [menuShown, selectedMenuItem]);

  const showError = (destination: 'chat' | 'agent', message: string): void => {
    if (destination === 'chat') chatStore.setState({ error: message });
    else useAgentStore.setState({ error: message });
  };

  const addToChat = async (range: TocContextRange, document: DocumentMetadata): Promise<boolean> => {
    if (range.pageRange !== null) {
      return chatStore.getState().addPageRange(document, range.pageRange.start, range.pageRange.end);
    }
    if (adapter === null) {
      showError('chat', 'This section is unavailable because the document reader is not ready.');
      return false;
    }
    const extracted = await extractRangeText(adapter, range);
    if (!extracted.text.trim()) {
      showError('chat', 'This section has no readable text to attach to AI Chat.');
      return false;
    }
    const descriptor = tocRangeToChatDescriptor(range, extracted.unitCount, extracted.unitReferences);
    if (descriptor === null) {
      showError('chat', 'This document format does not provide a safe section context range.');
      return false;
    }
    return chatStore.getState().addSelectionContext(document, descriptor, false);
  };

  /**
   * Whether this book is still the one the reader has open, in the same
   * reader. A trigger's late completion speaks only to the book it came from:
   * in another one it opens no tab, moves no focus and shows no error.
   */
  const stillOpen = (document: DocumentMetadata, origin: DocumentAdapter | null): boolean => {
    const reader = useReaderStore.getState();
    return selectActiveDocument(reader)?.id === document.id && selectAdapter(reader) === origin;
  };

  const addToAgent = async (range: TocContextRange, document: DocumentMetadata): Promise<AgentAttachOutcome> => {
    // The store reports a failure here rather than in its own error, so this
    // trigger decides whether its book is still there to hear about it.
    const failure: { message: string | null } = { message: null };
    const options = { onFailure: (message: string) => { failure.message = message; } };
    const agent = useAgentStore.getState();
    const attached = range.pageRange !== null
      ? await agent.attachPageRange(document, range.pageRange.start, range.pageRange.end, undefined, options)
      : await agent.attachOutlineSection(document, range.startLocation, async (reader) => {
        const extracted = await extractRangeText(reader, range);
        return { text: extracted.text, truncated: extracted.truncated, scopeLabel: sectionLabel(range, extracted.unitCount) };
      }, options);
    if (attached) return { kind: 'attached' };
    return failure.message === null ? { kind: 'superseded' } : { kind: 'failed', message: failure.message };
  };

  const runAgentAction = (range: TocContextRange, document: DocumentMetadata): void => {
    const origin = adapter;
    const settle = (message: string | null): void => {
      if (!stillOpen(document, origin)) return;
      if (message !== null) showError('agent', message);
      useUiStore.getState().showRightTab('agent');
      closeMenu();
    };
    addToAgent(range, document).then((outcome) => {
      // A newer choice in this book replaced the capture: nothing to show.
      if (outcome.kind === 'superseded') {
        if (stillOpen(document, origin)) closeMenu();
        return;
      }
      settle(outcome.kind === 'failed' ? outcome.message : null);
    }, () => { settle('Could not attach this outline section.'); });
  };

  const runAction = (destination: 'chat' | 'agent'): void => {
    if (selectedMenuItem === null) return;
    const document = activeDocument;
    const selectedId = selectedMenuItem.id;
    const range = document === null
      ? null
      : deriveTocContextRange(tableOfContents, selectedId, document.format === 'pdf' ? (pageCount > 0 ? pageCount : document.pageCount) : null);
    if (range === null || document === null) {
      showError(destination, tocContextUnavailableMessage(tableOfContents, selectedId));
      useUiStore.getState().showRightTab(destination);
      closeMenu();
      return;
    }
    if (destination === 'agent') {
      runAgentAction(range, document);
      return;
    }
    void (async () => {
      const success = await addToChat(range, document);
      if (!success && chatStore.getState().error === null) showError('chat', 'Could not attach this outline section.');
      useUiStore.getState().showRightTab('chat');
      closeMenu();
    })().catch(() => {
      showError('chat', 'Could not attach this outline section.');
      useUiStore.getState().showRightTab('chat');
      closeMenu();
    });
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = menuItemRefs.current.filter((button): button is HTMLButtonElement => button !== null);
    const activeElement = document.activeElement;
    const currentIndex = activeElement instanceof HTMLButtonElement ? buttons.indexOf(activeElement) : -1;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Tab') {
      // Tab moves on from the row that opened the menu.
      returnFocusRef.current?.focus();
      closeMenu(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (buttons.length === 0) return;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + buttons.length) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return (
    <aside
      data-testid="reader-outline-sidebar"
      aria-label="Table of Contents"
      className="z-10 flex h-full w-64 select-none flex-col border-r border-border-subtle bg-bg-primary shadow-xs ui-enter-from-start"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h2 className="text-xs font-semibold text-text-primary">Table of Contents</h2>
        <button
          type="button"
          data-testid="close-toc-button"
          aria-label="Close outline"
          onClick={() => { setTocOpen(false); }}
          className="rounded-sm p-1 text-xs text-text-secondary hover:bg-bg-surface hover:text-text-primary"
        >
          <AppIcon name="close" size={13} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2" aria-label="Document outline">
        {tableOfContents.length === 0 ? (
          <div className="p-4 text-center text-xs text-text-secondary">
            No outline available for this document.
          </div>
        ) : (
          tableOfContents.map((item) => (
            <OutlineNode
              key={item.id}
              item={item}
              currentPage={currentPage}
              onSelect={(it) => { if (it.location !== null) void goToLocation(it.location); }}
              onOpenMenu={openMenu}
              activeMenuItemId={menu?.itemId ?? null}
            />
          ))
        )}
      </nav>

      {shownMenuItem && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id="reader-toc-context-menu"
          role="menu"
          aria-label={`Actions for ${shownMenuItem.title}`}
          onKeyDown={handleMenuKeyDown}
          {...phaseAttributes(menuPhase)}
          style={{ left: menuPosition.x, top: menuPosition.y }}
          className={`${MENU_SURFACE_CLASS} fixed z-50 min-w-52 origin-top-left`}
        >
          <button
            ref={(element) => { menuItemRefs.current[0] = element; }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => { runAction('chat'); }}
            className={MENU_ITEM_CLASS}
          >
            <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS} />
            Add section to AI Chat
          </button>
          <button
            ref={(element) => { menuItemRefs.current[1] = element; }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => { runAction('agent'); }}
            className={MENU_ITEM_CLASS}
          >
            <span aria-hidden="true" className={MENU_CHECK_SLOT_CLASS} />
            Add section to Agent
          </button>
        </div>,
        document.body,
      )}
    </aside>
  );
}
