import { useEffect, useRef } from 'react';
import { reportRejection } from '@shared/models/caught-error';
import { AppIcon } from '../../components/AppIcon';
import { useModalPresence } from '../../components/ui/popover-presence';
import { useReaderStore } from '../../stores/use-reader-store';
import { useUiStore } from '../../stores/use-ui-store';
import { useAnnotationStore } from '../../stores/use-annotation-store';
import { useChatStoreApi } from '../../stores/use-chat-store';
import { ReaderHeaderToolbar } from './components/ReaderHeaderToolbar';
import { ReaderOutlineSidebar } from './components/ReaderOutlineSidebar';
import { AnnotationSelectionToolbar } from './components/AnnotationSelectionToolbar';
import { NotePopover } from './components/NotePopover';
import { useNotePointer } from './annotations/use-note-pointer';
import { useHighlightEdit } from './annotations/use-highlight-edit';
import { ReaderFocusProxies } from './components/ReaderFocusProxies';
import { selectionIssueHeading } from './types';
import { useSearchStore } from '../../stores/use-search-store';
import { readerDocumentStyle, readerSurfaceStyle } from './reader-surface-style';

/** Keeps a pair that is shown only together (the note bubble and its note) through the 100ms exit fade. */
function usePairedPresence<A, B>(first: A | null, second: B | null) {
  const keptFirst = useModalPresence(second === null ? null : first);
  const keptSecond = useModalPresence(first === null ? null : second);
  return [keptFirst, keptSecond] as const;
}

