// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { settingsModalFixture } from '../helpers/settings-modal';
import { chooseValue, optionValues } from '../helpers/listbox-select';

describe('Settings preference and policy sections', () => {
  const {
    getSettings,
    updateSettings,
    onClose,
  } = settingsModalFixture();

  describe('Library, Privacy, Advanced and Agent Sandboxing controls', () => {
    async function openSection(label: string): Promise<void> {
      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: label })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: label }));
    }

    /** The library store is a module singleton, so each test starts from launch state. */
    beforeEach(async () => {
      const { useLibraryStore } = await import('../../src/renderer/stores/use-library-store');
      useLibraryStore.setState({
        viewMode: 'grid',
        sortBy: 'recent_added',
        defaultViewMode: 'grid',
        defaultSortBy: 'recent_added',
        viewModeTouched: false,
        sortByTouched: false,
      });
    });

    it('persists the Library defaults and preserves the rest of the document', async () => {
      const { useLibraryStore } = await import('../../src/renderer/stores/use-library-store');
      await openSection('Library');

      expect(screen.getByTestId('settings-library-default-view')).toHaveAttribute('data-value', 'grid');
      expect(screen.getByTestId('settings-library-default-sort')).toHaveAttribute('data-value', 'recent_added');

      chooseValue(screen.getByTestId('settings-library-default-view'), 'list');
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
          library: { defaultView: 'list', defaultSort: 'recent_added' },
          reader: DEFAULT_APP_SETTINGS.reader,
          appearance: DEFAULT_APP_SETTINGS.appearance,
        }));
      });

      chooseValue(screen.getByTestId('settings-library-default-sort'), 'title_asc');
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
          library: { defaultView: 'list', defaultSort: 'title_asc' },
        }));
      });

      // A deliberate change here takes effect in the library at once.
      await waitFor(() => {
        expect(useLibraryStore.getState().viewMode).toBe('list');
        expect(useLibraryStore.getState().sortBy).toBe('title_asc');
      });
    });

    it('leaves a deliberate live view and sort alone when another section is saved', async () => {
      const { useLibraryStore } = await import('../../src/renderer/stores/use-library-store');
      useLibraryStore.getState().setViewMode('list');
      useLibraryStore.getState().setSortBy('title_desc');
      await openSection('Privacy');

      fireEvent.click(screen.getByTestId('settings-privacy-confirm-external-links'));
      await waitFor(() => {
        expect(screen.getByText('Settings saved on this device.')).toBeTruthy();
      });

      // Saving Privacy says nothing about how the library is being browsed.
      expect(useLibraryStore.getState().viewMode).toBe('list');
      expect(useLibraryStore.getState().sortBy).toBe('title_desc');
      // The stored defaults are still what a reset or the next launch uses.
      expect(useLibraryStore.getState().defaultViewMode).toBe('grid');
      expect(useLibraryStore.getState().defaultSortBy).toBe('recent_added');
    });

    it('applies only the Library default that changed, keeping the other live choice', async () => {
      const { useLibraryStore } = await import('../../src/renderer/stores/use-library-store');
      useLibraryStore.getState().setViewMode('list');
      useLibraryStore.getState().setSortBy('title_desc');
      await openSection('Library');

      chooseValue(screen.getByTestId('settings-library-default-sort'), 'author_asc');
      await waitFor(() => {
        expect(screen.getByText('Settings saved on this device.')).toBeTruthy();
      });

      expect(useLibraryStore.getState().sortBy).toBe('author_asc');
      expect(useLibraryStore.getState().viewMode).toBe('list');
      expect(useLibraryStore.getState().defaultViewMode).toBe('grid');
    });

    it('persists the external-link confirmation preference', async () => {
      await openSection('Privacy');

      const toggle = screen.getByTestId('settings-privacy-confirm-external-links');
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
          privacy: { confirmExternalLinks: true },
        }));
      });
      expect(toggle).toBeChecked();
    });

    it('shows the in-app privacy policy inside Privacy with an accessible heading structure', async () => {
      await openSection('Privacy');

      const policy = screen.getByTestId('settings-privacy-policy');
      // The policy is a labelled region nested under the existing Privacy section,
      // so the rail and its saved control keep working unchanged.
      const heading = within(policy).getByRole('heading', { name: 'Privacy Policy' });
      expect(policy.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(screen.getByTestId('settings-privacy-confirm-external-links')).toBeTruthy();

      // Every subsection is itself a labelled region a screen reader can jump between.
      const articles = within(policy).getAllByRole('article');
      expect(articles.length).toBeGreaterThanOrEqual(8);
      for (const article of articles) {
        const id = article.getAttribute('aria-labelledby');
        expect(id).toBeTruthy();
        expect(within(article).getByRole('heading')).toHaveAttribute('id', id);
      }
      // Nothing in the policy is focusable, so keyboard order through Privacy is unchanged.
      expect(policy.querySelectorAll('a, button, input, select, textarea, [tabindex]').length).toBe(0);

      const results = await axe.run(policy, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(results.violations).toEqual([]);
    });

    it('states the effective date and every required disclosure in the privacy policy', async () => {
      await openSection('Privacy');
      const policy = within(screen.getByTestId('settings-privacy-policy'));

      expect(policy.getByText(/Effective/u).textContent).toContain('September 12, 2026');
      expect(policy.getByText(/current privacy policy and may later be\s+mirrored on the Interleaf website/u)).toBeTruthy();

      // Local-first storage, and the two ways content leaves the machine.
      expect(policy.getByText(/stored on your own computer/u)).toBeTruthy();
      expect(policy.getByText(/explicitly export data/u)).toBeTruthy();
      // Chat sends question, selected context, and included history to the chosen provider.
      expect(policy.getByText(/your question, the document context you selected, and the conversation history/u)).toBeTruthy();
      expect(policy.getByText(/retention, training, and privacy\s+terms/u)).toBeTruthy();
      // OpenRouter routing plus provider-hosted Web Search.
      expect(policy.getByRole('heading', { name: 'OpenRouter' })).toBeTruthy();
      expect(policy.getByText(/upstream model provider/u)).toBeTruthy();
      expect(policy.getByText(/no-retention options/u)).toBeTruthy();
      expect(policy.getByText(/Web Search is hosted by the provider/u)).toBeTruthy();
      // A loopback endpoint is a connection location, not a guarantee of local inference.
      expect(policy.getByText(/OLLAMA_NO_CLOUD=1/u)).toBeTruthy();
      expect(policy.getByText(/cloud-capable models send data to Ollama/u)).toBeTruthy();
      // Credentials: transient plaintext, safeStorage, never returned to the UI.
      expect(policy.getByText(/Electron safeStorage/u)).toBeTruthy();
      expect(policy.getByText(/never returned to the interface/u)).toBeTruthy();
      expect(policy.getByText(/never asks you for\s+passwords or browser cookies/u)).toBeTruthy();
      // Agent Mode isolation is not an OS sandbox, and direct modes are confirmed.
      expect(policy.getByText(/not operating-system or container\s+sandboxes/u)).toBeTruthy();
      expect(policy.getByText(/require an explicit confirmation/u)).toBeTruthy();
      // Codex Reader Chat is described as constrained, never as tool-free.
      expect(policy.getByText(/read-only sandbox/u)).toBeTruthy();
      expect(policy.getByText(/constrained, not tool-free/u)).toBeTruthy();
      expect(policy.getByText(/do not remove Codex’s built-in tool surface/u)).toBeTruthy();
      // Untrusted inputs and the documented limits of bounded, redacted diagnostics.
      expect(policy.getByText(/treats documents, model output, web content/u)).toBeTruthy();
      // A truthful authority boundary, not an absolute claim about behaviour.
      expect(policy.getByText(/additional filesystem, credential, network, or execution authority/u)).toBeTruthy();
      expect(policy.getByText(/bounded by code-level controls/u)).toBeTruthy();
      expect(policy.getByText(/treat\s+model answers as suggestions/u)).toBeTruthy();
      // Application diagnostics and locally persisted agent history are
      // distinct claims and must not be conflated.
      expect(policy.getByText(/bounded and redacted, and exclude document bodies/u)).toBeTruthy();
      expect(policy.getByText(/raw\s+agent output streams/u)).toBeTruthy();
      expect(policy.getByText(/Agent session history is separate/u)).toBeTruthy();
      expect(policy.getByText(/ambient values that a\s+command-line tool prints/u)).toBeTruthy();
    });

    it('persists the diagnostic logging preference and says it needs no restart', async () => {
      await openSection('Advanced');

      const toggle = screen.getByTestId('settings-advanced-debug-logging');
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
          advanced: { debugLogging: true },
        }));
      });
      expect(screen.getByText(/no restart is needed/u)).toBeTruthy();
    });

    it('persists an isolated default execution mode and never offers container sandbox', async () => {
      await openSection('Agent Sandboxing');

      const select = screen.getByTestId('settings-agent-default-execution-mode');
      expect(select).toHaveAttribute('data-value', 'auto-isolated');
      // Only persistable, isolated, actually-runnable modes are offered.
      expect(optionValues(select)).toEqual([
        'auto-isolated',
        'isolated-worktree',
        'isolated-copy',
      ]);
      expect(screen.queryByText(/Container Sandbox/u)).toBeNull();

      chooseValue(select, 'isolated-worktree');
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
          agent: expect.objectContaining({ defaultExecutionMode: 'isolated-worktree' }),
        }));
      });

      // Direct-execution modes are never offered as a saved default.
      expect(screen.queryByText('Active Environment')).toBeNull();
      expect(screen.queryByText('Native Restricted')).toBeNull();
    });

    it('loads a legacy container-sandbox default as the recommended mode without rewriting it', async () => {
      const stored = structuredClone(DEFAULT_APP_SETTINGS);
      getSettings.mockResolvedValueOnce({
        ...stored,
        agent: { ...stored.agent, defaultExecutionMode: 'container-sandbox' },
      });
      await openSection('Agent Sandboxing');

      // The persisted value stays valid and untouched; the editor shows a mode
      // that can actually run, and nothing is written until the user chooses.
      const select = screen.getByTestId('settings-agent-default-execution-mode');
      expect(select).toHaveAttribute('data-value', 'auto-isolated');
      expect(optionValues(select).includes('container-sandbox')).toBe(false);
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it('shows the stored values when Settings reopens', async () => {
      getSettings.mockResolvedValueOnce({
        ...structuredClone(DEFAULT_APP_SETTINGS),
        library: { defaultView: 'list', defaultSort: 'author_asc' },
        privacy: { confirmExternalLinks: true },
        advanced: { debugLogging: true },
      });
      await openSection('Library');

      expect(screen.getByTestId('settings-library-default-view')).toHaveAttribute('data-value', 'list');
      expect(screen.getByTestId('settings-library-default-sort')).toHaveAttribute('data-value', 'author_asc');
      fireEvent.click(screen.getByRole('button', { name: 'Privacy' }));
      expect(screen.getByTestId('settings-privacy-confirm-external-links')).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(screen.getByTestId('settings-advanced-debug-logging')).toBeChecked();
      expect(updateSettings).not.toHaveBeenCalled();
    });
  });

  it('sets the Chat and Agent text size from Appearance, its only control', async () => {
    const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Appearance' })).toBeEnabled(); });
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));

    fireEvent.change(screen.getByTestId('settings-companion-text-size'), { target: { value: '1.5' } });

    expect(useUiStore.getState().companionTextSize).toBe(1.5);
    expect(screen.getByText('150%')).toBeTruthy();
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ companion: { textSize: 1.5 } }));
    });
  });

  describe('guided setup entry point', () => {
    it('hands the screen to the wizard instead of opening a second modal', async () => {
      const { useUiStore } = await import('../../src/renderer/stores/use-ui-store');
      const { useOnboardingStore } = await import('../../src/renderer/stores/use-onboarding-store');
      useUiStore.setState({ settingsOpen: true });
      useOnboardingStore.setState({ open: false, stage: 'import', lastStageAcknowledged: 'discover' });

      render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'General' })).toBeEnabled(); });
      fireEvent.click(screen.getByRole('button', { name: 'General' }));

      fireEvent.click(await screen.findByTestId('settings-rerun-onboarding'));

      // Settings closes first, so the wizard is never stacked on top of it, and
      // a re-run starts from the beginning rather than the abandoned stage.
      expect(useUiStore.getState().settingsOpen).toBe(false);
      const onboarding = useOnboardingStore.getState();
      expect(onboarding.open).toBe(true);
      expect(onboarding.stage).toBe('welcome');
      expect(onboarding.lastStageAcknowledged).toBeNull();
    });
  });
});
