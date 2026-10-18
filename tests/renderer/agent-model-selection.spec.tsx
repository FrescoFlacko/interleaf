// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import type { AgentProfile, AgentSession, AgentSessionDetail } from '@shared/types/agent';

import type { InterleafAPI } from '@shared/types/api';
import type { AppSettings } from '@shared/schemas/settings';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { mergeDefaultModelOptions } from '../../src/renderer/features/agent/model-options';
import { useAgentStore, reconcileSelectedModel } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { persistSettings, resetSettingsWriteQueueForTests } from '../../src/renderer/app/api-client';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { chooseValue, optionNames, optionValues } from '../helpers/listbox-select';

const fixtureDocument: DocumentMetadata = {
  id: 'doc-model',
  title: 'Model Doc',
  author: 'Author',
  format: 'pdf',
  storageMode: 'link',
  fileSize: 100,
  fileMtimeMs: 100,
  fileHash: 'hash',
  pageCount: 1,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};
/** The session a successful `agent:start` answers with for the codex profile. */
function runningSession(id: string, userPrompt: string, effectiveModel: string | null = null): AgentSession {
  return {
    id, documentId: fixtureDocument.id, profileId: 'codex', providerId: 'codex',
    targetDirectory: { handle: 'work-h', displayName: 'workspace' }, executionMode: 'isolated-copy',
    status: 'running', providerSessionId: null, userPrompt, contextSummary: null,
    finalReport: null, effectiveModel, effectiveReasoningEffort: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    eventCount: 0, environment: null,
  };
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}


function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'codex',
    providerId: 'codex',
    name: 'Codex',
    defaultModel: 'gpt-5-codex',
    availableModels: ['gpt-5-codex', 'gpt-5.1-codex'],
    reasoningEffort: null,
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
      modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false,
    unsafe: false,
    ...overrides,
  };
}

const codexProfile = makeProfile();
const claudeProfile = makeProfile({
  id: 'claude-code',
  providerId: 'claude-code',
  name: 'Claude Code',
  defaultModel: 'claude-opus-5',
  availableModels: ['claude-opus-5'],
});
const noModelProfile = makeProfile({
  id: 'opencode',
  providerId: 'opencode',
  name: 'OpenCode',
  defaultModel: null,
  availableModels: [],
  capabilities: { ...codexProfile.capabilities, modelSelection: false },
});

function resetAgentStore(): void {
  useAgentStore.setState({
    documentId: null,
    profiles: [],
    modeAvailability: [],
    selectedProfileId: null,
    selectedModel: null,
    workingDirectory: null,
    workingDirectories: [],
    activeSession: null,
    sessions: [],
    events: [],
    loading: false,
    stopping: false,
    error: null,
    hydrated: false,
  });
}

describe('reconcileSelectedModel', () => {
  const profiles = [codexProfile, claudeProfile, noModelProfile];

  it('retains a choice the newly selected profile also supports', () => {
    expect(reconcileSelectedModel(profiles, 'codex', 'gpt-5.1-codex')).toBe('gpt-5.1-codex');
  });

  it('falls back to the profile default when the choice is unsupported', () => {
    expect(reconcileSelectedModel(profiles, 'claude-code', 'gpt-5.1-codex')).toBe('claude-opus-5');
  });

  it('resolves to the provider default when the profile offers no models', () => {
    expect(reconcileSelectedModel(profiles, 'opencode', 'gpt-5-codex')).toBeNull();
  });

  it('resolves to the provider default when no profile is selected or the id is unknown', () => {
    expect(reconcileSelectedModel(profiles, null, 'gpt-5-codex')).toBeNull();
    expect(reconcileSelectedModel(profiles, 'missing', 'gpt-5-codex')).toBeNull();
  });

  it('never returns a default the profile does not actually offer', () => {
    const stale = makeProfile({ defaultModel: 'retired-model', availableModels: ['gpt-5-codex'] });
    expect(reconcileSelectedModel([stale], 'codex', null)).toBeNull();
  });
});