export function ReaderView() {
  const chatStore = useChatStoreApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusMode = useRef(false);
  const focusTocSnapshot = useRef<boolean | null>(null);

  const session = useReaderStore((s) => s.session);
  const activeDocument = session?.document ?? null;
  const isTocOpen = useReaderStore((s) => s.isTocOpen);
  const isLoading = useReaderStore((s) => s.isLoading);
  const error = useReaderStore((s) => s.error);
  const currentPage = useReaderStore((s) => s.currentPage);
  const pageCount = useReaderStore((s) => s.pageCount);
  const searchHighlightRequest = useReaderStore((s) => s.searchHighlightRequest);

  const mountAdapter = useReaderStore((s) => s.mountAdapter);
  const closeDocument = useReaderStore((s) => s.closeDocument);
  const flushPendingReadingPosition = useReaderStore(
    (s) => s.flushPendingReadingPosition
  );
  const clearExplicitNavigationLocation = useReaderStore((s) => s.clearExplicitNavigationLocation);
  const finishSearchHighlight = useReaderStore((s) => s.finishSearchHighlight);

  const focusMode = useUiStore((s) => s.focusMode);
  const readerBackground = useUiStore((s) => s.loadedSettings?.reader.background ?? 'palette');
  const annotations = useAnnotationStore((s) => s.annotations);
  const loadAnnotations = useAnnotationStore((s) => s.load);
  const resetAnnotations = useAnnotationStore((s) => s.reset);
  const setSelection = useAnnotationStore((s) => s.setSelection);
  const selectionIssue = useAnnotationStore((s) => s.selectionIssue);
  const activeDocumentId = activeDocument?.id ?? null;
  const highlightEdit = useHighlightEdit(annotations, activeDocumentId);
  const { openNote, closeNote, openAnnotation, noteFocusProxies, openFromProxy } = useNotePointer(
    containerRef,
    annotations,
    activeDocumentId,
    highlightEdit.route
  );
  const [shownNote, shownAnnotation] = usePairedPresence(openNote, openAnnotation);
  const clearSelectionError = useAnnotationStore((s) => s.clearSelectionError);
  const repairResolution = useAnnotationStore((s) => s.repairResolution);
  const indexDocument = useSearchStore((s) => s.indexDocument);
  const reindexNonce = useSearchStore((s) => s.reindexNonce);

  const setTocOpen = useReaderStore((s) => s.setTocOpen);

  useEffect(() => {
    if (focusMode && !previousFocusMode.current) {
      focusTocSnapshot.current = isTocOpen;
      if (isTocOpen) setTocOpen(false);
    } else if (!focusMode && previousFocusMode.current && focusTocSnapshot.current !== null) {
      setTocOpen(focusTocSnapshot.current);
      focusTocSnapshot.current = null;
    }
    previousFocusMode.current = focusMode;
  }, [focusMode, isTocOpen, setTocOpen]);

  useEffect(() => {
    if (!session || pageCount <= 0) return;
    const controller = new AbortController();
    void indexDocument(session.document, session.adapter, controller.signal);
    return () => { controller.abort(); };
  }, [session, indexDocument, pageCount, reindexNonce]);

  useEffect(() => {
    if (!session) return;
    return () => { resetAnnotations(); };
  }, [session, resetAnnotations]);

  useEffect(() => {
    if (!session || pageCount <= 0) return;
    const scope = session.adapter.getAnnotationScope();
    if (scope) void loadAnnotations(session.document.id, scope, session.document.fileHash);
  }, [session, currentPage, loadAnnotations, pageCount]);

  useEffect(() => {
    if (!session) return;
    const { adapter, document: openDocument } = session;
    adapter.setSelectionChangeCallback((selection, selectionIssue) => {
      if (selection) {
        setSelection(selection, null);
        return;
      }
      if (selectionIssue) {
        setSelection(null, selectionIssue);
        return;
      }
      window.queueMicrotask(() => {
        const focused = document.activeElement;
        if (focused instanceof Element && focused.closest('[data-testid="annotation-selection-toolbar"]')) return;
        setSelection(null, null);
      });
    });
    adapter.setAnnotationResolutionCallback((resolution) => {
      void repairResolution(openDocument.fileHash, resolution);
    });
    return () => {
      adapter.setSelectionChangeCallback(null);
      adapter.setAnnotationResolutionCallback(null);
      setSelection(null, null);
    };
  }, [session, repairResolution, setSelection]);

  useEffect(() => {
    if (session) void session.adapter.setAnnotations(annotations);
  }, [session, annotations]);

  useEffect(() => {
    if (!searchHighlightRequest || !session || pageCount <= 0) return;
    const { adapter, document: openDocument } = session;
    if (
      searchHighlightRequest.documentId !== openDocument.id ||
      searchHighlightRequest.documentHash !== openDocument.fileHash
    ) return;
    const controller = new AbortController();
    const request = { ...searchHighlightRequest, signal: controller.signal };
    void reportRejection(adapter.applySearchHighlight(request).then((result) => {
      if (!controller.signal.aborted) finishSearchHighlight(searchHighlightRequest, result);
    }), (caught) => {
      if (!controller.signal.aborted) {
        console.warn('Search highlight could not be painted.', caught);
        finishSearchHighlight(searchHighlightRequest, { status: 'not-found', text: null, rangeCount: 0 });
      }
    });
    return () => {
      controller.abort();
      adapter.clearSearchHighlight();
    };
  }, [session, finishSearchHighlight, pageCount, searchHighlightRequest]);

  useEffect(() => {
    if (containerRef.current && session) {
      void mountAdapter(containerRef.current);
    }
  }, [session, mountAdapter]);

  useEffect(() => {
    const flush = (): void => {
      void flushPendingReadingPosition();
    };
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      flush();
    };
  }, [flushPendingReadingPosition]);

  return (
    <div id="reader-content" data-testid="reader-view" data-document-id={activeDocument?.id} data-reader-background={readerBackground} style={readerSurfaceStyle(readerBackground)} tabIndex={-1} className="reader-surface flex flex-1 flex-col h-full overflow-hidden">
      {/* Keep toolbar state mounted while Focus Mode hides it, so transient
          popovers restore exactly when the reader returns. */}
      <ReaderHeaderToolbar hidden={focusMode} />

      {/* Main Viewport & Outline layout */}
      <div className="flex flex-1 min-h-0 relative overflow-hidden">
        {isTocOpen && <ReaderOutlineSidebar />}

        <div data-testid="reader-document-region" style={readerDocumentStyle(readerBackground)} className="flex-1 h-full w-full relative overflow-hidden flex flex-col items-center">
          {isLoading && (
            <div
              data-testid="reader-loading"
              role="status"
              aria-live="polite"
              aria-busy="true"
              className="absolute inset-0 z-20 flex items-center justify-center bg-bg-reader/80 backdrop-blur-xs text-xs text-text-secondary"
            >
              <div className="flex flex-col items-center gap-2">
                <AppIcon name="busy" size={20} className="animate-spin motion-reduce:animate-none" />
                <span>Opening {activeDocument?.title ?? 'document'}...</span>
              </div>
            </div>
          )}

          {error && (
            <div
              data-testid="reader-error"
              role="alert"
              className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-bg-reader p-6 text-center text-xs"
            >
              <AppIcon name="warning" size={30} className="mb-2 text-danger" />
              <h2 className="text-sm font-semibold text-danger">Failed to Open Document</h2>
              <p className="mt-1 max-w-sm text-text-secondary">{error}</p>
              <button
                type="button"
                onClick={() => {
                  if (containerRef.current) void mountAdapter(containerRef.current);
                }}
                className="mt-4 rounded-md bg-accent px-4 py-1.5 font-medium text-on-accent hover:opacity-90"
              >
                Retry opening document
              </button>
              <button
                type="button"
                onClick={() => {
                  void closeDocument();
                }}
                className="mt-2 rounded-md border border-border-subtle bg-bg-surface px-4 py-1.5 font-medium text-text-primary hover:border-accent hover:bg-bg-primary"
              >
                <span className="flex items-center gap-1.5">
                  <AppIcon name="back" size={14} />
                  Return to Library
                </span>
              </button>
            </div>
          )}

          <div
            ref={containerRef}
            tabIndex={-1}
            data-testid="pdf-viewport-container"
            data-reader-focus-target="true"
            onWheel={clearExplicitNavigationLocation}
            onPointerDown={clearExplicitNavigationLocation}
            onTouchStart={clearExplicitNavigationLocation}
            className="flex-1 h-full w-full overflow-hidden relative"
          />
        </div>
      </div>
      {selectionIssue !== null && (
        <div
          data-testid="reader-selection-error"
          role="alert"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-red-500/30 bg-bg-surface px-4 py-2.5 text-xs text-text-primary shadow-xl backdrop-blur-sm"
        >
          <span className="font-medium text-red-400">
            {selectionIssueHeading(selectionIssue)}
          </span>
          <span>{selectionIssue.message}</span>
          {(selectionIssue.code === 'size_limit' || selectionIssue.code === 'span_limit') && session && (
            <button
              type="button"
              data-testid="use-entire-document-chat"
              onClick={() => {
                const addEntireDoc = chatStore.getState().addEntireDocument;
                const showRightTab = useUiStore.getState().showRightTab;
                showRightTab('chat');
                const loc = session.adapter.getReadingLocation().location;
                void addEntireDoc(session.document, loc);
                clearSelectionError();
              }}
              className="ml-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-2xs font-medium text-accent hover:bg-accent/20"
            >
              Use Entire Document in Chat
            </button>
          )}
          <button
            type="button"
            data-testid="dismiss-selection-error"
            onClick={clearSelectionError}
            aria-label="Dismiss selection error"
            className="ml-2 rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            <AppIcon name="close" size={14} />
          </button>
        </div>
      )}
      {/*
        * Focus Mode hides the reader chrome, not the user's own selection. A
        * passage selected while reading distraction-free offers the same
        * actions as normal mode; each action decides for itself whether it
        * leaves Focus Mode. Clicking a saved highlight reopens the same
        * toolbar to recolour, delete, or ask about it.
        */}
      <AnnotationSelectionToolbar editing={highlightEdit.editing} />
      <ReaderFocusProxies
        proxies={noteFocusProxies}
        testIdPrefix="note-focus-proxy"
        labelPrefix="Open reader note"
        onActivate={openFromProxy}
      />
      <ReaderFocusProxies
        proxies={highlightEdit.highlightFocusProxies}
        testIdPrefix="highlight-focus-proxy"
        labelPrefix="Edit highlight"
        onActivate={highlightEdit.openHighlightFromProxy}
      />
      {shownNote.shown !== null && shownAnnotation.shown !== null && (
        <NotePopover
          phase={shownNote.phase}
          rect={shownNote.shown.rect}
          content={{ note: shownAnnotation.shown.note ?? '' }}
          onClose={closeNote}
        />
      )}
      {openNote !== null && openAnnotation !== null && (
        <p
          role="status"
          data-testid="note-popover-status"
          className="sr-only"
        >
          {`Reader note: ${openAnnotation.note ?? ''}`}
        </p>
      )}
    </div>
  );
}
