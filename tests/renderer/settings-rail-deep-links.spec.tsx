// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import {
  SETTINGS_RAIL,
  isSettingsRailEntryActive,
  settingsRailEntry,
  settingsRailProviderId,
} from '../../src/renderer/features/settings/settings-rail';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { DebugLogExportResult } from '@shared/schemas/ipc';
import { testAgentProfile } from '../helpers/agent-profile';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';

const onClose = vi.fn();

describe('settings rail', () => {
  it('names AI providers, agent working directories and custom agent profiles', () => {
    const labels = SETTINGS_RAIL.map((entry) => entry.label);
    expect(labels).toContain('AI Providers');
    expect(labels).toContain('Agent Working Directories');
    expect(labels).toContain('Custom Profiles');
    // No rail label may contain another's: two entries share the profiles
    // panel, and a name that matched both would make either unaddressable.
    for (const label of labels) {
      expect(labels.filter((other) => other.includes(label))).toEqual([label]);
    }
    expect(new Set(SETTINGS_RAIL.map((entry) => entry.id)).size).toBe(SETTINGS_RAIL.length);
  });

  it('maps a deep link to one section', () => {
    expect(settingsRailEntry('working-directories').section).toBe('working-directories');
    expect(settingsRailEntry('custom-profiles').section).toBe('custom-profiles');
    // Built-in profiles no longer have a page: the legacy link lands on the
    // providers list that now owns those settings.
    expect(settingsRailEntry('profiles').section).toBe('ai');
  });

  it('has no rail entry for built-in agent profiles', () => {
    expect(SETTINGS_RAIL.some((entry) => entry.id === 'profiles')).toBe(false);
  });

  it('opens the provider row a deep link names', () => {
    expect(settingsRailProviderId('ai')).toBe('openrouter');
    expect(settingsRailProviderId('profiles')).toBe('codex');
    expect(settingsRailProviderId('custom-profiles')).toBeNull();
    expect(settingsRailProviderId('working-directories')).toBeNull();
    // A provider-scoped link opens that provider's own row in AI Providers.
    expect(settingsRailProviderId('ai:claude-code')).toBe('claude-code');
    expect(settingsRailEntry('ai:claude-code').section).toBe('ai');
  });

  it('marks the entry whose section is showing active', () => {
    const ai = settingsRailEntry('ai');
    const custom = settingsRailEntry('custom-profiles');
    expect(isSettingsRailEntryActive(ai, 'ai')).toBe(true);
    expect(isSettingsRailEntryActive(custom, 'ai')).toBe(false);
    expect(isSettingsRailEntryActive(custom, 'custom-profiles')).toBe(true);
  });
});

describe('openSettings deep links', () => {
  afterEach(() => {
    useUiStore.setState({ settingsOpen: false, settingsTarget: 'ai' });
  });

  it('opens the dialog on the named section', () => {
    useUiStore.getState().openSettings('working-directories');
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTarget).toBe('working-directories');

    useUiStore.getState().openSettings('custom-profiles');
    expect(useUiStore.getState().settingsTarget).toBe('custom-profiles');
  });
});

describe('Settings dialog rail sections', () => {
  const exportDebugLog = vi.fn<() => Promise<DebugLogExportResult>>(() => Promise.resolve({ status: 'cancelled' }));

  beforeEach(() => {
    vi.clearAllMocks();
    stubBridge({
      app: { exportDebugLog },
      ai: {
        listProviders: vi.fn(() => Promise.resolve([])),
        signInWithChatGPT: vi.fn(),
        listOpenRouterModels: vi.fn(() => Promise.resolve([])),
        configureOpenRouter: vi.fn(),
      },
      credentials: {
        getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)),
        testOpenRouterConnection: vi.fn(),
      },
      settings: {
        get: vi.fn(() => Promise.resolve(structuredClone(DEFAULT_APP_SETTINGS))),
        update: vi.fn((next) => Promise.resolve(next)),
      },
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([testAgentProfile('codex', 'Codex', { reasoningSelection: true })])),
        listCustomProfiles: vi.fn(() => Promise.resolve([])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('is the only settings surface, and lists every rail section once', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} onProvidersChanged={vi.fn()} initialTarget="ai" />);
    await screen.findByRole('dialog', { name: 'Settings' });

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const entry of SETTINGS_RAIL) {
      expect(screen.getAllByTestId(`settings-rail-${entry.id}`)).toHaveLength(1);
    }
    expect(rail.textContent).toContain('Agent Working Directories');
    expect(rail.textContent).toContain('Custom Profiles');
  });

  it('opens directly on agent working directories when deep-linked', async () => {
    const { container } = render(
      <AIProviderSettingsModal open={true} onClose={onClose} initialTarget="working-directories" onProvidersChanged={vi.fn()} />
    );
    await screen.findByRole('dialog', { name: 'Settings' });

    expect(await screen.findByRole('heading', { name: 'Agent Working Directories' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Working Directory Defaults' })).toBeTruthy();
    expect(screen.getByTestId('settings-rail-working-directories').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('agent-profile-selector')).toBeNull();
    expect(screen.queryByTestId('profile-editor-codex')).toBeNull();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('opens the named provider row from a provider-scoped link', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} initialTarget="ai:claude-code" onProvidersChanged={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Settings' });

    expect(screen.getByTestId('settings-rail-ai').getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByTestId('provider-panel-claude-code')).toBeTruthy();
    expect(screen.getByTestId('provider-summary-claude-code').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('provider-summary-codex').getAttribute('aria-expanded')).toBe('false');
  });

  it('routes the legacy built-in profiles link to its provider row', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} initialTarget="profiles" onProvidersChanged={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Settings' });

    expect(screen.getByTestId('settings-rail-ai').getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByTestId('provider-panel-codex')).toBeTruthy();
    expect(screen.getByTestId('provider-summary-codex').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('profile-editor-codex')).toHaveLength(1);
  });

  it('opens directly on custom agent profiles when deep-linked, without a second surface', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} initialTarget="custom-profiles" onProvidersChanged={vi.fn()} />);
    await screen.findByRole('dialog', { name: 'Settings' });

    expect(await screen.findByRole('heading', { name: 'Your custom profiles' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Your custom profiles' })).toHaveLength(1);
    expect(screen.getByTestId('settings-rail-custom-profiles').getAttribute('aria-pressed')).toBe('true');
    // Built-in profiles live in their provider rows, so this page holds only
    // custom profiles and never a second built-in selector or editor.
    expect(screen.queryByTestId('agent-profile-selector')).toBeNull();
    expect(screen.queryByTestId('profile-editor-codex')).toBeNull();
  });

  it('navigates between rail sections without leaving a stale panel mounted', async () => {
    render(<AIProviderSettingsModal open={true} onClose={onClose} initialTarget="custom-profiles" onProvidersChanged={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Your custom profiles' });

    fireEvent.click(screen.getByTestId('settings-rail-working-directories'));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Your custom profiles' })).toBeNull();
    });
    expect(screen.getByRole('heading', { name: 'Working Directory Defaults' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-rail-ai'));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Working Directory Defaults' })).toBeNull();
    });
    expect(screen.getByTestId('provider-summary-openrouter')).toBeTruthy();
  });
});
