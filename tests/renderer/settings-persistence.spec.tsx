// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { settingsModalFixture } from '../helpers/settings-modal';

describe('Settings document persistence ordering and rollback', () => {
  const {
    getSettings,
    updateSettings,
    onClose,
  } = settingsModalFixture();

  it('serializes rapid reader preference writes and uses monotonic sequencing to prevent stale responses from overwriting newer edits', async () => {
    let resolveFirst!: (value: typeof DEFAULT_APP_SETTINGS) => void;
    const firstPromise = new Promise<typeof DEFAULT_APP_SETTINGS>((resolve) => { resolveFirst = resolve; });
    let resolveSecond!: (value: typeof DEFAULT_APP_SETTINGS) => void;
    const secondPromise = new Promise<typeof DEFAULT_APP_SETTINGS>((resolve) => { resolveSecond = resolve; });

    updateSettings
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reader' })).toBeEnabled(); });
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }));

    const spacing = screen.getByTestId<HTMLInputElement>('settings-reader-line-spacing');
    // First edit: 1.8
    fireEvent.change(spacing, { target: { value: '1.8' } });
    // Second edit: 2.0
    fireEvent.change(spacing, { target: { value: '2' } });

    await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(1); });

    // Now resolve first write (stale 1.8)
    resolveFirst({ ...DEFAULT_APP_SETTINGS, reader: { ...DEFAULT_APP_SETTINGS.reader, lineSpacing: 1.8 } });

    await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(2); });

    // Resolve second write (2.0)
    resolveSecond({ ...DEFAULT_APP_SETTINGS, reader: { ...DEFAULT_APP_SETTINGS.reader, lineSpacing: 2 } });

    await waitFor(() => {
      expect(screen.getByText('Settings saved on this device.')).toBeTruthy();
    });
    expect(spacing.value).toBe('2');
  });

  it('synchronizes the mounted agent store only after main validates a settings write', async () => {
    const validated = {
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: 'sepia' as const },
    };
    updateSettings.mockResolvedValueOnce(validated);
    const sync = vi.spyOn(useAgentStore.getState(), 'syncWorkingDirectorySettings').mockResolvedValue(undefined);
    try {
      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
      fireEvent.click(screen.getByRole('radio', { name: /^Sepia/ }));

      await waitFor(() => { expect(screen.getByText('Settings saved on this device.')).toBeTruthy(); });
      expect(sync).toHaveBeenCalledWith(validated);
    } finally {
      sync.mockRestore();
    }
  });

  it('rolls back optimistic state and store settings to the latest confirmed snapshot on write failure', async () => {
    const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));

    // Write A succeeds (sepia palette)
    updateSettings.mockResolvedValueOnce({
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: 'sepia' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /^Sepia/ }));
    await waitFor(() => {
      expect(useUiStore.getState().palette).toBe('sepia');
      expect(screen.getByText('Settings saved on this device.')).toBeTruthy();
    });

    // Write B fails (midnight palette)
    updateSettings.mockRejectedValueOnce(new Error('disk write permission denied'));
    fireEvent.click(screen.getByRole('radio', { name: /^Midnight/ }));

    await waitFor(() => {
      expect(screen.getByText('disk write permission denied')).toBeTruthy();
    });

    // Must visibly report failure and restore state and UiStore back to confirmed snapshot A (sepia)
    expect(useUiStore.getState().palette).toBe('sepia');
    expect(useUiStore.getState().loadedSettings?.appearance.palette).toBe('sepia');
  });

  it('rolls back all reader reflow fields and loadedSettings to confirmed snapshot A when queued edit B fails after A succeeds while pending', async () => {
    const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
    const { useReaderStore } = await import('../../src/renderer/stores/use-reader-store');

    let resolveWriteA!: (value: typeof DEFAULT_APP_SETTINGS) => void;
    const writeAPromise = new Promise<typeof DEFAULT_APP_SETTINGS>((resolve) => {
      resolveWriteA = resolve;
    });
    let rejectWriteB!: (err: Error) => void;
    const writeBPromise = new Promise<typeof DEFAULT_APP_SETTINGS>((_, reject) => {
      rejectWriteB = reject;
    });

    updateSettings
      .mockImplementationOnce(() => writeAPromise)
      .mockImplementationOnce(() => writeBPromise);

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reader' })).toBeEnabled(); });
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }));

    const confirmedA = {
      ...DEFAULT_APP_SETTINGS,
      reader: {
        fontSize: 1.8,
        fontFamily: 'serif' as const,
        lineSpacing: 1.9,
        pageMargin: 3.5,
        paragraphSpacing: 1.4,
        contentWidth: 78,
        background: 'palette' as const,
      },
    };

    const spacingInput = screen.getByTestId<HTMLInputElement>('settings-reader-line-spacing');
    // Issue write A (1.9)
    fireEvent.change(spacingInput, { target: { value: '1.9' } });

    // Issue write B (2.2) while write A is still pending
    fireEvent.change(spacingInput, { target: { value: '2.2' } });

    // Settle write A successfully
    resolveWriteA(confirmedA);

    // Settle queued write B as rejected
    await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(2); });
    rejectWriteB(new Error('write permission denied'));

    // Assert error is displayed and no stale success is shown
    await waitFor(() => {
      expect(screen.getByText('write permission denied')).toBeTruthy();
      expect(screen.queryByText('Settings saved on this device.')).toBeNull();
    });

    // Verify component control, loadedSettings in UiStore, and every reader reflow field in ReaderStore reconcile to A
    expect(spacingInput.value).toBe('1.9');
    expect(useUiStore.getState().loadedSettings?.reader).toEqual(confirmedA.reader);
    expect(useReaderStore.getState().reflowLineHeight).toBe(1.9);
    expect(useReaderStore.getState().reflowFontSize).toBe(1.8);
    expect(useReaderStore.getState().reflowFontFamily).toBe('serif');
    expect(useReaderStore.getState().reflowHorizontalMarginRem).toBe(3.5);
    expect(useReaderStore.getState().reflowParagraphSpacing).toBe(1.4);
  });

  // Layout persistence is asynchronous, so settings.get can answer with a
  // document written before the newest resize/collapse. Opening or refreshing
  // Settings must never replay that stale layout into the live workspace, and
  // later complete-document writes must carry the live layout.
  describe('live workspace layout versus a stale persisted snapshot', () => {
    const LIVE_LAYOUT = { leftWidth: 400, rightWidth: 520, leftOpen: true, rightOpen: false, openRightPanelOnStartup: true } as const;
    const staleSettings = (): AppSettings => ({
      ...structuredClone(DEFAULT_APP_SETTINGS),
      layout: { leftWidth: 256, rightWidth: 320, leftOpen: true, rightOpen: true, openRightPanelOnStartup: true },
    });

    const hydrateLiveWorkspace = async (): Promise<void> => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      useUiStore.setState({
        loadedSettings: { ...structuredClone(DEFAULT_APP_SETTINGS), layout: { ...LIVE_LAYOUT }, appearance: { palette: 'moss' } },
        palette: 'moss',
        focusMode: false,
        focusSnapshot: null,
        ...LIVE_LAYOUT,
      });
    };

    afterEach(async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      const { DEFAULT_PALETTE } = await import('@shared/constants/palettes');
      useUiStore.setState({
        loadedSettings: null,
        palette: DEFAULT_PALETTE,
        leftWidth: 256,
        rightWidth: 320,
        leftOpen: true,
        rightOpen: true,
        focusMode: false,
        focusSnapshot: null,
      });
    });

    it('does not resize or reset the hydrated live workspace when Settings opens on a stale snapshot', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      await hydrateLiveWorkspace();
      getSettings.mockResolvedValueOnce(staleSettings());

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });

      const state = useUiStore.getState();
      expect(state.leftWidth).toBe(LIVE_LAYOUT.leftWidth);
      expect(state.rightWidth).toBe(LIVE_LAYOUT.rightWidth);
      expect(state.leftOpen).toBe(LIVE_LAYOUT.leftOpen);
      expect(state.rightOpen).toBe(LIVE_LAYOUT.rightOpen);
      expect(state.palette).toBe('moss');
      // The persistence base must carry the live layout, never the stale read.
      expect(state.loadedSettings?.layout).toEqual(LIVE_LAYOUT);
      // Opening Settings alone still writes nothing.
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it('does not resize the live workspace when a failed settings load is retried on a stale snapshot', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      await hydrateLiveWorkspace();
      getSettings.mockRejectedValueOnce(new Error('Settings unavailable'));

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByTestId('settings-load-error')).toBeTruthy(); });

      // The user resizes the workspace; that write has not been persisted yet.
      act(() => {
        useUiStore.getState().setLeftWidth(430);
        useUiStore.getState().setRightWidth(540);
      });
      getSettings.mockResolvedValueOnce(staleSettings());

      fireEvent.click(screen.getByRole('button', { name: 'Retry loading settings' }));
      await waitFor(() => { expect(screen.queryByTestId('settings-load-error')).toBeNull(); });

      expect(useUiStore.getState().leftWidth).toBe(430);
      expect(useUiStore.getState().rightWidth).toBe(540);
      expect(useUiStore.getState().rightOpen).toBe(false);
      expect(useUiStore.getState().loadedSettings?.layout).toEqual({ ...LIVE_LAYOUT, leftWidth: 430, rightWidth: 540 });
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it('writes the live layout, not the stale loaded layout, when saving a non-layout setting', async () => {
      await hydrateLiveWorkspace();
      getSettings.mockResolvedValueOnce(staleSettings());

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
      fireEvent.click(screen.getByRole('radio', { name: /^Sepia/ }));

      await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(1); });
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        appearance: expect.objectContaining({ palette: 'sepia' }) as object,
        layout: { ...LIVE_LAYOUT },
      }));
    });

    it('composes a queued write at execution time and orders it behind a concurrent resize persistence', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      const { persistSettings } = await import('../../src/renderer/app/api-client');
      await hydrateLiveWorkspace();
      getSettings.mockResolvedValueOnce(staleSettings());

      let resolveFirst!: (value: AppSettings) => void;
      const firstWrite = new Promise<AppSettings>((resolve) => { resolveFirst = resolve; });
      updateSettings.mockImplementationOnce(() => firstWrite);

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Reader' })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: 'Reader' }));

      const spacing = screen.getByTestId<HTMLInputElement>('settings-reader-line-spacing');
      // Write A executes immediately and stays pending; write B is queued.
      fireEvent.change(spacing, { target: { value: '1.8' } });
      fireEvent.change(spacing, { target: { value: '2' } });
      await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(1); });

      // The user resizes while A is in flight and B is still queued. The
      // resize shares the one ordered queue, so nothing overtakes A.
      act(() => { useUiStore.getState().setLeftWidth(430); });
      persistSettings({ ...staleSettings(), layout: { ...LIVE_LAYOUT, leftWidth: 430 } });
      expect(updateSettings).toHaveBeenCalledTimes(1);

      resolveFirst({ ...staleSettings(), reader: { ...DEFAULT_APP_SETTINGS.reader, lineSpacing: 1.8 } });
      await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(3); });

      // B was enqueued before the resize, so it is written before it — but it
      // is composed at execution time and therefore carries the resized width
      // it could not have known at enqueue time. The last write to reach main
      // is the resize, and both agree on the layout.
      expect(updateSettings).toHaveBeenNthCalledWith(2, expect.objectContaining({
        reader: expect.objectContaining({ lineSpacing: 2 }),
        layout: { ...LIVE_LAYOUT, leftWidth: 430 },
      }));
      expect(updateSettings).toHaveBeenNthCalledWith(3, expect.objectContaining({
        layout: { ...LIVE_LAYOUT, leftWidth: 430 },
      }));
    });

    it('persists the pre-focus snapshot layout, not the temporary collapsed panels, while Focus Mode is active', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      await hydrateLiveWorkspace();
      // Focus Mode collapses both panels; that state is never a preference.
      useUiStore.setState({
        focusMode: true,
        focusSnapshot: { leftOpen: true, rightOpen: true, leftWidth: 400, rightWidth: 520, rightTab: 'chat' },
        leftOpen: false,
        rightOpen: false,
      });
      getSettings.mockResolvedValueOnce(staleSettings());

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
      fireEvent.click(screen.getByRole('radio', { name: /^Sepia/ }));

      await waitFor(() => { expect(updateSettings).toHaveBeenCalledTimes(1); });
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        appearance: expect.objectContaining({ palette: 'sepia' }) as object,
        layout: { leftWidth: 400, rightWidth: 520, leftOpen: true, rightOpen: true, openRightPanelOnStartup: true },
      }));
    });

    it('still hydrates persisted layout when initial app hydration did not complete', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      useUiStore.setState({ loadedSettings: null, leftWidth: 256, rightWidth: 320, leftOpen: true, rightOpen: true });
      const persisted: AppSettings = {
        ...structuredClone(DEFAULT_APP_SETTINGS),
        layout: { leftWidth: 380, rightWidth: 500, leftOpen: false, rightOpen: true, openRightPanelOnStartup: true },
      };
      getSettings.mockResolvedValueOnce(persisted);

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(useUiStore.getState().loadedSettings).not.toBeNull(); });

      const state = useUiStore.getState();
      expect(state.leftWidth).toBe(380);
      expect(state.rightWidth).toBe(500);
      expect(state.leftOpen).toBe(false);
      expect(state.loadedSettings?.layout).toEqual(persisted.layout);
      expect(updateSettings).not.toHaveBeenCalled();
    });
  });
});
