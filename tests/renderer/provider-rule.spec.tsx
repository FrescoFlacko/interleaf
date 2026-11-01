// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentProfile } from '@shared/types/agent';
import type { AIProviderStatus } from '@shared/types/ai';
import type { AppSettings } from '@shared/schemas/settings';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { AgentProfileNotes, AgentProfilePicker, AgentRuntimeEmptyState } from '../../src/renderer/features/agent/AgentProfileField';
import { agentProfileView } from '../../src/renderer/features/agent/agent-profile-view';
import { directoryProfiles } from '../../src/renderer/features/agent/working-directory-options';
import { AIProviderSettingsModal } from '../../src/renderer/features/settings/AIProviderSettingsModal';
import { deriveProviderRows, groupProviderRows } from '../../src/renderer/features/settings/provider-rows';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { UNCONFIGURED_CREDENTIAL_STATUS } from '../helpers/credential-status';
import { optionValues } from '../helpers/listbox-select';

/*
 * The provider rule: Settings gathers absent integrations under a collapsed
 * "Not installed (n)" group; execution pickers never offer an absent
 * integration; a stored choice that has gone missing stays visible and is
 * flagged, never silently replaced.
 */

function profile(id: AgentProfile['providerId'], availability: AgentProfile['detection']['availability']): AgentProfile {
  return {
    id,
    providerId: id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    defaultModel: null,
    availableModels: [],
    reasoningEffort: null,
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: {
      availability,
      version: availability === 'installed' ? '1.0.0' : null,
      checkedAt: '2026-10-06T00:00:00.000Z',
      errorMessage: availability === 'installed' ? null : 'Executable not found',
    },
    isCustom: false,
    unsafe: false,
  };
}

function renderAgentPicker(profiles: readonly AgentProfile[], selectedProfileId: string | null): void {
  useAgentStore.setState({ profiles: [...profiles], selectedProfileId });
  render(<><AgentProfilePicker disabled={false} /><AgentProfileNotes /></>);
}

function renderRunSettings(profiles: readonly AgentProfile[], selectedProfileId: string | null): void {
  useAgentStore.setState({ profiles: [...profiles], selectedProfileId });
  const view = agentProfileView(profiles, selectedProfileId);
  if (view.kind !== 'none-installed') throw new Error(`expected no installed agent, got ${view.kind}`);
  render(<AgentRuntimeEmptyState stale={view.stale} />);
}

describe('Agent profile picker', () => {
  afterEach(() => { cleanup(); });

  it('offers installed agents only', () => {
    renderAgentPicker([profile('codex', 'installed'), profile('opencode', 'not-installed'), profile('pi', 'installed')], 'codex');
    expect(optionValues(screen.getByRole('combobox', { name: 'Agent profile' }))).toEqual(['codex', 'pi']);
    expect(screen.queryByTestId('agent-profile-unavailable')).toBeNull();
  });

  it('keeps a stale stored choice on the trigger and flags it, without listing it', () => {
    renderAgentPicker([profile('codex', 'installed'), profile('opencode', 'not-installed')], 'opencode');
    const picker = screen.getByRole('combobox', { name: 'Agent profile' });
    expect(picker).toHaveTextContent('Opencode');
    expect(picker).toHaveAttribute('data-value', 'opencode');
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('agent-profile-unavailable')).toHaveTextContent('Not installed');
    expect(optionValues(picker)).toEqual(['codex']);
    // Listing the options never swaps the stored choice for another agent.
    expect(useAgentStore.getState().selectedProfileId).toBe('opencode');
  });

  it('flags a stored choice whose detection failed as unavailable', () => {
    renderAgentPicker([profile('codex', 'installed'), profile('opencode', 'error')], 'opencode');
    expect(screen.getByTestId('agent-profile-unavailable')).toHaveTextContent('Unavailable');
  });

  it('shows a generic empty state that links to AI Providers when nothing is installed', () => {
    useUiStore.setState({ settingsOpen: false });
    renderRunSettings([profile('codex', 'not-installed')], null);
    const empty = screen.getByTestId('agent-profile-empty');
    expect(empty).toHaveTextContent('No agent runtime installed');
    expect(screen.getByTestId('agent-profile-caption')).toHaveTextContent('Install a coding agent such as Codex or Claude Code, then restart Interleaf so it can find it.');
    expect(screen.queryByRole('combobox', { name: 'Agent profile' })).toBeNull();
    // Nothing was chosen, so nothing is called a missing saved choice.
    expect(screen.queryByTestId('agent-profile-saved-choice')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-open-provider-settings'));
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTarget: 'ai' });
  });

  it('still names a real saved choice that went missing when nothing is installed', () => {
    renderRunSettings([profile('codex', 'not-installed'), profile('opencode', 'not-installed')], 'opencode');
    expect(screen.getByTestId('agent-profile-empty')).toBeInTheDocument();
    expect(screen.getByTestId('agent-profile-saved-choice')).toHaveTextContent('Your saved agent, Opencode, was not found.');
    expect(screen.getByTestId('agent-profile-unavailable')).toHaveTextContent('Not installed');
  });
});

