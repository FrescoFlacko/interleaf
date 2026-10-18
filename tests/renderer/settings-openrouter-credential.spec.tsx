// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIProviderSettingsModal } from '../../src/renderer/features/chat/AIProviderSettingsModal';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { settingsModalFixture } from '../helpers/settings-modal';
import type { OpenRouterCredentialStatus } from '@shared/schemas/credential-preview';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { chooseValue } from '../helpers/listbox-select';

describe('Settings OpenRouter credential save, validation and removal', () => {
  const fixture = settingsModalFixture();
  const {
    clearOpenRouterKey,
    configureOpenRouter,
    onClose,
    onProvidersChanged,
  } = fixture;

  it('saves configured model and preserves key when key is already configured and replacement key is blank on Done', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    const modelSelect = screen.getByTestId('openrouter-model-select');
    chooseValue(modelSelect, 'anthropic/claude-3.5-sonnet');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(configureOpenRouter).toHaveBeenCalledWith({
        model: 'anthropic/claude-3.5-sonnet',
      });
    });
    expect(onProvidersChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('saves both new key and selected model on Done when entering a new key and closes', async () => {
    fixture.configured = false;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-key-input')).toBeTruthy();
    });

    const keyInput = screen.getByTestId('openrouter-key-input');
    fireEvent.change(keyInput, { target: { value: 'sk-or-v1-test-secret-key' } });
    const modelSelect = screen.getByTestId('openrouter-model-select');
    chooseValue(modelSelect, 'openai/gpt-4o');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(configureOpenRouter).toHaveBeenCalledWith({
        apiKey: 'sk-or-v1-test-secret-key',
        model: 'openai/gpt-4o',
      });
    });
    expect(onProvidersChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('fails validation, saves neither, and stays open when unconfigured and key is missing on Done', async () => {
    fixture.configured = false;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-key-input')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(document.getElementById('openrouter-key-error')).toHaveTextContent(/Please enter a valid API key/i);
    });
    // The same reason is summarised beside Done.
    expect(document.getElementById('settings-error')).toHaveTextContent(/OpenRouter: Please enter a valid API key/i);

    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('reveals the collapsed OpenRouter row, focuses its key and says why when Done is refused', async () => {
    fixture.configured = false;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-key-input')).toBeTruthy();
    });
    // Another row opened: OpenRouter collapses, so its field is out of sight.
    fireEvent.click(screen.getByTestId('provider-summary-local'));
    expect(screen.queryByTestId('openrouter-key-input')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.getByTestId('provider-panel-openrouter')).toBeTruthy();
    });
    expect(screen.getByTestId('provider-summary-openrouter')).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => { expect(screen.getByTestId('openrouter-key-input')).toHaveFocus(); });
    const summary = document.getElementById('settings-error');
    expect(summary).toHaveAttribute('role', 'alert');
    expect(summary).toHaveTextContent(/OpenRouter: Please enter a valid API key/i);
    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('displays backend failure message and stays open when configureOpenRouter fails', async () => {
    fixture.configured = true;
    configureOpenRouter.mockRejectedValueOnce(new Error('Encryption hardware failure'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    const modelSelect = screen.getByTestId('openrouter-model-select');
    chooseValue(modelSelect, 'anthropic/claude-3.5-sonnet');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(document.getElementById('settings-error')).toHaveTextContent('Encryption hardware failure');
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('removes the stored key the moment Remove is clicked, and updates in place', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('remove-openrouter-key-button')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('remove-openrouter-key-button'));

    // The deletion is main-owned and immediate; no model save carries it.
    await waitFor(() => { expect(clearOpenRouterKey).toHaveBeenCalledTimes(1); });
    expect(configureOpenRouter).not.toHaveBeenCalled();
    // The open panel drops to the unconfigured state without waiting for Done.
    await waitFor(() => { expect(screen.queryByTestId('openrouter-key-preview')).toBeNull(); });
    expect(screen.queryByTestId('remove-openrouter-key-button')).toBeNull();
    expect(screen.getByTestId('openrouter-key-input')).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    // Status consumers are told, so the provider row stops claiming a key.
    expect(onProvidersChanged).toHaveBeenCalled();
  });

  it('keeps the configured state truthful when removal fails, and says why', async () => {
    fixture.configured = true;
    clearOpenRouterKey.mockRejectedValueOnce(new Error('The credential vault is locked.'));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('remove-openrouter-key-button')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('remove-openrouter-key-button'));

    await waitFor(() => { expect(screen.getByRole('alert')).toHaveTextContent('The credential vault is locked.'); });
    // Nothing was deleted, so the panel must still show the stored credential
    // and keep Remove available for a retry.
    expect(screen.getByTestId('openrouter-key-preview')).toBeTruthy();
    const retry = screen.getByTestId('remove-openrouter-key-button');
    expect(retry).toBeEnabled();
    expect(onProvidersChanged).not.toHaveBeenCalled();
  });

  it('lets Done finish with no key after an immediate removal', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => { expect(screen.getByTestId('remove-openrouter-key-button')).toBeTruthy(); });

    fireEvent.click(screen.getByTestId('remove-openrouter-key-button'));
    await waitFor(() => { expect(clearOpenRouterKey).toHaveBeenCalledTimes(1); });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // The reader deliberately removed the key, so Done must not demand one back.
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(configureOpenRouter).not.toHaveBeenCalled();
  });

  it('moves focus to the key field when Remove takes its button away', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    const removeButton = await screen.findByTestId('remove-openrouter-key-button');
    removeButton.focus();
    // A replacement the reader had started typing survives the removal.
    fireEvent.change(screen.getByTestId('openrouter-key-input'), { target: { value: 'sk-or-v1-partial' } });

    fireEvent.click(removeButton);

    await waitFor(() => { expect(screen.queryByTestId('remove-openrouter-key-button')).toBeNull(); });
    const keyInput = screen.getByTestId('openrouter-key-input');
    expect(document.activeElement).toBe(keyInput);
    expect(keyInput).toHaveValue('sk-or-v1-partial');
  });

  it('does not let Done and Remove start overlapping credential writes', async () => {
    fixture.configured = true;
    let finishRemoval!: (status: OpenRouterCredentialStatus) => void;
    clearOpenRouterKey.mockImplementationOnce(() => new Promise((resolve) => {
      finishRemoval = resolve;
    }));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('remove-openrouter-key-button');

    fireEvent.click(screen.getByTestId('remove-openrouter-key-button'));
    await waitFor(() => { expect(screen.getByTestId('remove-openrouter-key-button')).toBeDisabled(); });

    // Main serializes the two writes regardless; the dialog must not even
    // offer to start a save against a credential state that is being replaced.
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(done);
    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    finishRemoval(UNCONFIGURED_CREDENTIAL_STATUS);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled(); });
  });

  it('does not offer Remove while a save is in flight', async () => {
    fixture.configured = true;
    let finishSave!: (settings: AppSettings) => void;
    configureOpenRouter.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    const keyInput = await screen.findByTestId('openrouter-key-input');

    fireEvent.change(keyInput, { target: { value: `sk-or-v1-${'c'.repeat(48)}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => { expect(screen.getByTestId('remove-openrouter-key-button')).toBeDisabled(); });
    fireEvent.click(screen.getByTestId('remove-openrouter-key-button'));
    expect(clearOpenRouterKey).not.toHaveBeenCalled();

    finishSave(DEFAULT_APP_SETTINGS);
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
  });

  it('rejects malformed replacement keys without calling the atomic save', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    // A configured key exposes the same always-present password field; typing
    // in it is the replacement request, with no separate mode to enter first.
    const keyInput = await screen.findByTestId('openrouter-key-input');
    expect(keyInput).toHaveValue('');

    fireEvent.change(keyInput, { target: { value: 'not-a-real-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => { expect(screen.getByText('Please enter a valid API key.')).toBeTruthy(); });
    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('replaces a stored key from the same field, without any staged mode', async () => {
    fixture.configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    const keyInput = await screen.findByTestId('openrouter-key-input');

    fireEvent.change(keyInput, { target: { value: `sk-or-v1-${'b'.repeat(48)}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(configureOpenRouter).toHaveBeenCalledWith({
        apiKey: `sk-or-v1-${'b'.repeat(48)}`,
        model: 'openrouter/auto',
      });
    });
    expect(clearOpenRouterKey).not.toHaveBeenCalled();
  });

  it('sets proper ARIA attributes on field validation error and clears error on input change', async () => {
    fixture.configured = false;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-key-input')).toBeTruthy();
    });

    const keyInput = screen.getByTestId('openrouter-key-input');
    expect(keyInput).toHaveAttribute('aria-invalid', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(keyInput).toHaveAttribute('aria-invalid', 'true');
      expect(keyInput).toHaveAttribute('aria-describedby', 'openrouter-key-error');
      expect(screen.getByText('Please enter a valid API key.')).toBeTruthy();
    });

    // Typing clears the field error
    fireEvent.change(keyInput, { target: { value: 'sk-or-v1-typed-key' } });
    expect(keyInput).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText('Please enter a valid API key.')).toBeNull();
  });

  it('prevents double-submit when Done is rapidly clicked multiple times', async () => {
    fixture.configured = true;
    let resolveSave!: (val: AppSettings) => void;
    const savePromise = new Promise<AppSettings>((resolve) => {
      resolveSave = resolve;
    });
    configureOpenRouter.mockImplementationOnce(() => savePromise);
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={onProvidersChanged} initialTarget="ai" />);
    await waitFor(() => {
      expect(screen.getByTestId('openrouter-model-select')).toBeTruthy();
    });

    chooseValue(screen.getByTestId('openrouter-model-select'), 'anthropic/claude-3.5-sonnet');

    const doneBtn = screen.getByRole('button', { name: 'Done' });
    fireEvent.click(doneBtn);
    fireEvent.click(doneBtn);
    fireEvent.click(doneBtn);

    expect(configureOpenRouter).toHaveBeenCalledTimes(1);

    resolveSave({ ...DEFAULT_APP_SETTINGS, ai: { ...DEFAULT_APP_SETTINGS.ai, openRouterModel: 'anthropic/claude-3.5-sonnet' } });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
