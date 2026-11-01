// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ResizablePanel, clampPanelWidth, panelMaxWidth } from '../../src/renderer/components/ResizablePanel';
import { ShortcutsDialog } from '../../src/renderer/components/ShortcutsDialog';
import { CompactDrawer } from '../../src/renderer/components/CompactDrawer';
import { App } from '../../src/renderer/app/App';
import { hasOpenTopLayer, isEditableShortcutTarget, useShortcuts } from '../../src/renderer/hooks/use-shortcuts';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { stubBridge } from '../helpers/interleaf-api';
import type { DocumentMetadata } from '@shared/types/document';
import { testReaderSession, testUnrenderedAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';
/** A single animation frame, expressed linearly per project promise rules. */
function nextFrame(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    window.requestAnimationFrame(() => { resolve(true); });
  });
}

/** Enough of a document for `isReaderReady`, so App keeps Focus Mode on. */
const FOCUS_SELECTION_DOC: DocumentMetadata = {
  id: 'doc-focus-1',
  title: 'Focus Mode Reader',
  author: 'Reader',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'hash-focus-1',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-24T12:00:00.000Z',
  updatedAt: '2026-08-24T12:00:00.000Z',
  source: null,
};
describe('Phase 10 layout contracts', () => {
  beforeEach(() => {
    useUiStore.setState({
      loadedSettings: DEFAULT_APP_SETTINGS,
      leftOpen: true,
      rightOpen: true,
      leftWidth: 256,
      rightWidth: 320,
      rightTab: 'chat',
      focusMode: false,
      focusSnapshot: null,
      shortcutsOpen: false,
      settingsOpen: false,
      compactActivePanel: null,
    });
    cleanup();
    document.body.replaceChildren();
  });

  it('clamps panel widths to bounds while preserving a readable center', () => {
    expect(clampPanelWidth('left', 10, 1400, 320)).toBe(220);
    expect(clampPanelWidth('right', 900, 1400, 440)).toBe(540);
    expect(panelMaxWidth('left', 960, 280)).toBe(260);
    expect(clampPanelWidth('right', 560, 960, 220)).toBe(320);
  });

  it('snapshots and restores transient Focus Mode workspace state', () => {
    useUiStore.setState({ leftOpen: false, rightOpen: true, leftWidth: 300, rightWidth: 410, rightTab: 'annotations' });
    useUiStore.getState().toggleFocusMode();
    expect(useUiStore.getState()).toMatchObject({ focusMode: true, leftOpen: false, rightOpen: false });
    useUiStore.getState().toggleFocusMode();
    expect(useUiStore.getState()).toMatchObject({ focusMode: false, leftOpen: false, rightOpen: true, leftWidth: 300, rightWidth: 410, rightTab: 'annotations', focusSnapshot: null });
  });

  it('suppresses app shortcuts in editable controls', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const contenteditable = document.createElement('div');
    contenteditable.setAttribute('contenteditable', 'true');
    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(textarea)).toBe(true);
    expect(isEditableShortcutTarget(contenteditable)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false);
  });

  it('routes the real shifted plus KeyboardEvent while retaining documented Shift chords', () => {
    const zoomIn = vi.fn(() => Promise.resolve());
    const toggleRight = vi.fn();
    useReaderStore.setState({ zoomIn });
    useUiStore.setState({ toggleRight });
    renderHook(() => { useShortcuts(); });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true }));
    expect(zoomIn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true }));
    expect(toggleRight).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true, repeat: true }));
    expect(zoomIn).toHaveBeenCalledTimes(1);
  });

  it('gives Escape and F11 to a mounted top layer before Focus Mode', () => {
    useUiStore.setState({ focusMode: true });
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);
    expect(hasOpenTopLayer()).toBe(true);
    renderHook(() => { useShortcuts(); });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useUiStore.getState().focusMode).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }));
    expect(useUiStore.getState().focusMode).toBe(true);
    modal.remove();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it('visually clamps preferred width to 220 when opposite panel opens and visually returns to 380 when it closes without an onWidthChange preference mutation', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 960 });
    const onWidthChange = vi.fn();
    const { rerender } = render(
      <ResizablePanel side="left" width={380} otherOpenWidth={0} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );

    const panel = screen.getByTestId('resizable-panel-left');
    expect(panel.style.width).toBe('380px');

    // Opposite panel reopens at width 320: max available for left is 960 - 420 - 320 = 220
    rerender(
      <ResizablePanel side="left" width={380} otherOpenWidth={320} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );

    // Visually clamps to 220px to protect 420px center, without mutating stored preference!
    expect(panel.style.width).toBe('220px');
    expect(onWidthChange).not.toHaveBeenCalled();

    // Opposite panel closes: visually returns to the preferred 380px without stored preference mutation!
    rerender(
      <ResizablePanel side="left" width={380} otherOpenWidth={0} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );
    expect(panel.style.width).toBe('380px');
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it('visually clamps on window resize within wide breakpoint to protect 420px center and restores on widening without mutating stored preference', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
    const onWidthChange = vi.fn();
    render(
      <ResizablePanel side="left" width={380} otherOpenWidth={320} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );

    const panel = screen.getByTestId('resizable-panel-left');
    expect(panel.style.width).toBe('380px');

    // Resize window from 1400 to 1000: max available for left is 1000 - 420 - 320 = 260
    act(() => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1000 });
      window.dispatchEvent(new Event('resize'));
    });

    expect(panel.style.width).toBe('260px');
    expect(onWidthChange).not.toHaveBeenCalled();

    // Widen window back to 1400: restores preferred 380px without calling onWidthChange
    act(() => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
      window.dispatchEvent(new Event('resize'));
    });

    expect(panel.style.width).toBe('380px');
    expect(onWidthChange).not.toHaveBeenCalled();
  });
  const flushDragFrame = async (): Promise<void> => {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  };

  it('updates preference on drag commit and restores preferred width on drag cancel without preference mutation', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
    const onWidthChange = vi.fn();
    render(
      <ResizablePanel side="left" width={280} otherOpenWidth={320} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );

    const handle = screen.getByTestId('panel-resizer-left');
    const panel = screen.getByTestId('resizable-panel-left');
    expect(panel.style.width).toBe('280px');

    // Start dragging at x=100
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    // Move to x=150 (+50px); visual width applies on the next animation frame
    fireEvent.pointerMove(handle, { clientX: 150 });
    expect(onWidthChange).not.toHaveBeenCalled();
    await flushDragFrame();
    expect(panel.style.width).toBe('330px');
    expect(onWidthChange).not.toHaveBeenCalled();

    // Cancel pointer drag (gesture/interruption)
    fireEvent.pointerCancel(handle);
    // Must restore visual width to original 280px without mutating preference
    expect(panel.style.width).toBe('280px');
    expect(onWidthChange).not.toHaveBeenCalled();
    await flushDragFrame();
    expect(panel.style.width).toBe('280px');
    expect(onWidthChange).not.toHaveBeenCalled();

    // Now complete a drag: pointerDown -> pointerMove -> pointerUp commits
    // the latest coalesced position even when up lands in the same frame.
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 160 });
    fireEvent.pointerUp(handle, { clientX: 160 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    expect(onWidthChange).toHaveBeenCalledWith(340);
  });

  it('rAF-coalesces rapid pointer moves into one applied width per frame and persists once per gesture', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const onWidthChange = vi.fn();
    render(
      <ResizablePanel side="left" width={280} otherOpenWidth={320} onWidthChange={onWidthChange} open={true}>
        <div>Sidebar Content</div>
      </ResizablePanel>
    );

    const handle = screen.getByTestId('panel-resizer-left');
    const panel = screen.getByTestId('resizable-panel-left');

    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });

    // Four pointer moves land inside one animation frame.
    const schedulesAfterDown = rafSpy.mock.calls.length;
    fireEvent.pointerMove(handle, { clientX: 120 });
    fireEvent.pointerMove(handle, { clientX: 135 });
    fireEvent.pointerMove(handle, { clientX: 170 });
    fireEvent.pointerMove(handle, { clientX: 200 });

    // Exactly one coalescing frame was scheduled and nothing applied yet.
    expect(rafSpy.mock.calls.length - schedulesAfterDown).toBe(1);
    expect(panel.style.width).toBe('280px');

    await flushDragFrame();

    // Only the latest position was applied; no preference mutation mid-drag.
    expect(panel.style.width).toBe('380px');
    expect(onWidthChange).not.toHaveBeenCalled();

    // Further moves schedule their own single frame each.
    const schedulesAfterFlush = rafSpy.mock.calls.length;
    fireEvent.pointerMove(handle, { clientX: 220 });
    fireEvent.pointerMove(handle, { clientX: 240 });
    expect(rafSpy.mock.calls.length - schedulesAfterFlush).toBe(1);

    // Pointer-up flushes the pending position synchronously and persists exactly once.
    fireEvent.pointerUp(handle, { clientX: 240 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    expect(onWidthChange).toHaveBeenCalledWith(420);
    rafSpy.mockRestore();
  });

  it('closes a real dialog on Escape without toggling Focus Mode, and blocks F11 while open', () => {
    useUiStore.setState({ focusMode: true, shortcutsOpen: true });
    function StoreShortcutsDialog() {
      const open = useUiStore((state) => state.shortcutsOpen);
      return <ShortcutsDialog open={open} />;
    }
    render(<StoreShortcutsDialog />);
    renderHook(() => { useShortcuts(); });

    expect(screen.getByTestId('shortcuts-dialog')).toBeInTheDocument();
    expect(useUiStore.getState().focusMode).toBe(true);

    // F11 while dialog is open must NOT toggle focusMode
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }));
    expect(useUiStore.getState().focusMode).toBe(true);

    // Escape closes the dialog (shortcutsOpen -> false) but keeps focusMode true
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useUiStore.getState().shortcutsOpen).toBe(false);
    expect(useUiStore.getState().focusMode).toBe(true);
  });

  it('CompactDrawer provides initial focus, Tab focus trap, and restores focus on close', async () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'test-trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onClose = vi.fn();
    const onSwitch = vi.fn();

    const { rerender } = render(
      <CompactDrawer
        side="left"
        label="Library"
        testId="compact-drawer-left"
        onClose={onClose}
        onSwitch={onSwitch}
        switchLabel="Switch to companion"
        switchTestId="switch-to-companion-button"
        inert={false}
        slidePhase="open"
      >
        <button type="button" data-testid="drawer-inner-btn-1">Button 1</button>
        <button type="button" data-testid="drawer-inner-btn-2">Button 2</button>
      </CompactDrawer>
    );

    const drawer = screen.getByTestId('compact-drawer-left');
    const switchBtn = screen.getByTestId('switch-to-companion-button');
    const inner2 = screen.getByTestId('drawer-inner-btn-2');
    // Focuses first focusable element inside on mount
    await new Promise((r) => { window.requestAnimationFrame(r); });
    expect(document.activeElement).toBe(switchBtn);

    // Tab trap: from last element (inner2), Tab cycles back to first (switchBtn)
    inner2.focus();
    expect(document.activeElement).toBe(inner2);
    fireEvent.keyDown(drawer, { key: 'Tab' });
    expect(document.activeElement).toBe(switchBtn);

    // Shift+Tab trap: from first element (switchBtn), Shift+Tab cycles to last (inner2)
    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(inner2);

    // Unmounting/closing restores focus to original trigger element
    rerender(<div />);
    await new Promise((r) => { window.requestAnimationFrame(r); });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('renders only one instance of each sidebar at a time in compact mode and inerts app shell while open', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({ compactActivePanel: null });

    const { unmount } = render(<App />);

    const shell = screen.getByTestId('app-shell');
    expect(shell).not.toHaveAttribute('inert');
    expect(shell).not.toHaveAttribute('aria-hidden');

    // Initially at width 480, no sidebar is mounted in desktop slots or drawer
    expect(screen.queryByTestId('sidebar-library')).toBeNull();
    expect(screen.queryByTestId('companion-panel')).toBeNull();

    // Open left drawer: mounts exactly ONE instance of LibrarySidebar, inerts shell
    act(() => {
      useUiStore.setState({ compactActivePanel: 'left' });
    });

    expect(screen.getAllByTestId('sidebar-library')).toHaveLength(1);
    expect(screen.queryByTestId('companion-panel')).toBeNull();
    expect(shell).toHaveAttribute('inert');
    expect(shell).toHaveAttribute('aria-hidden', 'true');

    // Switch to Companion drawer: mounts exactly ONE CompanionPanel while the
    // LibrarySidebar plays its real exit slide before unmounting (Defect 22).
    const switchBtn = screen.getByTestId('switch-to-companion-button');
    fireEvent.click(switchBtn);

    expect(useUiStore.getState().compactActivePanel).toBe('right');
    expect(screen.getAllByTestId('companion-panel')).toHaveLength(1);
    await waitFor(() => { expect(screen.queryByTestId('sidebar-library')).toBeNull(); });
    expect(screen.getAllByTestId('companion-panel')).toHaveLength(1);
    expect(shell).toHaveAttribute('inert');

    // Close compact drawer: the CompanionPanel exits via its slide-out phase,
    // then unmounts and un-inerts the shell.
    const closeBtn = screen.getByTestId('close-compact-drawer');
    fireEvent.click(closeBtn);

    expect(useUiStore.getState().compactActivePanel).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('companion-panel')).toBeNull();
      expect(screen.queryByTestId('sidebar-library')).toBeNull();
    });
    expect(shell).not.toHaveAttribute('inert');
    unmount();
  });

  it('nested modal Escape closes modal, leaves drawer open, restores focus inside drawer, and second Escape closes drawer and restores toggle button', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({ compactActivePanel: null });
    useLibraryStore.setState({ libraryModal: null, documents: [], folders: [], folderTree: [] });

    const { unmount } = render(<App />);

    const toggleLeftBtn = screen.getByTestId('toggle-left-panel');
    toggleLeftBtn.focus();
    expect(document.activeElement).toBe(toggleLeftBtn);

    // Open Library drawer
    fireEvent.click(toggleLeftBtn);
    expect(useUiStore.getState().compactActivePanel).toBe('left');
    const drawer = screen.getByTestId('compact-drawer-left');
    expect(drawer).toBeInTheDocument();
    expect(drawer).not.toHaveAttribute('inert');

    // Focus and click "+ New" folder button inside the drawer
    const newFolderBtn = screen.getByTestId('new-folder-button');
    newFolderBtn.focus();
    fireEvent.click(newFolderBtn);
    // Modal is open, drawer is inert, shell is inert
    const modal = screen.getByTestId('new-folder-modal');
    expect(modal).toBeInTheDocument();
    expect(drawer).toHaveAttribute('inert');
    expect(screen.getByTestId('app-shell')).toHaveAttribute('inert');

    // Press Escape once: closes modal ONLY
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape', bubbles: true });

    // The modal fades out (100ms), inert while it leaves.
    await waitFor(() => {
      expect(screen.queryByTestId('new-folder-modal')).toBeNull();
    });
    // Drawer remains OPEN and inert state clears
    expect(screen.getByTestId('compact-drawer-left')).toBeInTheDocument();
    expect(drawer).not.toHaveAttribute('inert');

    // Focus returns inside the drawer to the "+ New" button
    await new Promise<void>((r) => { queueMicrotask(() => { r(); }); });
    expect(document.activeElement).toBe(newFolderBtn);

    // Press Escape second time: closes compact drawer and restores focus to toggle button
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape', bubbles: true });

    expect(useUiStore.getState().compactActivePanel).toBeNull();
    // Focus restoration is scheduled by the drawer's unmount cleanup after
    // the exit phase completes; give its rAF chain time to run.
    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-left')).toBeNull(); });
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(toggleLeftBtn);
    unmount();
  });

  it('blocks F11 while compact drawer is open and preserves focusMode state', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({ compactActivePanel: 'left', focusMode: false });

    const { unmount } = render(<App />);
    expect(useUiStore.getState().focusMode).toBe(false);
    expect(screen.getByTestId('compact-drawer-left')).toBeInTheDocument();

    // F11 should be blocked and not toggle focusMode
    fireEvent.keyDown(window, { key: 'F11' });
    expect(useUiStore.getState().focusMode).toBe(false);
    expect(screen.getByTestId('compact-drawer-left')).toBeInTheDocument();

    unmount();
  });

  it('backdrop dismissal closes drawer and restores focus to the corresponding panel toggle', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({ compactActivePanel: null });

    const { unmount: ignoreUnmount } = render(<App />);

    const toggleLeftBtn = screen.getByTestId('toggle-left-panel');
    toggleLeftBtn.focus();
    fireEvent.click(toggleLeftBtn);

    expect(screen.getByTestId('compact-drawer-left')).toBeInTheDocument();
    const backdrop = screen.getByTestId('compact-backdrop');

    fireEvent.click(backdrop);

    expect(useUiStore.getState().compactActivePanel).toBeNull();
    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-left')).toBeNull(); });
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(toggleLeftBtn);
    ignoreUnmount();
  });

  it('switching panels focuses the replacement drawer and subsequent close restores the new panel toggle', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 480 });
    useUiStore.setState({ compactActivePanel: null });

    const { unmount } = render(<App />);

    const toggleLeftBtn = screen.getByTestId('toggle-left-panel');
    const toggleRightBtn = screen.getByTestId('toggle-right-panel');

    // Open left drawer
    fireEvent.click(toggleLeftBtn);
    expect(screen.getByTestId('compact-drawer-left')).toBeInTheDocument();

    // Click Switch to companion button inside left drawer
    const switchBtn = screen.getByTestId('switch-to-companion-button');
    fireEvent.click(switchBtn);

    // Right drawer mounts immediately; the left drawer plays its exit slide
    // before unmounting (Defect 22).
    expect(useUiStore.getState().compactActivePanel).toBe('right');
    const rightDrawer = screen.getByTestId('compact-drawer-right');
    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-left')).toBeNull(); });

    // Initial focus moves into right drawer
    await nextFrame();
    expect(rightDrawer.contains(document.activeElement)).toBe(true);

    // Close right drawer via explicit Close button
    const closeBtn = screen.getByTestId('close-compact-drawer');
    fireEvent.click(closeBtn);

    expect(useUiStore.getState().compactActivePanel).toBeNull();
    // Focus restoration is scheduled by the drawer's unmount cleanup after
    // the exit phase completes; give its rAF chain time to run.
    await waitFor(() => { expect(screen.queryByTestId('compact-drawer-right')).toBeNull(); });
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(toggleRightBtn);
    unmount();
  });

  it('gives a selection action that exits Focus Mode the destination focus, not the saved return element', async () => {
    // The whole App is mounted so the real restoration effect runs: it takes
    // the element Focus Mode saved and focuses it in a requestAnimationFrame
    // callback, which is exactly what a destination focused any earlier would
    // lose to.
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1400 });
    // Opening the annotations tab counts its chips for the open document.
    stubBridge({
      annotations: {
        page: vi.fn((_documentId: string, filter: { readonly offset: number; readonly limit: number }) =>
          Promise.resolve({ items: [], total: 0, offset: filter.offset, limit: filter.limit })),
      },
    });
    useReaderStore.setState({
      // The App mounts the reader, so its adapter opens a five-page document.
      session: testReaderSession(FOCUS_SELECTION_DOC, {
        adapter: testUnrenderedAdapter(FOCUS_SELECTION_DOC, {
          open: () => Promise.resolve(),
          getTableOfContents: () => Promise.resolve([]),
          getCurrentPage: () => 1,
          getPageCount: () => 5,
        }),
      }),
      currentPage: 1,
      pageCount: 5,
      isLoading: false,
      error: null,
      tableOfContents: [],
      isTocOpen: false,
    });
    useAnnotationStore.setState({
      loaded: testLoadedAnnotations(FOCUS_SELECTION_DOC.id),
      selection: {
        selectedText: 'a passage read distraction-free',
        totalSelectedLength: 31,
        chatDescriptor: { format: 'pdf', startPageIndex: 0, endPageIndex: 0, startPageLabel: '1', endPageLabel: '1' },
        anchor: {
          format: 'pdf',
          pageIndex: 0,
          quote: { exact: 'a passage read distraction-free', prefix: '', suffix: '' },
        },
        clientRect: { left: 20, top: 100, width: 120, height: 20 },
      },
    });
    useUiStore.setState({ leftOpen: true, rightOpen: true, rightTab: 'chat', compactActivePanel: null });

    const { unmount } = render(<App />);
    await waitFor(() => { expect(useReaderStore.getState()).toMatchObject({ isLoading: false, error: null, pageCount: 5 }); });
    // Focus Mode saves whatever held focus when it was entered.
    const returnElement = screen.getByTestId('toggle-right-panel');
    returnElement.focus();
    act(() => { useUiStore.getState().toggleFocusMode(); });
    expect(useUiStore.getState().focusMode).toBe(true);
    await nextFrame();

    fireEvent.click(screen.getByRole('button', { name: 'Submit selected passage to agent' }));
    expect(useUiStore.getState().focusMode).toBe(false);

    const task = await screen.findByTestId('agent-task-description');
    await waitFor(() => { expect(document.activeElement).toBe(task); });
    // Focus Mode's restoration frame has already run by now and did not win.
    await nextFrame();
    expect(document.activeElement).toBe(task);
    expect(document.activeElement).not.toBe(returnElement);

    unmount();
    useAnnotationStore.setState({ selection: null, loaded: null });
    useReaderStore.setState({ session: null, pageCount: 0 });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  });
});