describe('Settings provider grouping', () => {
  const codexReady: AIProviderStatus = {
    id: 'codex', name: 'Codex', available: true, installed: true, authentication: 'connected', version: '0.51.0',
    errorMessage: null, models: [],
    capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
  };

  it('splits absent integrations from present ones, each keeping the ready-first order', () => {
    const rows = deriveProviderRows({ providers: [codexReady], profiles: [], openRouterCredential: 'absent' });
    const { present, notInstalled } = groupProviderRows(rows);
    expect(present.length + notInstalled.length).toBe(rows.length);
    expect(present.map((row) => row.id)).toEqual(rows.filter((row) => !row.notInstalled).map((row) => row.id));
    expect(present[0]?.id).toBe('codex');
    expect(present.map((row) => row.id)).toEqual(expect.arrayContaining(['openrouter', 'local']));
    expect(notInstalled.map((row) => row.id)).toContain('omp');
    expect(notInstalled.every((row) => row.kind !== 'openrouter' && row.kind !== 'local')).toBe(true);
  });

  it('never hides a profile whose detection failed: it needs attention, not installing', () => {
    const rows = deriveProviderRows({
      providers: [],
      profiles: [{ id: 'opencode', detection: { availability: 'error', version: null, checkedAt: '2026-10-06T00:00:00.000Z', errorMessage: 'probe failed' } }],
      openRouterCredential: 'absent',
    });
    expect(groupProviderRows(rows).present.map((row) => row.id)).toContain('opencode');
  });

  describe('in the AI Providers section', () => {
    beforeEach(() => {
      stubBridge({
        ai: { listProviders: vi.fn(() => Promise.resolve([codexReady])), listOpenRouterModels: vi.fn(() => Promise.resolve([])) },
        credentials: { getOpenRouterStatus: vi.fn(() => Promise.resolve(UNCONFIGURED_CREDENTIAL_STATUS)) },
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
    afterEach(() => { cleanup(); });

    it('collapses absent integrations under one counted disclosure', async () => {
      render(<AIProviderSettingsModal open={true} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      const toggle = await screen.findByTestId('provider-not-installed-toggle');
      const group = document.getElementById('provider-not-installed-list');
      expect(group).not.toBeNull();
      const absent = group!.querySelectorAll('[id^="provider-summary-"]');
      expect(absent.length).toBeGreaterThan(0);
      expect(toggle).toHaveTextContent(`Not installed (${String(absent.length)})`);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'provider-not-installed-list');
      expect(group).not.toBeVisible();
      // The installed provider is outside the group, in the list itself.
      expect(group).not.toContainElement(screen.getByTestId('provider-summary-codex'));

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(group).toBeVisible();
    });

    it('honours the reader collapsing the group while one of its rows is open', async () => {
      render(<AIProviderSettingsModal open={true} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="ai" />);
      const toggle = await screen.findByTestId('provider-not-installed-toggle');
      const group = document.getElementById('provider-not-installed-list')!;
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-summary-omp'));
      expect(screen.getByTestId('provider-panel-omp')).toBeVisible();

      // An open row inside no longer pins the group open.
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(group).not.toBeVisible();
      // Collapsing hides the rows without closing the open one, so it is
      // still open (with whatever it held) when the group is expanded again.
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('provider-panel-omp')).toBeVisible();
      expect(screen.getByTestId('provider-summary-omp')).toHaveAttribute('aria-expanded', 'true');
    });

    it('opens the group for a deep link to one of its rows', async () => {
      render(<AIProviderSettingsModal open={true} onClose={vi.fn()} onProvidersChanged={vi.fn()} initialTarget="profiles" />);
      const toggle = await screen.findByTestId('provider-not-installed-toggle');
      const deepLinked = document.querySelector('#provider-not-installed-list [aria-expanded="true"]');
      // The default built-in profile is the deep link; when it is absent the
      // group opens for it, and when it is installed the group stays closed.
      expect(toggle).toHaveAttribute('aria-expanded', deepLinked === null ? 'false' : 'true');
    });
  });
});

describe('Working-directory default rows', () => {
  it('list installed agents plus an absent one that already has a stored default, marked', () => {
    const profiles = [profile('codex', 'installed'), profile('opencode', 'not-installed'), profile('pi', 'not-installed')];
    expect(directoryProfiles(profiles, { opencode: 'dir-handle' })).toEqual([
      profiles[0],
      { id: 'opencode', name: 'Opencode (not installed)' },
    ]);
  });
});
