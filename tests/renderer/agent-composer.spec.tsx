// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AgentEvent, AgentProfile, AgentSessionDetail, AgentWorkingDirectory } from '@shared/types/agent';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import type { DocumentMetadata } from '@shared/types/document';
import type { InterleafAPI } from '@shared/types/api';
import { stubBridge } from '../helpers/interleaf-api';
import { flushPendingSettingsWrites, resetSettingsWriteQueueForTests } from '../../src/renderer/app/api-client';
import { testReaderSession } from '../helpers/reader-session';
import { chooseValue } from '../helpers/listbox-select';

const fixtureDocument: DocumentMetadata = {
  id: 'doc-fixture',
  title: 'Fixture Doc',
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
const profile: AgentProfile = {
  id: 'profile-copy', providerId: 'fake' as const, name: 'Profile Copy', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
  isCustom: false, unsafe: false,
};

const nonResumableProfile: AgentProfile = {
  ...profile,
  id: 'profile-no-resume',
  name: 'No Resume Profile',
  capabilities: {
    ...profile.capabilities,
    sessionResume: false,
  },
};

const autoProfile: AgentProfile = {
  ...profile,
  id: 'fake',
  name: 'Fake Auto',
  defaultSandboxMode: 'auto-isolated',
};

/** A stored session for this document's profile; overrides describe the case. */
function sessionDetail(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  const timestamp = new Date().toISOString();
  return {
    id: 'session-terminal-1',
    documentId: fixtureDocument.id,
    profileId: profile.id,
    providerId: 'fake',
    targetDirectory: { handle: 'h1', displayName: 'workspace' },
    executionMode: 'isolated-copy',
    status: 'completed',
    providerSessionId: 'provider-1',
    userPrompt: 'initial task',
    contextSummary: null,
    effectiveModel: null,
    effectiveReasoningEffort: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    finalReport: null,
    environment: null,
    eventCount: 0,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

/** Stubs the bridge so its agent namespace loads one profile and no sessions unless overridden. */
function installApi(
  agent: Partial<InterleafAPI['agent']> = {},
  settings: AppSettings = DEFAULT_APP_SETTINGS,
): InterleafAPI {
  return stubBridge({
    settings: { get: vi.fn(() => Promise.resolve(settings)) },
    agent: {
      listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      listProfiles: vi.fn(() => Promise.resolve([profile])),
      listSessions: vi.fn(() => Promise.resolve([])),
      getModeAvailability: vi.fn(() => Promise.resolve([])),
      onEvent: vi.fn(() => () => undefined),
      ...agent,
    },
  });
}

describe('AgentComposer profile execution defaults, Copy Result, and Resume', () => {
  beforeEach(() => {
    useReaderStore.setState({ session: testReaderSession(fixtureDocument) });
  });

  afterEach(() => {
    resetSettingsWriteQueueForTests();
    cleanup();
    useReaderStore.setState({ session: null });
    useAgentStore.setState({
      documentId: null,
      profiles: [],
      modeAvailability: [],
      selectedProfileId: null,
      workingDirectory: null,
      activeSession: null,
      sessions: [],
      events: [],
      loading: false,
      stopping: false,
      error: null,
      hydrated: false,
    });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
  });
  it('keeps the global initial default, applies a profile override after selection, and allows an explicit Auto switch', async () => {
    installApi({ listProfiles: vi.fn(() => Promise.resolve([autoProfile, profile])) });
    useUiStore.getState().hydrate({
      ...DEFAULT_APP_SETTINGS,
      agent: {
        ...DEFAULT_APP_SETTINGS.agent,
        defaultExecutionMode: 'isolated-worktree',
      },
    });
    render(<AgentComposer />);

    // The redesign presents the execution environment as one select rather
    // than five radios, so the panel stays usable at the narrow panel widths.
    const modeSelect = await screen.findByTestId('composer-execution-mode-select');
    await waitFor(() => { expect(modeSelect).toHaveAttribute('data-value', 'isolated-worktree'); });
    const profileSelect = screen.getByRole('combobox', { name: 'Agent profile' });
    chooseValue(profileSelect, profile.id);
    await waitFor(() => { expect(modeSelect).toHaveAttribute('data-value', 'isolated-copy'); });
    chooseValue(modeSelect, 'auto-isolated');
    await waitFor(() => {
      expect(modeSelect).toHaveAttribute('data-value', 'auto-isolated');
      expect(screen.getByText(/Git repositories resolve to Isolated Worktree/i)).toBeTruthy();
    });
  });

  it('writes nothing for an execution-mode choice made before settings have loaded', async () => {
    const update = vi.fn((next: AppSettings) => Promise.resolve(next));
    installApi({ listProfiles: vi.fn(() => Promise.resolve([autoProfile])) });
    stubBridge({ settings: { update } });
    render(<AgentComposer />);

    const modeSelect = await screen.findByTestId('composer-execution-mode-select');
    chooseValue(modeSelect, 'isolated-copy');
    await waitFor(() => { expect(modeSelect).toHaveAttribute('data-value', 'isolated-copy'); });

    // settings:update replaces the saved document, so a write built on defaults
    // here would erase every other preference the user had saved.
    await flushPendingSettingsWrites();
    expect(update).not.toHaveBeenCalled();
    expect(useUiStore.getState().loadedSettings).toBeNull();
  });

  it('saves an execution-mode default on top of the loaded settings, keeping the rest', async () => {
    const saved: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      advanced: { ...DEFAULT_APP_SETTINGS.advanced, debugLogging: !DEFAULT_APP_SETTINGS.advanced.debugLogging },
    };
    const update = vi.fn((next: AppSettings) => Promise.resolve(next));
    installApi({ listProfiles: vi.fn(() => Promise.resolve([autoProfile])) }, saved);
    stubBridge({ settings: { update } });
    useUiStore.getState().hydrate(saved);
    render(<AgentComposer />);

    const modeSelect = await screen.findByTestId('composer-execution-mode-select');
    chooseValue(modeSelect, 'isolated-copy');

    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1); });
    expect(update).toHaveBeenCalledWith({
      ...saved,
      agent: { ...saved.agent, defaultExecutionMode: 'isolated-copy' },
    });
  });

  it('exposes every loaded session in a bounded keyboard-accessible list and selects the oldest detail', async () => {
    const sessions: AgentSessionDetail[] = Array.from({ length: 7 }, (_, index) => {
      const id = `session-${String(index)}`;
      const event = { sessionId: id, ordinal: 0, type: 'final', text: `event ${String(index)}`, timestamp: new Date().toISOString() } satisfies AgentEvent;
      return sessionDetail({
        id,
        targetDirectory: { handle: `handle-${String(index)}`, displayName: `workspace-${String(index)}` },
        providerSessionId: `provider-${String(index)}`,
        userPrompt: `prompt ${String(index)}`,
        finalReport: `report ${String(index)}`,
        eventCount: 1,
        events: [event],
      });
    });
    const getSession = vi.fn((id: string) => Promise.resolve(sessions.find((item) => item.id === id) ?? null));
    installApi({ listSessions: vi.fn(() => Promise.resolve(sessions)), getSession });
    useAgentStore.setState({
      profiles: [profile],
      selectedProfileId: profile.id,
      workingDirectory: { handle: 'displayed-handle', displayName: 'Displayed workspace' },
      workingDirectorySource: 'profile-default',
      activeSession: sessions[6] ?? null,
      sessions,
      events: sessions[6]?.events ?? [],
      hydrated: true,
    });

    const { container } = render(<AgentComposer />);
    // The run view describes the selected run from its own record: the
    // composer's current directory and its source belong to the new-task view,
    // which asserts them directly in the settings-change test below.
    expect(screen.queryByTestId('agent-working-directory-source')).toBeNull();
    expect(screen.queryByText('Displayed workspace')).toBeNull();
    // The session list is a disclosure now: open it before reaching its entries.
    fireEvent.click(screen.getByRole('button', { name: 'All sessions' }));
    const sessionButtons = await screen.findAllByRole('button', { name: /^Task: prompt [0-9]+,/ });
    expect(sessionButtons).toHaveLength(7);
    expect(screen.getByRole('button', { name: /^Task: prompt 6,/ })).toHaveAttribute('aria-current', 'true');
    const oldest = screen.getByRole('button', { name: /^Task: prompt 0,/ });
    expect(oldest).not.toHaveAttribute('tabindex', '-1');
    oldest.focus();
    expect(document.activeElement).toBe(oldest);
    fireEvent.keyDown(oldest, { key: 'Enter' });
    fireEvent.click(oldest);

    await waitFor(() => { expect(getSession).toHaveBeenCalledWith('session-0', 'doc-fixture'); });
    expect(await screen.findByTestId('agent-final-report')).toHaveTextContent('report 0');
    // The Result card carries the report, so the timeline keeps only a marker.
    expect(screen.getByTestId('activity-final-final-0')).toHaveTextContent('Final report shown above.');
    expect(screen.queryByText('event 0')).toBeNull();
    // Choosing a run closes the list, since the header behind it now
    // describes a different run; reopening shows the moved selection.
    expect(screen.queryByRole('button', { name: /^Task: prompt 6,/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All sessions' }));
    expect(screen.getByRole('button', { name: /^Task: prompt 6,/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /^Task: prompt 0,/ })).toHaveAttribute('aria-current', 'true');

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('updates a mounted composer after validated settings change its profile default', async () => {
    const oldDirectory: AgentWorkingDirectory = { handle: 'workspace-old', displayName: 'Old workspace' };
    const newDirectory: AgentWorkingDirectory = { handle: 'workspace-new', displayName: 'New workspace' };
    const oldSettings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: {
        ...structuredClone(DEFAULT_APP_SETTINGS.agent),
        defaultWorkingDirectoryByProfile: { [profile.id]: oldDirectory.handle },
      },
    };
    const newSettings = {
      ...oldSettings,
      agent: { ...oldSettings.agent, defaultWorkingDirectoryByProfile: { [profile.id]: newDirectory.handle } },
    };
    const listWorkingDirectories = vi.fn()
      .mockResolvedValueOnce([oldDirectory])
      .mockResolvedValueOnce([newDirectory]);
    installApi({ listWorkingDirectories }, oldSettings);

    render(<AgentComposer />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('Old workspace');
      expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Profile default');
    });

    await useAgentStore.getState().syncWorkingDirectorySettings(newSettings);
    await waitFor(() => {
      expect(screen.getByTestId('agent-working-directory')).toHaveTextContent('New workspace');
      expect(screen.getByTestId('agent-working-directory-source')).toHaveTextContent('Profile default');
    });
  });

  it('triggers copyResult through the main IPC seam and announces accessible status', async () => {
    const copyResultMock = vi.fn(() => Promise.resolve({ copied: true as const, characterCount: 42 }));
    installApi({ copyResult: copyResultMock });

    const terminalSession = sessionDetail({
      userPrompt: 'summarize project',
      finalReport: 'All tests passed and code updated successfully.',
      eventCount: 5,
    });

    useAgentStore.setState({
      profiles: [profile],
      selectedProfileId: profile.id,
      activeSession: terminalSession,
      sessions: [terminalSession],
      hydrated: true,
    });

    render(<AgentComposer />);

    const report = await screen.findByTestId('agent-final-report');
    expect(report.textContent).toContain('All tests passed');

    fireEvent.click(screen.getByTestId('agent-copy-result-button'));
    await waitFor(() => {
      expect(copyResultMock).toHaveBeenCalledWith('session-terminal-1');
    });
    const status = await screen.findByTestId('agent-copy-status');
    expect(status.textContent).toContain('42 chars');
  });

  it('renders resume session UI and triggers resumeSession IPC on submit', async () => {
    const resumed = sessionDetail({ status: 'running', userPrompt: 'follow-up prompt', eventCount: 3 });
    const resumeSessionMock = vi.fn(() => Promise.resolve({ session: resumed }));
    installApi({ resumeSession: resumeSessionMock, getSession: vi.fn(() => Promise.resolve(resumed)) });

    const terminalSession = sessionDetail({ finalReport: 'Initial work done.', eventCount: 2 });

    useAgentStore.setState({
      profiles: [profile],
      selectedProfileId: profile.id,
      activeSession: terminalSession,
      sessions: [terminalSession],
      hydrated: true,
    });

    render(<AgentComposer />);

    await screen.findByTestId('agent-resume-section');
    fireEvent.change(screen.getByLabelText('Follow-up prompt'), { target: { value: 'Please do step 2 now.' } });

    const resumeButton = screen.getByTestId('agent-resume-button');
    expect(resumeButton).not.toBeDisabled();

    fireEvent.click(resumeButton);
    await waitFor(() => {
      expect(resumeSessionMock).toHaveBeenCalledWith({
        sessionId: 'session-terminal-1',
        prompt: 'Please do step 2 now.',
      });
    });
  });

  it('determines resume capability from active session profile and handles resume failure safely', async () => {
    const resumeSessionMock = vi.fn(() => Promise.reject(new Error('Workspace corrupted')));
    installApi({
      listProfiles: vi.fn(() => Promise.resolve([profile, nonResumableProfile])),
      resumeSession: resumeSessionMock,
    });

    const nonResumableSession = sessionDetail({
      id: 'session-no-resume',
      profileId: nonResumableProfile.id,
      finalReport: 'Initial work done.',
      eventCount: 2,
    });

    // Even though selectedProfile is 'profile' (which supports resume), the active session belongs to nonResumableProfile
    useAgentStore.setState({
      profiles: [profile, nonResumableProfile],
      selectedProfileId: profile.id,
      activeSession: nonResumableSession,
      sessions: [nonResumableSession],
      hydrated: true,
    });

    const { rerender } = render(<AgentComposer />);

    // Resume section must NOT be rendered because activeSessionProfile does not support resume
    expect(screen.queryByTestId('agent-resume-section')).toBeNull();

    // Now switch active session to a session with resumable profile and test failure behavior
    const resumableSession: AgentSessionDetail = {
      ...nonResumableSession,
      id: 'session-resumable',
      profileId: profile.id,
    };

    useAgentStore.setState({
      activeSession: resumableSession,
      sessions: [resumableSession],
    });

    rerender(<AgentComposer />);

    await screen.findByTestId('agent-resume-section');
    fireEvent.change(screen.getByLabelText('Follow-up prompt'), { target: { value: 'Follow up that fails' } });
    fireEvent.click(screen.getByTestId('agent-resume-button'));

    await waitFor(() => {
      expect(resumeSessionMock).toHaveBeenCalled();
    });

    const status = await screen.findByTestId('agent-resume-status');
    expect(status.textContent).toContain('Resume failed: Workspace corrupted');
    // Follow-up textarea content should be preserved so user does not lose draft
    expect(screen.getByLabelText('Follow-up prompt')).toHaveValue('Follow up that fails');
  });

  it('keeps the review diff collapsed until View Diff is activated and preserves review actions', async () => {
    installApi();

    const reviewedSession = sessionDetail({
      id: 'session-diff',
      providerSessionId: 'provider-diff',
      userPrompt: 'review the fixture change',
      finalReport: 'Fixture change is ready for review.',
      environment: {
        sessionId: 'session-diff',
        mode: 'isolated-copy',
        riskLevel: 'low',
        workspaceLabel: 'Isolated directory copy',
        primaryWasDirty: false,
        applyAllowed: true,
        applied: false,
        applyDisabledReason: null,
        activeWorkspaceModified: false,
        changedFiles: [{ path: 'fixture.txt', kind: 'modified', additions: 1, deletions: 0, bytes: 18 }],
        tests: [{ status: 'passed', summary: 'fixture tests passed', exitCode: 0, durationMs: 12 }],
        diffAvailable: true,
        diff: 'diff --git a/fixture.txt b/fixture.txt\n+updated fixture',
        patchAvailable: true,
        containerRuntime: null,
      },
      eventCount: 1,
    });

    const reviewEvents: readonly AgentEvent[] = [
      { sessionId: reviewedSession.id, ordinal: 1, type: 'structured', data: { kind: 'command', command: `bounded command ${'x'.repeat(2_000)}` }, timestamp: new Date().toISOString() },
      { sessionId: reviewedSession.id, ordinal: 2, type: 'error', error: { __interleafError: true, code: 'internal', message: 'persisted event failure' }, timestamp: new Date().toISOString() },
    ];

    useAgentStore.setState({
      profiles: [profile],
      selectedProfileId: profile.id,
      activeSession: reviewedSession,
      sessions: [reviewedSession],
      events: reviewEvents,
      hydrated: true,
    });

    render(<AgentComposer />);

    const review = await screen.findByTestId('agent-environment-review');
    // The review body is a disclosure that opens collapsed; its detail and
    // actions are reached through it.
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByTestId('agent-review-session-context')).toHaveTextContent('workspace · Execution mode: Isolated Directory Copy');
    expect(screen.getByTestId('agent-review-files')).toHaveTextContent('fixture.txt');
    expect(screen.getByTestId('agent-review-files')).toHaveTextContent('modified · +1 / −0');
    expect(screen.getByTestId('agent-review-tests')).toHaveTextContent('passed: fixture tests passed');
    expect(screen.getByTestId('activity-command-cmd-1')).toHaveTextContent('bounded command');
    expect(screen.getByTestId('activity-error-error-2')).toHaveTextContent('persisted event failure');
    const viewDiff = screen.getByRole('button', { name: 'View Diff' });
    expect(viewDiff).toHaveAttribute('aria-expanded', 'false');
    expect(viewDiff).toHaveAttribute('aria-controls', 'agent-environment-diff');
    expect(screen.queryByTestId('agent-environment-diff')).toBeNull();
    expect(review).toContainElement(screen.getByRole('button', { name: 'Apply Changes' }));
    expect(review).toContainElement(screen.getByRole('button', { name: 'Open Folder' }));
    expect(review).toContainElement(screen.getByRole('button', { name: 'Discard Sandbox' }));

    fireEvent.click(viewDiff);
    expect(viewDiff).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('agent-environment-diff').textContent).toContain('updated fixture');

    fireEvent.click(viewDiff);
    expect(viewDiff).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('agent-environment-diff')).toBeNull();

    const nextSession: AgentSessionDetail = {
      ...reviewedSession,
      id: 'session-diff-next',
      targetDirectory: { handle: 'h2', displayName: 'next-workspace' },
      environment: { ...reviewedSession.environment!, sessionId: 'session-diff-next', diff: 'diff --git a/next.txt b/next.txt\n+next' },
    };
    useAgentStore.setState({ activeSession: nextSession, sessions: [nextSession], events: [] });
    await waitFor(() => {
      expect(screen.getByTestId('agent-review-session-context')).toHaveTextContent('next-workspace');
      expect(screen.getByRole('button', { name: 'View Diff' })).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.queryByTestId('agent-environment-diff')).toBeNull();

    const axeResults = await axe.run(review, { rules: { 'color-contrast': { enabled: false } } });
    expect(axeResults.violations).toEqual([]);
  });

  it('keeps Stop active when a resumed cancellation follows an older ended event', () => {
    const session = sessionDetail({
      id: 'session-cancelled-resume',
      targetDirectory: { handle: 'h-cancel', displayName: 'workspace' },
      status: 'cancelled',
      providerSessionId: 'provider-cancel',
      userPrompt: 'resume then stop',
      eventCount: 3,
      events: [
        { sessionId: 'session-cancelled-resume', ordinal: 0, type: 'started', timestamp: new Date().toISOString() },
        { sessionId: 'session-cancelled-resume', ordinal: 1, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() },
        { sessionId: 'session-cancelled-resume', ordinal: 2, type: 'cancelled', timestamp: new Date().toISOString() },
      ],
    });
    useAgentStore.setState({ profiles: [profile], selectedProfileId: profile.id, activeSession: session, sessions: [session], events: session.events, hydrated: true });
    render(<AgentComposer />);
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled();
  });

  it('keeps Stop disabled while cancellation is acknowledged and deduplicates clicks', async () => {
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
    const started: AgentEvent = { sessionId: 'session-stop-pending', ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
    const cancelled: AgentEvent = { sessionId: 'session-stop-pending', ordinal: 1, type: 'cancelled', timestamp: new Date().toISOString() };
    const runningSession = sessionDetail({
      id: 'session-stop-pending', targetDirectory: { handle: 'h-stop-pending', displayName: 'workspace' }, status: 'running',
      providerSessionId: 'provider-stop-pending', userPrompt: 'stop pending', eventCount: 1, events: [started],
    });
    const acknowledgement: AgentSessionDetail = {
      ...runningSession, status: 'cancelled', eventCount: 2, events: [started, cancelled],
    };
    const stopSessionMock = vi.fn(() => stopPromise);
    installApi({ getSession: vi.fn(() => Promise.resolve(acknowledgement)), stopSession: stopSessionMock });
    useAgentStore.setState({
      profiles: [profile], selectedProfileId: profile.id, activeSession: runningSession,
      sessions: [runningSession], events: [started], hydrated: true, stopping: false,
    });

    render(<AgentComposer />);
    const stopButton = await screen.findByTestId('agent-stop-button');
    fireEvent.click(stopButton);
    fireEvent.click(stopButton);
    expect(stopSessionMock).toHaveBeenCalledTimes(1);
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveTextContent('Stopping…');

    resolveStop();
    await waitFor(() => { expect(useAgentStore.getState().activeSession?.status).toBe('cancelled'); });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveTextContent('Stopping…');
  });

  it('treats the authoritative reaped ended event after resumed cancellation as terminal', () => {
    const session = sessionDetail({
      id: 'session-reaped-cancelled', targetDirectory: { handle: 'h-reaped', displayName: 'workspace' }, status: 'cancelled',
      providerSessionId: 'provider-reaped', userPrompt: 'resume then malformed stop', eventCount: 5,
      events: [
        { sessionId: 'session-reaped-cancelled', ordinal: 0, type: 'started', timestamp: new Date().toISOString() },
        { sessionId: 'session-reaped-cancelled', ordinal: 1, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() },
        { sessionId: 'session-reaped-cancelled', ordinal: 2, type: 'started', timestamp: new Date().toISOString() },
        { sessionId: 'session-reaped-cancelled', ordinal: 3, type: 'cancelled', timestamp: new Date().toISOString() },
        { sessionId: 'session-reaped-cancelled', ordinal: 4, type: 'ended', exitCode: null, signal: null, timestamp: new Date().toISOString() },
      ],
    });
    useAgentStore.setState({ profiles: [profile], selectedProfileId: profile.id, activeSession: session, sessions: [session], events: session.events, hydrated: true });
    render(<AgentComposer />);
    // The authoritative ended event makes the run terminal, so cancellation is
    // not offered at all rather than offered and refused.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('guards lifecycle actions against rapid duplicate clicks until main settles', async () => {
    let resolveApply!: (value: { readonly sessionId: string; readonly review: NonNullable<AgentSessionDetail['environment']> }) => void;
    const applyPromise = new Promise<{ readonly sessionId: string; readonly review: NonNullable<AgentSessionDetail['environment']> }>((resolve) => { resolveApply = resolve; });
    const environment = {
      sessionId: 'session-action-guard', mode: 'isolated-copy' as const, riskLevel: 'low' as const,
      workspaceLabel: 'Isolated directory copy', primaryWasDirty: false, applyAllowed: true, applied: false,
      applyDisabledReason: null, activeWorkspaceModified: false,
      changedFiles: [{ path: 'guard.txt', kind: 'modified' as const, additions: 1, deletions: 0, bytes: 4 }],
      tests: [], diffAvailable: true, diff: 'diff --git a/guard.txt b/guard.txt\n+guard', patchAvailable: true, containerRuntime: null,
    };
    const session = sessionDetail({
      id: 'session-action-guard', targetDirectory: { handle: 'guard-handle', displayName: 'workspace' },
      providerSessionId: 'guard-provider', userPrompt: 'guard actions', finalReport: 'ready', environment, eventCount: 1,
    });
    const api = installApi({ applyChanges: vi.fn(() => applyPromise), getSession: vi.fn(() => Promise.resolve(session)) });
    useAgentStore.setState({ profiles: [profile], selectedProfileId: profile.id, activeSession: session, sessions: [session], events: [], hydrated: true });
    render(<AgentComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const applyButton = screen.getByRole('button', { name: 'Apply Changes' });
    const openButton = screen.getByRole('button', { name: 'Open Folder' });
    const discardButton = screen.getByRole('button', { name: 'Discard Sandbox' });
    fireEvent.click(applyButton);
    fireEvent.click(applyButton);
    expect(api.agent.applyChanges).toHaveBeenCalledTimes(1);
    expect(applyButton).toBeDisabled();
    expect(openButton).toBeDisabled();
    expect(discardButton).toBeDisabled();
    expect(screen.getByTestId('agent-environment-review').querySelector('[aria-busy="true"]')).toBeTruthy();
    resolveApply({ sessionId: session.id, review: environment });
    await waitFor(() => { expect(applyButton).not.toBeDisabled(); });
  });

  it('surfaces the main-supplied CRITICAL risk level even when the execution mode alone would read lower', () => {
    // Item N: an Expert Shell run in an isolated copy is CRITICAL because of the
    // authority the process holds, not the workspace it writes to. The renderer
    // must render the level main computed and never re-derive one from the mode.
    const environment = {
      sessionId: 'session-critical-risk', mode: 'isolated-copy' as const, riskLevel: 'critical' as const,
      workspaceLabel: 'Isolated directory copy', primaryWasDirty: false, applyAllowed: true, applied: false,
      applyDisabledReason: null, activeWorkspaceModified: false,
      changedFiles: [{ path: 'shell.txt', kind: 'modified' as const, additions: 1, deletions: 0, bytes: 4 }],
      tests: [], diffAvailable: false, diff: null, patchAvailable: false, containerRuntime: null,
    };
    const session = sessionDetail({
      id: 'session-critical-risk', targetDirectory: { handle: 'critical-handle', displayName: 'workspace' },
      providerSessionId: 'critical-provider', userPrompt: 'expert shell task', finalReport: 'ready', environment, eventCount: 1,
    });
    installApi({ getSession: vi.fn(() => Promise.resolve(session)) });
    useAgentStore.setState({ profiles: [profile], selectedProfileId: profile.id, activeSession: session, sessions: [session], events: [], hydrated: true });
    render(<AgentComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    const review = screen.getByTestId('agent-environment-review');
    const badge = within(review).getByText('critical risk');
    expect(badge.className).toContain('text-danger');
    expect(within(review).queryByText(/medium risk/i)).toBeNull();
  });

  it('clears/rehydrates on document changes and never displays another document active session', async () => {
    const docA: DocumentMetadata = { ...fixtureDocument, id: 'doc-a', title: 'Doc A' };
    const docB: DocumentMetadata = { ...fixtureDocument, id: 'doc-b', title: 'Doc B' };

    const sessionA = sessionDetail({
      id: 'session-doc-a', documentId: 'doc-a', targetDirectory: { handle: 'h-a', displayName: 'workspace-a' },
      providerSessionId: 'p-a', userPrompt: 'task for doc a', finalReport: 'Report for doc a', eventCount: 1,
    });
    const sessionB = sessionDetail({
      id: 'session-doc-b', documentId: 'doc-b', targetDirectory: { handle: 'h-b', displayName: 'workspace-b' },
      providerSessionId: 'p-b', userPrompt: 'task for doc b', finalReport: 'Report for doc b', eventCount: 1,
    });

    const listSessionsMock = vi.fn((documentId?: string) => {
      if (documentId === 'doc-a') return Promise.resolve([sessionA]);
      if (documentId === 'doc-b') return Promise.resolve([sessionB]);
      return Promise.resolve([]);
    });

    installApi({
      listSessions: listSessionsMock,
      getSession: vi.fn((id: string) => Promise.resolve(id === 'session-doc-a' ? sessionA : id === 'session-doc-b' ? sessionB : null)),
    });

    // 1. Initially on Doc A with sessionA active
    useReaderStore.setState({ session: testReaderSession(docA) });
    useAgentStore.setState({
      documentId: 'doc-a',
      profiles: [profile],
      selectedProfileId: profile.id,
      activeSession: sessionA,
      sessions: [sessionA],
      events: [],
      hydrated: true,
    });

    const { rerender } = render(<AgentComposer />);
    expect(screen.getByTestId('agent-active-session-title')).toHaveTextContent('task for doc a');
    expect(screen.getByTestId('agent-final-report')).toHaveTextContent('Report for doc a');

    // 2. Switch active document to Doc B
    useReaderStore.setState({ session: testReaderSession(docB) });
    rerender(<AgentComposer />);

    // Wait for Doc A's session to be cleared and Doc B's session to rehydrate
    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledWith('doc-b');
    });
    // Doc A's report must NOT be visible
    expect(screen.queryByText('Report for doc a')).toBeNull();
    // Doc B's session is in the list
    fireEvent.click(await screen.findByRole('button', { name: 'All sessions' }));
    await screen.findByRole('button', { name: /^Task: task for doc b,/ });

    // 3. Switch to Doc C with NO sessions
    const docC: DocumentMetadata = { ...fixtureDocument, id: 'doc-c', title: 'Doc C' };
    useReaderStore.setState({ session: testReaderSession(docC) });
    rerender(<AgentComposer />);

    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledWith('doc-c');
    });
    // Neither Doc A nor Doc B session is displayed; Task Composer View is shown
    expect(screen.queryByTestId('agent-final-report')).toBeNull();
    expect(screen.queryByText('Report for doc a')).toBeNull();
    expect(screen.queryByText('Report for doc b')).toBeNull();
    expect(screen.getByTestId('agent-task-description')).toBeInTheDocument();
    expect(useAgentStore.getState().activeSession).toBeNull();
    expect(useAgentStore.getState().sessions).toEqual([]);
  });

  it('binds new agent sessions to the active document id', async () => {
    const doc = { ...fixtureDocument, id: 'doc-bound-123' };
    useReaderStore.setState({ session: testReaderSession(doc) });

    const started = sessionDetail({
      id: 'new-session',
      documentId: 'doc-bound-123',
      targetDirectory: { handle: 'work-h', displayName: 'workspace' },
      status: 'running',
      providerSessionId: null,
      userPrompt: 'implement feature',
    });
    const startSessionMock = vi.fn(() => Promise.resolve({ session: started }));

    installApi({
      listWorkingDirectories: vi.fn(() => Promise.resolve([{ handle: 'work-h', displayName: 'workspace' }])),
      startSession: startSessionMock,
      getSession: vi.fn(() => Promise.resolve(null)),
    }, {
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultWorkingDirectoryByProfile: { [profile.id]: 'work-h' } },
    });
    useAgentStore.setState({
      documentId: 'doc-bound-123',
      profiles: [profile],
      selectedProfileId: profile.id,
      workingDirectory: { handle: 'work-h', displayName: 'workspace' },
      workingDirectories: [{ handle: 'work-h', displayName: 'workspace' }],
      workingDirectorySource: 'profile-default',
      activeSession: null,
      sessions: [],
      hydrated: true,
    });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: 'implement feature' }, loadedSettings: null });

    render(<AgentComposer />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-start-button')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('agent-start-button'));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        documentId: 'doc-bound-123',
        profileId: profile.id,
        prompt: 'implement feature',
      }));
    });
  });
});
