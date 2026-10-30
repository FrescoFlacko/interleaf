// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import type { DocumentMetadata } from '@shared/types/document';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AppSettings } from '@shared/schemas/settings';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { chooseValue } from '../helpers/listbox-select';

/** Focused coverage for defects 18, 24, 25. */

function installSettingsBridge(settings: AppSettings): void {
  stubBridge({
    app: {
      getInfo: () => Promise.resolve({ name: 'Interleaf', tagline: '', version: '0', platform: 'darwin', versions: { electron: '1', node: '1', chrome: '1' } }),
      exportDebugLog: () => Promise.resolve({ status: 'cancelled' as const }),
    },
    settings: {
      get: () => Promise.resolve(structuredClone(settings)),
      update: (next) => Promise.resolve(structuredClone(next)),
    },
    ai: { listProviders: () => Promise.resolve([]) },
    credentials: { getOpenRouterStatus: () => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS) },
    agent: {
      listProfiles: () => Promise.resolve([]),
      listWorkingDirectories: () => Promise.resolve([]),
    },
  });
}

describe('Defect 18: settings success messages are transient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function openAndSave(updateImpl?: InterleafAPI['settings']['update']): Promise<void> {
    if (updateImpl !== undefined) stubBridge({ settings: { update: updateImpl } });
    render(<AIProviderSettingsModal open onClose={() => undefined} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await vi.advanceTimersByTimeAsync(50);
    // The Reader section's range input writes immediately (no Done needed).
    fireEvent.click(screen.getByRole('button', { name: /^Reader$/u }));
    fireEvent.change(screen.getByTestId('settings-reader-line-spacing'), { target: { value: '2' } });
    // Flush the serialized write promise chain so the success branch settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  test('section switch clears the success message immediately', async () => {
    installSettingsBridge(DEFAULT_APP_SETTINGS);
    await openAndSave();
    expect(screen.getByText('Settings saved on this device.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Library$/u }));
    expect(screen.queryByText('Settings saved on this device.')).toBeNull();
  });

  test('failure errors are not auto-dismissed and survive section switches', async () => {
    installSettingsBridge(DEFAULT_APP_SETTINGS);
    await openAndSave(() => Promise.reject(new Error('write permission denied')));
    expect(screen.getByText(/write permission denied/)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(6000);
    expect(screen.getByText(/write permission denied/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Library$/u }));
    expect(screen.getByText(/write permission denied/)).toBeTruthy();
  });
});

function makeToolbarDoc(overrides?: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    id: 'doc-1',
    title: 'Session Migration Summary',
    author: null,
    format: 'markdown',
    storageMode: 'managed',
    fileSize: 10,
    fileMtimeMs: 1,
    fileHash: 'hash-toolbar',
    pageCount: null,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: null,
    ...overrides,
  };
}