describe('agent store model selection', () => {
  beforeEach(() => { useReaderStore.setState({ session: testReaderSession(fixtureDocument) }); });
  afterEach(() => {
    useReaderStore.setState({ session: null });
    resetAgentStore();
    resetSettingsWriteQueueForTests();
  });

  it('rejects a model the selected profile does not offer', () => {
    useAgentStore.setState({ profiles: [codexProfile], selectedProfileId: 'codex', selectedModel: null });
    useAgentStore.getState().setSelectedModel('gpt-5.1-codex');
    expect(useAgentStore.getState().selectedModel).toBe('gpt-5.1-codex');
    useAgentStore.getState().setSelectedModel('some-unlisted-model');
    expect(useAgentStore.getState().selectedModel).toBe('gpt-5-codex');
  });

  it('reconciles the chosen model when the profile changes', () => {
    stubBridge({ agent: { getModeAvailability: vi.fn(() => Promise.resolve([])) } });
    useAgentStore.setState({ profiles: [codexProfile, claudeProfile], selectedProfileId: 'codex', selectedModel: 'gpt-5.1-codex' });
    useAgentStore.getState().setSelectedProfile('claude-code');
    expect(useAgentStore.getState().selectedModel).toBe('claude-opus-5');
  });

  it('sends the selected model to agent:start instead of a hard-coded null', async () => {
    const session = runningSession('session-model-1', 'do it', 'gpt-5.1-codex');
    const startSession = vi.fn(() => Promise.resolve({ session }));
    stubBridge({
      agent: {
        startSession,
        getSession: vi.fn(() => Promise.resolve({ ...session, events: [], artifacts: [] })),
      },
    });
    useAgentStore.setState({
      documentId: fixtureDocument.id,
      profiles: [codexProfile],
      selectedProfileId: 'codex',
      selectedModel: 'gpt-5.1-codex',
      workingDirectory: { handle: 'work-h', displayName: 'workspace' },
      hydrated: true,
    });

    await useAgentStore.getState().start('codex', 'auto-isolated', 'do it');

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'codex', model: 'gpt-5.1-codex' }));
  });

  it('drops a stale selection at launch when the refreshed profile no longer offers it', async () => {
    const startSession = vi.fn(() => Promise.reject(new Error('unused')));
    stubBridge({ agent: { startSession, getSession: vi.fn(() => Promise.resolve(null)) } });
    // The user picked a model, then a profile refresh removed it from settings.
    useAgentStore.setState({
      documentId: fixtureDocument.id,
      profiles: [makeProfile({ availableModels: ['gpt-5-codex'] })],
      selectedProfileId: 'codex',
      selectedModel: 'gpt-5.1-codex',
      workingDirectory: { handle: 'work-h', displayName: 'workspace' },
      hydrated: true,
    });

    await useAgentStore.getState().start('codex', 'auto-isolated', 'do it');

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5-codex' }));
    expect(useAgentStore.getState().selectedModel).toBe('gpt-5-codex');
  });
});

