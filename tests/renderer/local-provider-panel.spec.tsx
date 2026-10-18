// @vitest-environment jsdom
/**
 * Settings surface for the loopback server provider.
 *
 * The renderer holds no network capability here: it edits settings and reads a
 * main-owned status, so these tests assert what the user is told and what is
 * saved, not what is fetched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { LocalProviderPanel } from '../../src/renderer/features/chat/LocalProviderPanel';
import { deriveProviderRows } from '../../src/renderer/features/chat/provider-rows';
import { PROFILE_EDITOR_DEFINITIONS } from '../../src/renderer/features/agent/profile-preferences';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { DEFAULT_LOCAL_ENDPOINT } from '@shared/schemas/local-endpoint';
import type { AIProviderStatus } from '@shared/types/ai';
import { chooseValue, optionNames } from '../helpers/listbox-select';

afterEach(cleanup);

function appSettings(local: Partial<AppSettings['ai']['local']> = {}): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    ai: { ...DEFAULT_APP_SETTINGS.ai, local: { ...DEFAULT_APP_SETTINGS.ai.local, ...local } },
  };
}

function localStatus(overrides: Partial<AIProviderStatus> = {}): AIProviderStatus {
  return {
    id: 'local',
    name: 'Local server (loopback)',
    available: true,
    installed: true,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: [
      { id: 'qwen3:8b', name: 'qwen3:8b', contextWindow: 40_960, maxOutputTokens: 2_048, supportsStreaming: true },
      { id: 'llama3.2', name: 'llama3.2', contextWindow: 8_192, maxOutputTokens: 2_048, supportsStreaming: true },
    ],
    capabilities: {
      streaming: true,
      subscriptionAuth: false,
      apiKeyAuth: false,
      persistentSessions: false,
      toolFreeMode: true,
      hostedWebSearch: false,
    },
    ...overrides,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof LocalProviderPanel>[0]> = {}) {
  const onSettingsChange = vi.fn();
  const onCheckConnection = vi.fn();
  const props = {
    settings: appSettings(),
    onSettingsChange,
    status: localStatus(),
    settingsReady: true,
    checking: false,
    onCheckConnection,
    ...overrides,
  };
  render(<LocalProviderPanel {...props} />);
  return { onSettingsChange, onCheckConnection };
}

describe('Local provider settings panel', () => {
  it('saves a canonical endpoint rather than the exact text typed', () => {
    const { onSettingsChange } = renderPanel({ settings: appSettings({ endpoint: 'http://127.0.0.1:1234' }) });

    fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://[0:0:0:0:0:0:0:1]:11434/' } });
    fireEvent.click(screen.getByTestId('local-endpoint-save-button'));

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const next = onSettingsChange.mock.calls[0]?.[0] as AppSettings;
    expect(next.ai.local.endpoint).toBe('http://[::1]:11434');
    // The catalog belongs to the old server, so the saved model is cleared.
    expect(next.ai.local.model).toBeNull();
  });

  it('explains a rejected address and refuses to save it', () => {
    const { onSettingsChange } = renderPanel();
    const input = screen.getByTestId('local-endpoint-input');

    fireEvent.change(input, { target: { value: 'http://localhost:11434' } });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert').textContent).toMatch(/Only 127\.0\.0\.1 and \[::1\]/u);
    expect(screen.getByTestId('local-endpoint-save-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('local-endpoint-save-button'));
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('names the rejection for each kind of address a user may try', () => {
    renderPanel();
    const input = screen.getByTestId('local-endpoint-input');
    const cases: readonly (readonly [string, RegExp])[] = [
      ['https://127.0.0.1:11434', /Use http:\/\//u],
      ['http://user:pass@127.0.0.1:11434', /Remove the username and password/u],
      ['http://127.0.0.1:11434/v1', /no path, query, or #fragment/u],
      ['http://192.168.1.10:11434', /Only 127\.0\.0\.1 and \[::1\]/u],
    ];
    for (const [value, message] of cases) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole('alert').textContent, value).toMatch(message);
    }
  });

  it('keeps the save action inert until the address actually changes', () => {
    renderPanel({ settings: appSettings({ endpoint: DEFAULT_LOCAL_ENDPOINT }) });
    expect(screen.getByTestId('local-endpoint-save-button')).toBeDisabled();

    fireEvent.change(screen.getByTestId('local-endpoint-input'), { target: { value: 'http://127.0.0.1:8080' } });
    expect(screen.getByTestId('local-endpoint-save-button')).toBeEnabled();
  });

  it('clears the selected model when the server type changes', () => {
    const { onSettingsChange } = renderPanel({ settings: appSettings({ mode: 'ollama', model: 'qwen3:8b' }) });

    chooseValue(screen.getByTestId('local-mode-select'), 'openai-compatible');

    const next = onSettingsChange.mock.calls[0]?.[0] as AppSettings;
    expect(next.ai.local.mode).toBe('openai-compatible');
    expect(next.ai.local.model).toBeNull();
  });

  it('offers the models main reported, and saves the chosen one', () => {
    const { onSettingsChange } = renderPanel();
    const select = screen.getByTestId('local-model-select');
    expect(optionNames(select))
      .toEqual(['Use the first available model', 'qwen3:8b', 'llama3.2']);

    chooseValue(select, 'llama3.2');
    expect((onSettingsChange.mock.calls[0]?.[0] as AppSettings).ai.local.model).toBe('llama3.2');
  });

  it('reports each connection state in words a loopback server can be in', () => {
    const status = () => screen.getByTestId('local-connection-status').textContent;

    renderPanel({ status: undefined });
    expect(status()).toBe('Not checked yet.');
    cleanup();

    renderPanel({ checking: true });
    expect(status()).toBe('Checking the server…');
    cleanup();

    renderPanel({ status: localStatus({ installed: false, available: false, models: [], errorMessage: 'No local server is listening at that address.' }) });
    expect(status()).toBe('No server responded at that address.');
    // Never "sign in": a loopback server holds no account.
    expect(screen.getByTestId('local-status-error').textContent).toBe('No local server is listening at that address.');
    cleanup();

    renderPanel({ status: localStatus({ models: [] }) });
    expect(status()).toBe('Connected, but the server offers no models.');
    expect(screen.getByTestId('local-model-select')).toBeDisabled();
    cleanup();

    renderPanel();
    expect(status()).toBe('Connected — 2 models available.');
  });

  it('runs the read-only check on request, and not while one is running', () => {
    const { onCheckConnection } = renderPanel();
    fireEvent.click(screen.getByTestId('local-test-connection-button'));
    expect(onCheckConnection).toHaveBeenCalledTimes(1);
    cleanup();

    renderPanel({ checking: true });
    expect(screen.getByTestId('local-test-connection-button')).toBeDisabled();
    expect(screen.getByTestId('local-test-connection-button').textContent).toBe('Checking…');
  });

  it('disables every control until settings have loaded', () => {
    renderPanel({ settingsReady: false });
    for (const id of ['local-mode-select', 'local-endpoint-input', 'local-endpoint-save-button', 'local-model-select', 'local-test-connection-button']) {
      expect(screen.getByTestId(id), id).toBeDisabled();
    }
  });

  it('states what "local" guarantees and what only the runtime can settle', () => {
    renderPanel();
    const disclosure = screen.getByTestId('local-routing-disclosure').textContent;
    expect(disclosure).toMatch(/connects only to a loopback address/u);
    // The honest limit, stated rather than implied.
    expect(disclosure).toMatch(/cloud-capable model/u);
    expect(disclosure).toMatch(/OLLAMA_NO_CLOUD=1/u);
    // No promise Interleaf cannot keep.
    expect(disclosure).not.toMatch(/offline|never leaves|fully private/iu);
  });

  it('has no detectable accessibility violations', async () => {
    renderPanel({ status: localStatus({ installed: false, models: [], errorMessage: 'No local server is listening at that address.' }) });
    const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('Local provider row', () => {
  it('reports reachability rather than authentication', () => {
    const row = (providers: readonly AIProviderStatus[]) =>
      deriveProviderRows({ providers, profiles: [], openRouterCredential: 'absent' })
        .find((candidate) => candidate.id === 'local');

    expect(row([])).toMatchObject({ statusLabel: 'Checking…', tone: 'unavailable', readerChat: true, kind: 'local' });
    expect(row([localStatus({ installed: false, available: false, models: [] })]))
      .toMatchObject({ statusLabel: 'Not reachable', tone: 'unavailable' });
    expect(row([localStatus({ models: [] })])).toMatchObject({ statusLabel: 'No models', tone: 'attention' });
    expect(row([localStatus()])).toMatchObject({ statusLabel: 'Ready', tone: 'ready' });
    // A local server has no version Interleaf can trust or needs to show.
    expect(row([localStatus()])?.version).toBeNull();
  });

  it('keeps both new providers out of Agent Mode', () => {
    // Reader Chat only: neither the loopback server nor Omp gains an execution
    // profile, so neither can run anything on this machine.
    const ids: readonly string[] = PROFILE_EDITOR_DEFINITIONS.map((definition) => definition.id);
    expect(ids).not.toContain('local');
    expect(ids).not.toContain('omp');
  });
});
