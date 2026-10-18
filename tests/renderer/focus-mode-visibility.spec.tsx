// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { DocumentMetadata } from '@shared/types/document';
import { AppHeader } from '../../src/renderer/components/AppHeader';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { isReaderReady, useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { useShortcuts } from '../../src/renderer/hooks/use-shortcuts';
import { testReaderSession } from '../helpers/reader-session';

const DOCUMENT: DocumentMetadata = {
  id: 'focus-visibility-document',
  title: 'Focus Visibility Fixture',
  author: 'Interleaf',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'focus-visibility-hash',
  pageCount: 3,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  source: null,
};

const READY_ADAPTER = testDocumentAdapter('pdf');

function setReaderState(overrides: Partial<ReturnType<typeof useReaderStore.getState>> = {}): void {
  useReaderStore.setState({
    session: null,
    isLoading: false,
    error: null,
    pageCount: 0,
    ...overrides,
  });
}

function renderControls(): void {
  render(
    <>
      <AppHeader compact={false} />
      <ReaderHeaderToolbar hidden={false} />
    </>,
  );
}

describe('Focus Reading Mode visibility', () => {
  beforeEach(() => {
    cleanup();
    setReaderState();
    useUiStore.setState({ focusMode: false, compactActivePanel: null, loadedSettings: DEFAULT_APP_SETTINGS });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  test.each([
    ['Library', { activeDocument: null, adapter: null, isLoading: false, error: null, pageCount: 0 }],
    ['loading', { activeDocument: DOCUMENT, adapter: READY_ADAPTER, isLoading: true, error: null, pageCount: 0 }],
    ['failed', { activeDocument: DOCUMENT, adapter: READY_ADAPTER, isLoading: false, error: 'Render failed', pageCount: 0 }],
  ])('removes both Focus controls from the %s layout and accessibility tree', (_state, overrides) => {
    setReaderState(overrides);
    renderControls();

    expect(screen.queryByTestId('open-focus')).toBeNull();
    expect(screen.queryByTestId('reader-focus-button')).toBeNull();
  });

  test('shows only the in-reader control for a successfully mounted reader (AppHeader Focus button removed)', () => {
    setReaderState({ session: testReaderSession(DOCUMENT, { adapter: READY_ADAPTER }), isLoading: false, error: null, pageCount: 3 });
    renderControls();

    // AppHeader Focus button is removed
    expect(screen.queryByTestId('open-focus')).toBeNull();

    // In-reader control remains
    const readerControl = screen.getByTestId('reader-focus-button');
    expect(readerControl).toHaveAttribute('aria-label', 'Enter distraction-free focus mode');
    expect(readerControl).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(readerControl);
    expect(useUiStore.getState().focusMode).toBe(true);
    expect(screen.getByTestId('reader-focus-button')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('reader-focus-button'));
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  test('Focus Reading Mode and F11 shortcut toggle remain functional when reader is mounted and blocked when not ready', () => {
    const { unmount } = renderHook(() => { useShortcuts(); });

    // Mounted reader: F11 enters and exits Focus Reading Mode
    setReaderState({ session: testReaderSession(DOCUMENT, { adapter: READY_ADAPTER }), isLoading: false, error: null, pageCount: 3 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }));
    expect(useUiStore.getState().focusMode).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }));
    expect(useUiStore.getState().focusMode).toBe(false);

    // Unmounted/Library reader: F11 cannot enter Focus Mode
    setReaderState({ session: null, isLoading: false, error: null, pageCount: 0 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }));
    expect(useUiStore.getState().focusMode).toBe(false);

    unmount();
  });

  test('exposes the compact drawer target before the responsive drawer opens', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    render(<AppHeader compact />);

    const rightToggle = screen.getByTestId('toggle-right-panel');
    expect(rightToggle).toHaveAttribute('aria-controls', 'compact-drawer-right');
    expect(rightToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(rightToggle);
    expect(useUiStore.getState().compactActivePanel).toBe('right');
    expect(screen.getByTestId('toggle-right-panel')).toHaveAttribute('aria-expanded', 'true');
  });

  test('the store rejects entering Focus Mode until the reader is ready but still permits exit', () => {
    expect(
      isReaderReady({ session: testReaderSession(DOCUMENT, { adapter: READY_ADAPTER }), isLoading: false, error: null, pageCount: 3 }),
    ).toBe(true);
    expect(
      isReaderReady({ session: testReaderSession(DOCUMENT, { adapter: READY_ADAPTER }), isLoading: true, error: null, pageCount: 0 }),
    ).toBe(false);

    useUiStore.getState().toggleFocusMode(false);
    expect(useUiStore.getState().focusMode).toBe(false);
    useUiStore.getState().toggleFocusMode(true);
    expect(useUiStore.getState().focusMode).toBe(true);
    useUiStore.getState().toggleFocusMode(false);
    expect(useUiStore.getState().focusMode).toBe(false);
  });
});