describe('AgentComposer model control', () => {
  beforeEach(() => { useReaderStore.setState({ session: testReaderSession(fixtureDocument) }); });
  afterEach(() => {
    cleanup();
    useReaderStore.setState({ session: null });
    resetAgentStore();
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
    resetSettingsWriteQueueForTests();
  });

  function mountApi(
    profiles: readonly AgentProfile[],
    update: (next: AppSettings) => Promise<AppSettings> = () => Promise.resolve(DEFAULT_APP_SETTINGS),
    initialSessions: readonly AgentSession[] = [],
    agent: Partial<InterleafAPI['agent']> = {},
  ): InterleafAPI {
    const api = testInterleafApi({
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([...profiles])),
        listSessions: vi.fn(() => Promise.resolve([...initialSessions])),
        listWorkingDirectories: vi.fn(() => Promise.resolve([])),
        getSession: vi.fn(() => Promise.resolve(null)),
        getModeAvailability: vi.fn(() => Promise.resolve([])),
        onEvent: vi.fn(() => () => undefined),
        ...agent,
      },
      settings: { get: vi.fn(() => Promise.resolve(DEFAULT_APP_SETTINGS)), update },
    });
    stubBridge(api);
    return api;
  }

  const launchDirectory = { handle: 'work-h', displayName: 'workspace', canonicalPath: '/workspace' };

  /** A hydrated codex composer with a chosen folder and a task, ready to Start. */
  function readyToLaunch(taskDraft: string): void {
    useAgentStore.setState({
      documentId: fixtureDocument.id,
      profiles: [codexProfile],
      selectedProfileId: 'codex',
      selectedModel: 'gpt-5-codex',
      workingDirectories: [launchDirectory],
      workingDirectory: launchDirectory,
      workingDirectorySource: 'session-override',
      hydrated: true,
    });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft } });
  }

  it('offers exactly the selected profile\'s available models beside the profile control', async () => {
    mountApi([codexProfile, claudeProfile]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [codexProfile, claudeProfile],
      selectedProfileId: 'codex', selectedModel: 'gpt-5-codex', hydrated: true,
    });

    render(<AgentComposer />);

    const modelSelect = await screen.findByRole('combobox', { name: 'Agent model' });
    expect(modelSelect).not.toBeDisabled();
    expect(optionNames(modelSelect))
      .toEqual(['Provider default', 'gpt-5-codex', 'gpt-5.1-codex']);
    expect(modelSelect).toHaveAttribute('data-value', 'gpt-5-codex');
    // The model control sits inside the same block as the profile control, so
    // the effective run configuration reads as one group without widening the drawer.
    const group = modelSelect.closest('[data-testid="agent-run-configuration"]');
    expect(group?.querySelector('#agent-profile')).not.toBeNull();
    expect(modelSelect.getAttribute('aria-describedby')).toBe('agent-model-help');

    const results = await axe.run(group ?? document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('disables the control and explains why when the profile has no model surface', async () => {
    mountApi([noModelProfile]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [noModelProfile],
      selectedProfileId: 'opencode', selectedModel: null, hydrated: true,
    });

    render(<AgentComposer />);

    const modelSelect = await screen.findByTestId('agent-model-select');
    expect(modelSelect).toBeDisabled();
    expect(screen.getByText(/does not support choosing a model/i)).toBeInTheDocument();
  });

  it('does not describe an uninstalled profile as a CLI that reported its models', async () => {
    const absent = { ...codexProfile, availableModels: [], detection: { ...codexProfile.detection, availability: 'not-installed' as const } };
    mountApi([absent]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [absent],
      selectedProfileId: 'codex', selectedModel: null, hydrated: true,
    });

    render(<AgentComposer />);

    // With nothing installed the empty state replaces the model field, and the
    // saved choice is named as missing rather than as a CLI with no models.
    expect(await screen.findByTestId('agent-profile-empty')).toBeInTheDocument();
    expect(screen.getByTestId('agent-profile-saved-choice')).toHaveTextContent('Your saved agent, Codex, was not found.');
    expect(screen.queryByText(/did not list any models|reported no models/i)).toBeNull();
    expect(screen.queryByTestId('agent-model-select')).toBeNull();
  });

  it('says why Start is blocked by the agent, telling nothing installed apart from a stale choice', async () => {
    const absent = (profile: AgentProfile): AgentProfile => ({ ...profile, detection: { ...profile.detection, availability: 'not-installed' } });
    mountApi([absent(codexProfile)]);
    useAgentStore.setState({ documentId: fixtureDocument.id, profiles: [absent(codexProfile)], selectedProfileId: null, hydrated: true });
    const { unmount } = render(<AgentComposer />);
    expect(await screen.findByTestId('agent-session-status')).toHaveTextContent('Install an agent runtime to start a task.');
    expect(screen.queryByTestId('agent-profile-saved-choice')).toBeNull();
    expect(screen.getByTestId('agent-start-button')).toBeDisabled();
    unmount();

    // One agent is installed, but the saved choice is another that is not.
    mountApi([codexProfile, absent(claudeProfile)]);
    useAgentStore.setState({ documentId: fixtureDocument.id, profiles: [codexProfile, absent(claudeProfile)], selectedProfileId: 'claude-code', hydrated: true });
    render(<AgentComposer />);
    expect(await screen.findByTestId('agent-session-status')).toHaveTextContent('Claude Code is not installed on this machine. Choose an installed agent to start.');
    expect(screen.getByTestId('agent-profile-unavailable')).toHaveTextContent('Not installed');
    expect(screen.queryByTestId('agent-profile-empty')).toBeNull();
  });

  it('points a built-in agent with no listed models at its own AI Providers row', async () => {
    const quiet = makeProfile({ defaultModel: null, availableModels: [] });
    mountApi([quiet]);
    useUiStore.setState({ settingsOpen: false, settingsTarget: 'general' });
    useAgentStore.setState({ documentId: fixtureDocument.id, profiles: [quiet], selectedProfileId: 'codex', selectedModel: null, hydrated: true });
    render(<AgentComposer />);
    expect(await screen.findByText(/Codex did not list any models/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-open-model-settings'));
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTarget: 'ai:codex' });
  });

  it('points a custom profile with no models at its own default-model field, with no Settings link', async () => {
    const custom = makeProfile({ id: 'custom:1', providerId: 'custom', name: 'My agent', isCustom: true, defaultModel: null, availableModels: [] });
    mountApi([custom]);
    useAgentStore.setState({ documentId: fixtureDocument.id, profiles: [custom], selectedProfileId: 'custom:1', selectedModel: null, hydrated: true });
    render(<AgentComposer />);
    expect(await screen.findByText(/Add a default model to this custom profile/)).toBeInTheDocument();
    expect(screen.queryByTestId('agent-open-model-settings')).toBeNull();
  });

  it('describes the agent task view in plain words, without internal process vocabulary', async () => {
    const banned = /main process|main-owned|argv|shell: false|allowlisted|bridge|Agent Profiles/i;
    const absent = { ...codexProfile, detection: { ...codexProfile.detection, availability: 'not-installed' as const } };
    for (const profiles of [[codexProfile], [makeProfile({ availableModels: [], defaultModel: null })], [absent]]) {
      mountApi(profiles);
      useAgentStore.setState({ documentId: fixtureDocument.id, profiles, selectedProfileId: 'codex', selectedModel: null, hydrated: true });
      const { container, unmount } = render(<AgentComposer />);
      await screen.findByTestId('agent-session-status');
      expect(container.textContent).not.toMatch(banned);
      unmount();
    }
  });

  it('persists the choice into the same profile preference the Settings editor owns', async () => {
    const update = vi.fn((next: AppSettings) => Promise.resolve(next));
    mountApi([codexProfile], update);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [codexProfile],
      selectedProfileId: 'codex', selectedModel: 'gpt-5-codex', hydrated: true,
    });

    render(<AgentComposer />);
    const modelSelect = await screen.findByTestId('agent-model-select');
    chooseValue(modelSelect, 'gpt-5.1-codex');

    expect(useAgentStore.getState().selectedModel).toBe('gpt-5.1-codex');
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({
            codex: expect.objectContaining({ defaultModel: 'gpt-5.1-codex', binary: 'codex', models: [] }),
          }),
        }),
      }));
    });

    // Switching away carries the outgoing default into the profile's own list so
    // the picker never silently loses a model it had just offered.
    chooseValue(modelSelect, 'gpt-5-codex');
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          profiles: expect.objectContaining({
            codex: expect.objectContaining({ defaultModel: 'gpt-5-codex', models: ['gpt-5.1-codex'] }),
          }),
        }),
      }));
    });
  });

  it('reconciles the model control when the profile changes', async () => {
    mountApi([codexProfile, claudeProfile]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [codexProfile, claudeProfile],
      selectedProfileId: 'codex', selectedModel: 'gpt-5.1-codex', hydrated: true,
    });

    render(<AgentComposer />);
    await screen.findByTestId('agent-model-select');
    chooseValue(screen.getByRole('combobox', { name: 'Agent profile' }), 'claude-code');

    await waitFor(() => {
      expect(screen.getByTestId('agent-model-select')).toHaveAttribute('data-value', 'claude-opus-5');
    });
    expect(optionValues(screen.getByTestId('agent-model-select')))
      .toEqual(['', 'claude-opus-5']);
  });

  it('shows the recorded model of the active run rather than the current selection', async () => {
    const active: AgentSessionDetail = {
      ...runningSession('session-history-1', 'earlier run', 'gpt-5.1-codex'),
      status: 'completed', providerSessionId: 'provider-1', finalReport: 'done', events: [], artifacts: [],
    };
    mountApi([codexProfile], undefined, [active]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [codexProfile],
      selectedProfileId: 'codex', selectedModel: 'gpt-5-codex',
      activeSession: active, sessions: [active], hydrated: true,
    });

    render(<AgentComposer />);

    expect(await screen.findByTestId('agent-active-session-profile')).toHaveTextContent('Codex');
    expect(screen.getByTestId('agent-active-session-model')).toHaveTextContent('gpt-5.1-codex');
    expect(screen.getAllByTestId('agent-session-item-profile')[0]).toHaveTextContent('Codex');
    expect(screen.getAllByTestId('agent-session-item-model')[0]).toHaveTextContent('gpt-5.1-codex');
    // Returning to the composer keeps the user's own default; the run snapshot
    // never overwrites it, and resume replays the recorded model instead.
    fireEvent.click(screen.getByTestId('agent-back-button'));
    await waitFor(() => {
      expect(screen.getByTestId('agent-model-select')).toHaveAttribute('data-value', 'gpt-5-codex');
      expect(screen.getAllByTestId('agent-session-item-profile')[0]).toHaveTextContent('Codex');
      expect(screen.getAllByTestId('agent-session-item-model')[0]).toHaveTextContent('gpt-5.1-codex');
    });
  });

  it('reports the provider default for a historical run with no recorded model', async () => {
    const active: AgentSessionDetail = {
      ...runningSession('session-history-2', 'legacy run'),
      status: 'completed', providerSessionId: 'provider-2', finalReport: 'done', events: [], artifacts: [],
    };
    mountApi([codexProfile], undefined, [active]);
    useAgentStore.setState({
      documentId: fixtureDocument.id, profiles: [codexProfile],
      selectedProfileId: 'codex', selectedModel: null,
      activeSession: active, sessions: [active], hydrated: true,
    });

    render(<AgentComposer />);

    expect(await screen.findByTestId('agent-active-session-model')).toHaveTextContent('Provider default');
    expect(screen.getAllByTestId('agent-session-item-profile')[0]).toHaveTextContent('Codex');
    expect(screen.getAllByTestId('agent-session-item-model')[0]).toHaveTextContent('Provider default');
  });

  it('serializes and awaits queued settings persistence when Start is clicked immediately after selecting a model or provider default', async () => {
    let settingsUpdateDone = false;
    const update = vi.fn(async (next: AppSettings) => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(() => { resolve(undefined); }, 25);
      await promise;
      settingsUpdateDone = true;
      return next;
    });
    const session = runningSession('session-race-1', 'immediate start', 'gpt-5.1-codex');
    let updateFinishedBeforeStart = false;
    const startSession = vi.fn(() => {
      updateFinishedBeforeStart = settingsUpdateDone;
      return Promise.resolve({ session });
    });
    mountApi([codexProfile], update, [], {
      listWorkingDirectories: vi.fn(() => Promise.resolve([launchDirectory])),
      getSession: vi.fn(() => Promise.resolve({ ...session, events: [], artifacts: [] })),
      startSession,
    });
    readyToLaunch('immediate start');

    render(<AgentComposer />);
    const modelSelect = await screen.findByTestId('agent-model-select');
    chooseValue(modelSelect, '');
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }));

    await waitFor(() => {
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'codex', model: null }));
    });
    expect(updateFinishedBeforeStart).toBe(true);
  });

  it('updates an already-mounted Agent panel when Settings saves new models/defaults without rehydrating document or sessions', async () => {
    const initialProfiles = [codexProfile];
    const refreshedProfiles = [
      makeProfile({
        id: 'codex',
        defaultModel: 'gpt-5.1-codex',
        availableModels: ['gpt-5-codex', 'gpt-5.1-codex', 'gpt-6-preview'],
      }),
    ];
    const listProfiles = vi.fn()
      .mockResolvedValueOnce(initialProfiles)
      .mockResolvedValue(refreshedProfiles);

    mountApi(initialProfiles, (next) => Promise.resolve(next), [], { listProfiles });

    useAgentStore.setState({
      documentId: fixtureDocument.id,
      profiles: initialProfiles,
      selectedProfileId: 'codex',
      selectedModel: 'gpt-5-codex',
      hydrated: true,
    });

    render(<AgentComposer />);
    const selectBefore = await screen.findByTestId('agent-model-select');
    expect(optionValues(selectBefore)).toEqual(['', 'gpt-5-codex', 'gpt-5.1-codex']);

    await useAgentStore.getState().refreshProfiles();

    await waitFor(() => {
      const selectAfter = screen.getByTestId('agent-model-select');
      expect(optionValues(selectAfter))
        .toEqual(['', 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-6-preview']);
    });
    expect(useAgentStore.getState().documentId).toBe(fixtureDocument.id);
  });

  it('rejects start and surfaces a visible error when queued settings persistence fails, then recovers for subsequent write and start', async () => {
    let shouldRejectUpdate = true;
    const update = vi.fn((next: AppSettings) => {
      if (shouldRejectUpdate) {
        return Promise.reject(new Error('Settings update rejected by main'));
      }
      return Promise.resolve(next);
    });
    const startSession = vi.fn(() => Promise.resolve({ session: runningSession('session-recover-1', 'after recovery', 'gpt-5.1-codex') }));
    const issueRiskGrant = vi.fn(() => Promise.resolve({ grantId: 'grant-1', expiresAt: Date.now() + 60_000, mode: 'active-env' as const }));
    mountApi([codexProfile], update, [], {
      listWorkingDirectories: vi.fn(() => Promise.resolve([launchDirectory])),
      startSession,
      issueRiskGrant,
    });
    readyToLaunch('immediate start');
    render(<AgentComposer />);

    const modelSelect = await screen.findByTestId('agent-model-select');
    // Change the model, triggering enqueueSettingsWrite which will reject
    chooseValue(modelSelect, 'gpt-5.1-codex');

    // Immediately click Start
    const startButton = screen.getByRole('button', { name: 'Start agent' });
    fireEvent.click(startButton);

    // Wait for the rejection to be handled
    await waitFor(() => {
      expect(useAgentStore.getState().error).toBe('Settings update rejected by main');
    });

    // Verify no startSession or risk grant was called
    expect(startSession).not.toHaveBeenCalled();
    expect(issueRiskGrant).not.toHaveBeenCalled();

    // Verify visible error in UI
    expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Settings update rejected by main');

    // Queue recovery: next update succeeds
    shouldRejectUpdate = false;
    chooseValue(modelSelect, 'gpt-5.1-codex');
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'codex',
        model: 'gpt-5.1-codex',
      }));
    });
  });

  it('drains writes when write B is queued while write A flush is pending, launching only after B settles with the model chosen at Start', async () => {
    const deferredA = createDeferred<AppSettings>();
    const deferredB = createDeferred<AppSettings>();
    const writeCalls: AppSettings[] = [];

    const update = vi.fn((next: AppSettings) => {
      writeCalls.push(next);
      return writeCalls.length === 1 ? deferredA.promise : deferredB.promise;
    });

    const startSession = vi.fn(() => Promise.resolve({ session: runningSession('session-drain-1', 'after drain') }));
    mountApi([codexProfile], update, [], {
      listWorkingDirectories: vi.fn(() => Promise.resolve([launchDirectory])),
      startSession,
      issueRiskGrant: vi.fn(() => Promise.resolve({ grantId: 'grant-1', expiresAt: Date.now() + 60_000, mode: 'active-env' as const })),
    });
    readyToLaunch('test prompt');

    render(<AgentComposer />);

    const modelSelect = await screen.findByTestId('agent-model-select');
    const profileSelect = screen.getByRole('combobox', { name: 'Agent profile' });
    const startButton = screen.getByRole('button', { name: 'Start agent' });

    // 1. User selects model 'gpt-5.1-codex'. This enqueues Write A.
    chooseValue(modelSelect, 'gpt-5.1-codex');
    await waitFor(() => {
      expect(writeCalls).toHaveLength(1);
    });

    // 2. User clicks Start. Start is in-flight and awaits flush of write A.
    fireEvent.click(startButton);

    // Verify UI controls are frozen / disabled while launch is in flight.
    await waitFor(() => {
      expect(modelSelect).toBeDisabled();
      expect(profileSelect).toBeDisabled();
      expect(startButton).toBeDisabled();
    });

    // 3. While write A's flush is pending, simulate write B arriving (e.g. switching to Provider default null).
    const settingsB: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        profiles: {
          codex: {
            binary: 'codex',
            arguments: ['exec', '--json', '--sandbox', 'workspace-write'],
            defaultModel: null,
            models: ['gpt-5-codex', 'gpt-5.1-codex'],
            reasoningEffort: null,
            permissionMode: 'workspace-write',
            sandboxMode: 'auto-isolated',
            workingDirectoryPolicy: 'select-per-run',
            environmentOverrides: [],
          },
        },
      },
    };
    useAgentStore.setState({
      profiles: useAgentStore.getState().profiles.map((p) => (p.id === 'codex' ? { ...p, defaultModel: null } : p)),
      selectedModel: null,
    });
    persistSettings(settingsB);

    // 4. Resolve write A. Start MUST NOT launch yet, because write B is still pending.
    deferredA.resolve(writeCalls[0]!);

    await waitFor(() => {
      expect(writeCalls).toHaveLength(2);
    });
    expect(startSession).not.toHaveBeenCalled();

    // 5. Now resolve write B.
    deferredB.resolve(writeCalls[1]!);

    // 6. Start now flushes write B and resumes launch. The run uses the model
    // the reader had chosen when pressing Start; the later choice is kept as
    // the selection for the next run, not overwritten by this launch.
    await waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'codex',
        model: 'gpt-5.1-codex',
      }));
    });
    expect(useAgentStore.getState().selectedModel).toBeNull();
  });

  it('aborts launch without spawning when write B rejects while write A was flushing', async () => {
    const deferredA = createDeferred<AppSettings>();
    const deferredB = createDeferred<AppSettings>();
    const writeCalls: AppSettings[] = [];

    const update = vi.fn((next: AppSettings) => {
      writeCalls.push(next);
      return writeCalls.length === 1 ? deferredA.promise : deferredB.promise;
    });
    // The launch is expected to abort before this is reached; the session it
    // would have returned is never read, but the contract still returns one.
    const startSession = vi.fn(() => Promise.resolve({ session: runningSession('session-unread', 'unread') }));
    mountApi([codexProfile], update, [], {
      listWorkingDirectories: vi.fn(() => Promise.resolve([launchDirectory])),
      startSession,
      issueRiskGrant: vi.fn(() => Promise.resolve({ grantId: 'grant-1', expiresAt: Date.now() + 60_000, mode: 'active-env' as const })),
    });
    readyToLaunch('test prompt');

    render(<AgentComposer />);

    const modelSelect = await screen.findByTestId('agent-model-select');
    const startButton = screen.getByRole('button', { name: 'Start agent' });
    // 1. Enqueue write A and start
    chooseValue(modelSelect, 'gpt-5.1-codex');
    await waitFor(() => {
      expect(writeCalls).toHaveLength(1);
    });
    fireEvent.click(startButton);
    // 2. Enqueue write B while flush is awaiting write A
    persistSettings(DEFAULT_APP_SETTINGS);

    // 3. Resolve write A. Write B is now processed next in the queue.
    deferredA.resolve(writeCalls[0]!);

    await waitFor(() => {
      expect(writeCalls).toHaveLength(2);
    });
    expect(startSession).not.toHaveBeenCalled();

    // 4. Reject write B
    deferredB.reject(new Error('Write B database disk full'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Write B database disk full');
    });
    expect(startSession).not.toHaveBeenCalled();
  });
});

describe('Settings default-model options', () => {
  it('offers nothing when main has no allowlist, so the editor keeps its free-text field', () => {
    expect(mergeDefaultModelOptions([], null)).toEqual([]);
    expect(mergeDefaultModelOptions([], 'gpt-5.6-luna')).toEqual([]);
  });

  it('keeps a saved default that the installed CLI no longer lists', () => {
    expect(mergeDefaultModelOptions(['gpt-5.1-codex', 'gpt-5.1'], 'gpt-4.1-codex'))
      .toEqual(['gpt-4.1-codex', 'gpt-5.1-codex', 'gpt-5.1']);
  });

  it('does not duplicate a saved default the CLI still lists', () => {
    expect(mergeDefaultModelOptions(['gpt-5.1-codex', 'gpt-5.1'], 'gpt-5.1'))
      .toEqual(['gpt-5.1-codex', 'gpt-5.1']);
    expect(mergeDefaultModelOptions(['gpt-5.1-codex'], null)).toEqual(['gpt-5.1-codex']);
  });
});
