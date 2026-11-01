// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { deriveProviderRows, loadingProviderRows, openRouterCredentialState, sanitizeProviderVersion } from '../../src/renderer/features/settings/provider-rows';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AIProviderStatus } from '@shared/types/ai';
import type { AppSettings } from '@shared/schemas/settings';
import type { InterleafAPI } from '@shared/types/api';
import type { OpenRouterKeyPreview } from '@shared/schemas/credential-preview';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS, USABLE_CREDENTIAL_STORAGE } from '../helpers/credential-status';

const onClose = vi.fn();

const codexReady: AIProviderStatus = {
  id: 'codex',
  name: 'Codex',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '0.51.0',
  errorMessage: null,
  models: [],
  capabilities: {
    streaming: true,
    subscriptionAuth: true,
    apiKeyAuth: false,
    persistentSessions: false,
    toolFreeMode: true,
    hostedWebSearch: false,
  },
};

describe('provider row derivation', () => {
  it('derives labels and tones from live status, never from mockup samples', () => {
    const rows = deriveProviderRows({
      providers: [codexReady, { ...codexReady, id: 'claude', name: 'Claude', authentication: 'disconnected', version: '2.1.0' }],
      profiles: [{ id: 'opencode', detection: { availability: 'installed', version: '1.2.3', checkedAt: '2026-09-07T00:00:00.000Z', errorMessage: null } }],
      openRouterCredential: 'absent',
    });
    const row = (id: string) => rows.find((candidate) => candidate.id === id);

    // Ready providers lead; the rest keep design order behind them.
    expect(rows.map((candidate) => candidate.id)).toEqual([
      'codex', 'openrouter', 'local', 'claude-code', 'antigravity', 'opencode', 'pi', 'cursor', 'omp',
    ]);
    expect(row('openrouter')).toMatchObject({ statusLabel: 'Not configured', tone: 'attention', version: null });
    expect(row('codex')).toMatchObject({ statusLabel: 'Ready', tone: 'ready', version: '0.51.0', readerChat: true });
    expect(row('claude-code')).toMatchObject({ statusLabel: 'Sign-in required', tone: 'attention', version: '2.1.0' });
    // Agent-only integrations say so, and report only whether the CLI is there.
    expect(row('opencode')).toMatchObject({ statusLabel: 'Agent Mode only', tone: 'ready', version: '1.2.3', readerChat: false });
    // Pi is a Reader Chat provider, so its row follows the live provider
    // status rather than mere CLI presence.
    expect(row('pi')).toMatchObject({ statusLabel: 'Not installed', tone: 'unavailable', version: null, readerChat: true });
    // Cursor is registered as a chat provider but is permanently chat-
    // unavailable, so its row is Agent-Mode-only like OpenCode.
    expect(row('cursor')).toMatchObject({ statusLabel: 'Agent Mode only', tone: 'unavailable', version: null, readerChat: false });
    expect(row('cursor')?.description).toContain('Agent Mode only');
    // Provider names drop "CLI".
    for (const candidate of rows) expect(candidate.name).not.toContain('CLI');
  });

  it('lists every Ready provider before the ones that are not ready', () => {
    const rows = deriveProviderRows({
      providers: [
        { ...codexReady, id: 'omp', name: 'Omp' },
        { ...codexReady, id: 'claude', name: 'Claude' },
        { ...codexReady, installed: false, available: false },
      ],
      // An installed Agent-Mode-only CLI is not a Ready chat provider.
      profiles: [{ id: 'opencode', detection: { availability: 'installed', version: '1.2.3', checkedAt: '2026-09-07T00:00:00.000Z', errorMessage: null } }],
      openRouterCredential: 'ready',
    });
    expect(rows.map((row) => row.id)).toEqual([
      'openrouter', 'claude-code', 'omp', 'local', 'codex', 'antigravity', 'opencode', 'pi', 'cursor',
    ]);
    const firstNotReady = rows.findIndex((row) => row.statusLabel !== 'Ready');
    expect(rows.slice(firstNotReady).some((row) => row.statusLabel === 'Ready')).toBe(false);
  });

  it('treats a reported version as untrusted process output', () => {
    const noisy = '\u001B[0m1.18.23\u001B[33m\nWarning: the NO_COLOR env is ignored, and this line is far too long to show';
    const rows = deriveProviderRows({
      providers: [],
      profiles: [{ id: 'opencode', detection: { availability: 'installed', version: noisy, checkedAt: '2026-09-07T00:00:00.000Z', errorMessage: null } }],
      openRouterCredential: 'absent',
    });
    const version = rows.find((row) => row.id === 'opencode')?.version ?? '';
    expect(version).toBe('1.18.23');
    expect(version).not.toMatch(/[\u0000-\u001F\u007F]/u);
    expect(sanitizeProviderVersion(`v${'9'.repeat(60)}`)).toHaveLength(32);
    expect(sanitizeProviderVersion('\u001B[31m\u001B[0m')).toBeNull();
    expect(sanitizeProviderVersion(undefined)).toBeNull();
  });

  it('reports an unresolved first load as Checking, with no sampled versions', () => {
    for (const row of loadingProviderRows()) {
      expect(row.statusLabel).toBe('Checking…');
      expect(row.version).toBeNull();
    }
  });

  it('marks a configured key ready and a missing Reader Chat CLI unavailable', () => {
    const rows = deriveProviderRows({ providers: [{ ...codexReady, installed: false, available: false }], profiles: [], openRouterCredential: 'ready' });
    expect(rows[0]).toMatchObject({ id: 'openrouter', statusLabel: 'Ready', tone: 'ready' });
    expect(rows.find((row) => row.id === 'codex')).toMatchObject({ statusLabel: 'Not installed', tone: 'unavailable' });
  });

  it('never reports a stored-but-unreadable key as ready', () => {
    // Main's fail-closed result: the credential exists, its masked preview
    // could not be derived, so it cannot serve a call.
    expect(openRouterCredentialState({ configured: true, keyPreview: null })).toBe('stored-unreadable');
    expect(openRouterCredentialState({ configured: false, keyPreview: null })).toBe('absent');
    expect(openRouterCredentialState({ configured: true, keyPreview: { prefix: 'sk-or-v1', lastFour: 'mnop' } })).toBe('ready');

    const rows = deriveProviderRows({ providers: [], profiles: [], openRouterCredential: 'stored-unreadable' });
    expect(rows[0]).toMatchObject({ id: 'openrouter', statusLabel: 'Saved key unreadable', tone: 'attention' });
  });
});

