// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { claudeProvider, codexProvider, settingsModalFixture } from '../helpers/settings-modal';

describe('Settings dialog shell: rendering, navigation, focus and loading', () => {
  const fixture = settingsModalFixture();
  const {
    configureOpenRouter,
    listProviders,
    getSettings,
    updateSettings,
    onClose,
    onProvidersChanged,
  } = fixture;

  it('renders provider statuses and passes accessibility audit', async () => {
    const { container } = render(
      <AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />
    );
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    });

    expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
    // One bordered accordion list; provider names drop "CLI" and the trailing
    // column is a plain status label rather than a coloured pill.
    expect(screen.getByTestId('provider-summary-openrouter')).toHaveTextContent('OpenRouter API');
    expect(screen.getByTestId('provider-summary-claude-code')).toHaveTextContent('Claude Code');
    expect(screen.getByTestId('provider-summary-codex')).toHaveTextContent('Codex');
    expect(screen.queryByText('Claude Code CLI')).toBeNull();
    expect(screen.getByTestId('provider-status-openrouter')).toHaveTextContent('Not configured');
    for (const id of ['antigravity', 'opencode']) {
      expect(screen.getByTestId(`provider-status-${id}`)).toHaveTextContent('Agent Mode only');
    }
    // Copilot is refused for unattended Agent Mode, so it is not offered at all,
    // even though main's (legacy) profile list still names it here.
    expect(screen.queryByTestId('provider-summary-copilot')).toBeNull();
    // Pi serves Reader Chat, so its row reports live CLI/auth state instead.
    expect(screen.getByTestId('provider-status-pi')).toHaveTextContent('Not installed');
    // Exactly one row is open, and it is the one this section deep-links to.
    expect(screen.getByTestId('provider-summary-openrouter')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('provider-summary-codex')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('provider-panel-codex')).toBeNull();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    // onProvidersChanged is NOT called simply because settings opened or loaded
    expect(onProvidersChanged).not.toHaveBeenCalled();
  });

  it('closes modal on Escape key or X button without saving unconfirmed OpenRouter draft', async () => {
    fixture.configured = false;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-key-input')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('openrouter-key-input'), { target: { value: 'sk-or-v1-draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(onClose).toHaveBeenCalled();
    expect(configureOpenRouter).not.toHaveBeenCalled();
  });

  it('gates settings while loading and reports a retryable load failure', async () => {
    let rejectLoad: (error: Error) => void = () => undefined;
    const pending = new Promise<never>((_, reject) => { rejectLoad = reject; });
    getSettings.mockReturnValueOnce(pending);
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    expect(screen.getByTestId('settings-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('settings-rail-ai')).toBeDisabled();
    expect(screen.getAllByText('Checking…').length).toBeGreaterThan(0);

    rejectLoad(new Error('settings disk unavailable'));
    await waitFor(() => { expect(screen.getByTestId('settings-load-error')).toHaveTextContent('settings disk unavailable'); });
    expect(screen.getByTestId('settings-load-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Retry loading settings' })).toBeEnabled();
    expect(screen.queryByText('Not Installed')).toBeNull();
  });

  // Provider status is a live probe of CLIs and of a local endpoint; the
  // settings document is a local read. A dialog that waits for the first
  // before letting anyone reach Privacy or Library is unusable for as long as
  // the slowest provider takes to answer, which is what this pins down.
  it('opens every settings section while the provider probe is still running', async () => {
    let settleProviders: (statuses: typeof claudeProvider[]) => void = () => undefined;
    listProviders.mockReturnValueOnce(new Promise((resolve) => { settleProviders = resolve; }));

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);

    // Readiness arrives with the settings document, not with the probe.
    await waitFor(() => { expect(screen.getByTestId('settings-rail-privacy')).toBeEnabled(); });
    expect(screen.queryByTestId('settings-loading')).toBeNull();
    expect(screen.queryByTestId('settings-load-error')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-rail-privacy'));
    const confirmExternal = screen.getByTestId('settings-privacy-confirm-external-links');
    expect(confirmExternal).toBeEnabled();

    // The probe is still outstanding, so no row claims a status nobody checked.
    fireEvent.click(screen.getByTestId('settings-rail-ai'));
    const checkingBefore = screen.getAllByText('Checking…').length;
    expect(checkingBefore).toBeGreaterThan(0);
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText('Not installed')).toBeNull();

    // And its real answer still lands when it arrives.
    settleProviders([claudeProvider, codexProvider]);
    await waitFor(() => { expect(screen.getAllByText('Ready').length).toBeGreaterThan(0); });
    expect(screen.queryAllByText('Checking…').length).toBeLessThan(checkingBefore);
  });

  it('hydrates ui store upon clicking retry after initial load failure without settings.update overwrite', async () => {
    const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
    useUiStore.setState({ loadedSettings: null });

    // Initial getSettings fails
    getSettings.mockRejectedValueOnce(new Error('initial database lock'));

    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-load-error')).toHaveTextContent('initial database lock');
    });
    expect(useUiStore.getState().loadedSettings).toBeNull();

    // Provide persisted settings on retry
    const persistedCustomSettings = {
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: 'moss' as const },
    };
    getSettings.mockResolvedValueOnce(persistedCustomSettings);

    const retryBtn = screen.getByRole('button', { name: 'Retry loading settings' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(useUiStore.getState().loadedSettings).not.toBeNull();
      expect(useUiStore.getState().palette).toBe('moss');
      expect(useUiStore.getState().loadedSettings).toEqual(persistedCustomSettings);
    });

    // Prove no settings.update was called (did not overwrite with defaults)
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
