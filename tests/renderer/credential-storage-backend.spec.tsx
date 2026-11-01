// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import {
  credentialStorageNotice,
  openRouterKeyIssue,
} from '../../src/renderer/features/settings/credential-storage-ux';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { CredentialStorageStatus } from '@shared/schemas/credential-preview';
import { stubBridge } from '../helpers/interleaf-api';

const onClose = vi.fn();
const configureOpenRouter = vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS)));

const UNAVAILABLE: CredentialStorageStatus = {
  available: false,
  backend: 'unknown',
  platform: 'linux',
};

/** What main reports on a healthy Omarchy session with gnome-keyring unlocked. */
const AVAILABLE: CredentialStorageStatus = {
  available: true,
  backend: 'gnome_libsecret',
  platform: 'linux',
};

describe('credential storage backend in Settings', () => {
  let storageBackend: CredentialStorageStatus;

  beforeEach(() => {
    vi.clearAllMocks();
    storageBackend = UNAVAILABLE;
    stubBridge({
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter,
        signInWithChatGPT: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve({ configured: false, keyPreview: null, storageBackend })),
        clearOpenRouterKey: vi.fn(() => Promise.resolve({ configured: false, keyPreview: null, storageBackend })),
        testOpenRouterConnection: vi.fn(() => Promise.resolve({ success: true, message: 'ok' })),
      },
      settings: {
        get: vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))),
        update: vi.fn((next: AppSettings) => Promise.resolve(next)),
      },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  async function openOpenRouterPanel(): Promise<HTMLElement> {
    // Settings opens on the AI section with the OpenRouter row already
    // expanded, so the key field is the panel's first state.
    const { container } = render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('openrouter-key-input');
    return container;
  }

  it('explains an unavailable store, names the Omarchy remedy, and closes the key field', async () => {
    const container = await openOpenRouterPanel();

    const notice = screen.getByTestId('openrouter-storage-unavailable');
    expect(notice.textContent).toMatch(/Credential storage is unavailable/u);
    expect(notice.textContent).toMatch(/gnome-keyring/u);
    expect(notice.textContent).toMatch(/pacman -S gnome-keyring libsecret/u);

    const input = screen.getByTestId('openrouter-key-input');
    expect(input).toBeDisabled();
    // The explanation is announced with the field rather than sitting beside it.
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain('openrouter-storage-note');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('lets Done close the dialog without demanding a key it cannot store', async () => {
    await openOpenRouterPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(configureOpenRouter).not.toHaveBeenCalled();
    expect(screen.queryByText('Please enter a valid API key.')).toBeNull();
  });

  it('says nothing when the store is usable', async () => {
    storageBackend = AVAILABLE;
    await openOpenRouterPanel();
    expect(screen.queryByTestId('openrouter-storage-unavailable')).toBeNull();
    expect(screen.getByTestId('openrouter-key-input')).not.toBeDisabled();
  });
});

describe('credentialStorageNotice', () => {
  it('stays silent for an unread or usable store', () => {
    expect(credentialStorageNotice(null)).toBeNull();
    expect(credentialStorageNotice(AVAILABLE)).toBeNull();
  });

  it('names the plaintext backend distinctly from a missing secret service', () => {
    expect(credentialStorageNotice({ available: false, backend: 'basic_text', platform: 'linux' }))
      .toMatch(/keeps secrets in plaintext/u);
    expect(credentialStorageNotice(UNAVAILABLE)).toMatch(/no OS secret service was found/u);
  });

  it('does not give Arch instructions on other platforms', () => {
    const notice = credentialStorageNotice({ available: false, backend: 'unknown', platform: 'darwin' });
    expect(notice).toMatch(/cannot be saved/u);
    expect(notice).not.toMatch(/pacman/u);
  });
});

describe('openRouterKeyIssue', () => {
  it('does not demand a key the machine cannot store', () => {
    expect(openRouterKeyIssue({ storageBlocked: true, configured: false, draft: '' })).toBeNull();
    expect(openRouterKeyIssue({ storageBlocked: false, configured: false, draft: '' }))
      .toBe('Please enter a valid API key.');
  });

  it('refuses a typed key while storage is unavailable', () => {
    expect(openRouterKeyIssue({ storageBlocked: true, configured: false, draft: 'sk-or-v1-abc' }))
      .toMatch(/Credential storage is unavailable/u);
  });

  it('still validates the key grammar on a usable store', () => {
    expect(openRouterKeyIssue({ storageBlocked: false, configured: false, draft: 'sk-or-v1-abc' })).toBeNull();
    expect(openRouterKeyIssue({ storageBlocked: false, configured: true, draft: 'nonsense' }))
      .toBe('Please enter a valid API key.');
  });
});