describe('Settings provider accordion', () => {
  let configured = false;
  let keyPreview: OpenRouterKeyPreview | null = null;
  const configureOpenRouter = vi.fn<InterleafAPI['ai']['configureOpenRouter']>(
    () => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))
  );
  const clearOpenRouterKey = vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS));
  const listProviders = vi.fn<InterleafAPI['ai']['listProviders']>(() => Promise.resolve([codexReady]));

  beforeEach(() => {
    vi.clearAllMocks();
    configured = false;
    keyPreview = { prefix: 'sk-or-v1', lastFour: 'mnop' };
    stubBridge({
      ai: {
        listProviders,
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter,
        signInWithChatGPT: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(
          configured ? { configured: true, keyPreview, storageBackend: USABLE_CREDENTIAL_STORAGE } : UNCONFIGURED_CREDENTIAL_STATUS
        )),
        clearOpenRouterKey,
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

  it('exposes summaries as keyboard-operable buttons with correct ARIA wiring', async () => {
    const { container } = render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    const summary = await screen.findByTestId('provider-summary-codex');

    expect(summary.tagName).toBe('BUTTON');
    expect(summary).toHaveAttribute('aria-controls', 'provider-panel-codex');
    expect(summary).toHaveAttribute('aria-expanded', 'false');

    summary.focus();
    fireEvent.keyDown(summary, { key: 'Enter' });
    fireEvent.click(summary);
    const panel = await screen.findByTestId('provider-panel-codex');
    expect(panel).toHaveAttribute('aria-labelledby', 'provider-summary-codex');
    expect(summary).toHaveAttribute('aria-expanded', 'true');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('probes providers again on open instead of reading main\'s cached readiness', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('provider-summary-codex');

    // Settings is where a reader checks what is installed and signed in now.
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listProviders).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('never renders a status pill, DEFAULT badge or unimplemented connection action', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('provider-summary-codex');
    fireEvent.click(screen.getByTestId('provider-summary-codex'));
    await screen.findByTestId('provider-panel-codex');

    expect(screen.queryByText('DEFAULT')).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-?check/iu })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out/iu })).toBeNull();
    expect(screen.queryByTestId('refresh-ai-providers-button')).toBeNull();
  });

  it('opens and focuses OpenRouter configuration from Add provider', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    // The dialog claims initial focus on its first frame; let that land before
    // asserting where Add provider puts focus.
    await waitFor(() => { expect(document.activeElement).not.toBe(document.body); });
    // Start from a different row so Add provider has to reopen OpenRouter.
    fireEvent.click(await screen.findByTestId('provider-summary-codex'));
    await screen.findByTestId('provider-panel-codex');

    fireEvent.click(screen.getByTestId('add-provider-button'));
    const keyInput = await screen.findByTestId('openrouter-key-input');
    await waitFor(() => { expect(document.activeElement).toBe(keyInput); });
    expect(screen.queryByTestId('provider-panel-codex')).toBeNull();
  });

  it('hides the Add provider action once the API provider is configured', async () => {
    configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('openrouter-key-preview');
    expect(screen.queryByTestId('add-provider-button')).toBeNull();
  });

  it('tells the truth about a stored key it cannot read, and keeps recovery available', async () => {
    configured = true;
    keyPreview = null;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('openrouter-key-preview');

    // Neither the chip nor the row may claim a usable credential.
    expect(screen.getByTestId('openrouter-key-state')).toHaveTextContent('Unreadable');
    expect(screen.getByTestId('openrouter-key-state')).not.toHaveTextContent('Saved');
    expect(screen.getByTestId('openrouter-key-unreadable')).toBeInTheDocument();
    expect(screen.getByTestId('provider-summary-openrouter')).toHaveTextContent('Saved key unreadable');
    expect(screen.getByTestId('provider-summary-openrouter')).not.toHaveTextContent(/\bReady\b/u);
    // It cannot support a call, so the connection test is not offered as usable.
    expect(screen.getByTestId('test-openrouter-button')).toBeDisabled();
    // Both recovery paths are offered directly: type over it, or remove it.
    // There is one password field, and no separate replacement mode to enter.
    const field = screen.getByTestId('openrouter-key-input');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('openrouter-key-input')).toHaveLength(1);
    expect(screen.queryByTestId('replace-openrouter-key-button')).toBeNull();
    expect(screen.getByTestId('remove-openrouter-key-button')).toBeInTheDocument();
    // The field starts empty: the masked preview is never fed back in as if it
    // were the secret the reader is editing.
    expect(field).toHaveValue('');
    // Only the placeholder mask is rendered; no key material of any kind.
    expect(screen.getByTestId('openrouter-key-preview')).toHaveTextContent('sk-or-v1 ···· ···· ····');
  });

  it('shows a readable stored key as saved, ready and testable', async () => {
    configured = true;
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByTestId('openrouter-key-preview');

    expect(screen.getByTestId('openrouter-key-state')).toHaveTextContent('Saved');
    expect(screen.queryByTestId('openrouter-key-unreadable')).toBeNull();
    expect(screen.getByTestId('test-openrouter-button')).toBeEnabled();
    expect(screen.getByTestId('provider-summary-openrouter')).toHaveTextContent('Ready');
  });
});