describe('Defects 24+25: reader display settings menu and toolbar layout', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  type ReaderState = ReturnType<typeof useReaderStore.getState>;
  type ToolbarStateOverrides = Partial<ReaderState>;

  function seedToolbarState(
    overrides?: ToolbarStateOverrides,
    document: DocumentMetadata = makeToolbarDoc(),
  ): void {
    const adapter = testDocumentAdapter(document.format, {
      getCurrentPage: () => 1,
      getReadingLocation: () => ({ location: { format: 'markdown' as const, blockIndex: 0 }, progress: 0 }),
    });
    useReaderStore.setState({
      session: testReaderSession(document, { adapter }),
      currentPage: 1,
      pageCount: 3,
      zoom: 1,
      zoomMode: 'fit-width',
      reflowLineHeight: 1.65,
      reflowHorizontalMarginRem: 2.5,
      tableOfContents: [],
      isLoading: false,
      error: null,
      ...overrides,
    });
  }

  test('24: typography/zoom controls live only inside the Document settings popover with deliberate focus behavior', async () => {
    seedToolbarState();
    render(<ReaderHeaderToolbar hidden={false} />);

    const trigger = screen.getByTestId('document-settings-button');
    expect(trigger).toBeTruthy();
    expect(screen.queryByTestId('document-settings-popover')).toBeNull();

    fireEvent.click(trigger);
    const popover = screen.getByTestId('document-settings-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('line-spacing-select')).toBeTruthy();
    expect(screen.getByTestId('reader-margin-select')).toBeTruthy();
    expect(screen.getByTestId('zoom-mode-select')).toBeTruthy();
    expect(screen.getByTestId('zoom-in-button')).toBeTruthy();
    expect(screen.getByTestId('zoom-out-button')).toBeTruthy();

    // Opening moves focus to the dialog surface itself (real activeElement).
    expect(document.activeElement).toBe(popover);

    // Escape closes and restores focus to the trigger after the queued
    // microtask focus restoration runs.
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(trigger);
    // The popover fades out (100ms), inert while it leaves.
    await waitFor(() => { expect(screen.queryByTestId('document-settings-popover')).toBeNull(); });

    // Reopen then outside pointer press dismisses and restores focus again.
    fireEvent.click(trigger);
    expect(screen.getByTestId('document-settings-popover')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => { expect(screen.queryByTestId('document-settings-popover')).toBeNull(); });
  });

  test('24: spacing/margins/preset dispatch existing store actions for reflowable docs', () => {
    const setReflowLineHeight = vi.fn<ReaderState['setReflowLineHeight']>();
    const setReflowHorizontalMargin = vi.fn<ReaderState['setReflowHorizontalMargin']>();
    const setZoom = vi.fn<ReaderState['setZoom']>();
    seedToolbarState({ setReflowLineHeight, setReflowHorizontalMargin, setZoom });
    render(<ReaderHeaderToolbar hidden={false} />);

    fireEvent.click(screen.getByTestId('document-settings-button'));
    chooseValue(screen.getByTestId('line-spacing-select'), '1.9');
    chooseValue(screen.getByTestId('reader-margin-select'), '4');
    chooseValue(screen.getByTestId('zoom-mode-select'), '1.5');

    expect(setReflowLineHeight).toHaveBeenCalledWith(1.9);
    expect(setReflowHorizontalMargin).toHaveBeenCalledWith(4);
    expect(setZoom).toHaveBeenCalledWith(1.5);
  });

  test('24: PDF keeps zoom usable while reflow selects render disabled with explanation', () => {
    const setZoom = vi.fn<ReaderState['setZoom']>();
    seedToolbarState({ setZoom }, makeToolbarDoc({ format: 'pdf', pageCount: 3 }));
    render(<ReaderHeaderToolbar hidden={false} />);
    fireEvent.click(screen.getByTestId('document-settings-button'));

    const spacing = screen.getByRole('combobox', { name: 'Line spacing' });
    const margins = screen.getByRole('combobox', { name: 'Reading margins' });
    expect(spacing).toBeDisabled();
    expect(margins).toBeDisabled();
    expect(screen.getByText('Line spacing applies to reflowable formats.')).toBeTruthy();

    const zoom = screen.getByRole('combobox', { name: 'Zoom level' });
    expect(zoom).toBeEnabled();
    // The toolbar select is controlled by the store, so assert the dispatched
    // action rather than the DOM value after a synthetic change.
    chooseValue(zoom, 'fit-page');
    expect(setZoom).toHaveBeenCalledWith('fit-page');
  });

  test('25: narrow-width compact presentation — icon-only labels stay accessible, every action preserved', () => {
    // A TOC is seeded so the Outline toggle — which now leads the identity
    // cluster, in the position the removed Library control held — is present.
    seedToolbarState({
      tableOfContents: [{ id: 'toc-0', title: 'Chapter 1', level: 0, location: { format: 'pdf', pageIndex: 0 }, children: [] }],
    });
    render(<ReaderHeaderToolbar hidden={false} />);
    // The wrapper is the container-query root: at <= 920px column width (the
    // app shell's compact-presentation regime) the text labels collapse to
    // icon-only via CSS without dropping or reordering any action (jsdom
    // never collapses them; classes stay inert). Reserving title width no
    // longer needs a second tier: the format badge is gone, so the title has
    // that width at every size.
    expect(screen.getByTestId('reader-header-toolbar-wrapper').className).toContain('@container');
    const compactLabelSpans = (container: HTMLElement): HTMLElement[] =>
      [...container.querySelectorAll('span')].filter((span) => span.className.includes('@max-[920px]:hidden'));
    for (const testId of ['toggle-toc-button', 'document-settings-button', 'add-bookmark-button', 'reader-focus-button']) {
      expect(compactLabelSpans(screen.getByTestId(testId)).length).toBeGreaterThan(0);
    }
    expect(screen.queryByTestId('reader-format-badge')).toBeNull();
    // Note invoker has no testid: assert via its stable accessible name.
    const noteInvoker = screen.getByRole('button', { name: 'Add note' });
    expect(compactLabelSpans(noteInvoker).length).toBeGreaterThan(0);
    expect(noteInvoker.textContent).toContain('Note');
    expect(noteInvoker.textContent).not.toContain('Note here');
    expect(screen.queryByRole('button', { name: /Note here/ })).toBeNull();
    // Accessible names surviving the collapse are asserted in
    // app-icon-consistency.spec.tsx.
  });
});
