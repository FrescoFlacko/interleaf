// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AgentEvent, AgentProfile, AgentSessionDetail } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import type { InterleafAPI } from '@shared/types/api';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

/**
 * State-level contracts of the redesigned Agent tab (reference 6a and 6b).
 * These assert what the two views promise the reader — the task leads, the run
 * is stated once, repeated errors fold away, resume stays outside the feed —
 * rather than the class names that happen to express it.
 */

const fixtureDocument: DocumentMetadata = {
  id: 'doc-redesign',
  title: 'Redesign Fixture',
  author: 'Author',
  format: 'pdf',
  storageMode: 'link',
  fileSize: 100,
  fileMtimeMs: 100,
  fileHash: 'hash-redesign',
  pageCount: 4,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const profile: AgentProfile = {
  id: 'profile-redesign', providerId: 'fake', name: 'Redesign Profile', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-09-01T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

/**
 * The same failure retried: identical text apart from the log timestamp the
 * CLI prefixes to each line. Errors that differ in anything else are kept
 * apart, which `agent-activity-groups.spec.ts` covers directly.
 */
function transportError(ordinal: number, second: string): AgentEvent {
  return {
    sessionId: 'session-redesign',
    ordinal,
    type: 'error',
    error: {
      __interleafError: true,
      message: `2026-09-01T00:00:${second}.000Z transport error: connection reset`,
      code: 'internal',
    },
    timestamp: `2026-09-01T00:00:${second}.000Z`,
  };
}

const session: AgentSessionDetail = {
  id: 'session-redesign',
  documentId: fixtureDocument.id,
  profileId: profile.id,
  providerId: 'fake',
  targetDirectory: { handle: 'handle-redesign', displayName: 'redesign-workspace' },
  executionMode: 'isolated-copy',
  status: 'completed',
  providerSessionId: 'provider-redesign',
  userPrompt: 'Summarise the attached excerpt and add a test.',
  contextSummary: 'Redesign Fixture · pages 1–2',
  effectiveModel: 'fixture-model',
  effectiveReasoningEffort: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:02:05.000Z',
  finalReport: 'Added one test and updated the summary.',
  environment: null,
  eventCount: 0,
  events: [],
  artifacts: [],
};

const runEvents: AgentEvent[] = [
  { sessionId: session.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:00:00.000Z' },
  transportError(1, '10'),
  transportError(2, '17'),
  transportError(3, '31'),
  { sessionId: session.id, ordinal: 4, type: 'final', text: 'Added one test and updated the summary.', timestamp: '2026-09-01T00:02:00.000Z' },
];

function installApi(overrides: Partial<InterleafAPI['agent']> = {}): void {
  const api = testInterleafApi({
    settings: { get: vi.fn(() => Promise.resolve(DEFAULT_APP_SETTINGS)) },
    agent: {
      listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      listProfiles: vi.fn(() => Promise.resolve([profile])),
      listSessions: vi.fn(() => Promise.resolve([session])),
      getSession: vi.fn(() => Promise.resolve(session)),
      getModeAvailability: vi.fn(() => Promise.resolve([])),
      onEvent: vi.fn(() => () => undefined),
      ...overrides,
    },
  });
  stubBridge(api);
}

/** Serious accessibility violations only; the panel is rendered in isolation. */
async function seriousViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa'] });
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => violation.id);
}

beforeEach(() => {
  useReaderStore.setState({ session: testReaderSession(fixtureDocument) });
  installApi();
});

afterEach(() => {
  cleanup();
  useReaderStore.setState({ session: null });
  // Some tests stub store actions, which live in the same state object, so the
  // whole initial store is restored rather than only the data fields.
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
});

describe('6a — new task view', () => {
  beforeEach(() => {
    useAgentStore.setState({ profiles: [profile], selectedProfileId: profile.id, hydrated: true });
  });

  it('leads with the task, gates Start on the first unmet precondition and names it', async () => {
    render(<AgentComposer />);

    const task = await screen.findByTestId('agent-context-section');
    const settings = screen.getByTestId('agent-run-configuration');
    // The task card precedes the run settings in the document order the
    // reference reads in, so nothing has to be scrolled past to write a task.
    expect(task.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const start = screen.getByTestId('agent-start-button');
    expect(start).toBeDisabled();
    expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Choose a working directory to start.');

    useAgentStore.setState({ workingDirectory: { handle: 'h', displayName: 'chosen-workspace' } });
    await waitFor(() => {
      expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Describe the task to start.');
    });

    fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'Add a regression test.' } });
    await waitFor(() => {
      expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Ready to start.');
      expect(screen.getByTestId('agent-start-button')).toBeEnabled();
    });
  });

  it('keeps the document context controls inside the task card and every run setting in one card', async () => {
    render(<AgentComposer />);

    const task = await screen.findByTestId('agent-context-section');
    // Context is attached from the task card's own footer, not a separate
    // section, and it is never attached implicitly.
    expect(task).toContainElement(screen.getByTestId('agent-attach-entire-doc'));
    expect(task).toContainElement(screen.getByTestId('agent-no-context-notice'));

    const settingsCard = screen.getByTestId('agent-run-configuration').closest('.companion-card');
    expect(settingsCard).not.toBeNull();
    for (const control of ['agent-working-directory', 'composer-execution-mode-select']) {
      expect(settingsCard).toContainElement(screen.getByTestId(control));
    }
    expect(screen.getByRole('combobox', { name: 'Agent profile' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Agent model' })).toBeTruthy();
  });

  it('keeps All sessions in the header before the first run and says the history is empty', async () => {
    useAgentStore.setState({ sessions: [] });
    installApi({ listSessions: vi.fn(() => Promise.resolve([])) });
    render(<AgentComposer />);

    await screen.findByTestId('agent-context-section');
    const list = screen.getByTestId('agent-session-list');
    const trigger = within(list).getByRole('button', { name: 'All sessions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The chip is still the heading that names the section it opens.
    expect(document.getElementById('agent-session-list-heading')).toBe(
      within(list).getByRole('heading', { name: 'All sessions' })
    );

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('agent-session-list-empty')).toHaveTextContent('No agent sessions yet.');
    expect(screen.queryByRole('list', { name: 'All agent sessions' })).toBeNull();
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(<AgentComposer />);
    await screen.findByTestId('agent-context-section');
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('6b — run view', () => {
  beforeEach(() => {
    useAgentStore.setState({
      profiles: [profile], selectedProfileId: profile.id, hydrated: true,
      activeSession: session, sessions: [session], events: runEvents,
      workingDirectory: { handle: 'handle-redesign', displayName: 'redesign-workspace' },
    });
  });

  it('states the run once in the header and summarises the task above the feed', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    // Status, provider, model, directory, mode and runtime are each stated in
    // exactly one place.
    expect(screen.getAllByTestId('agent-session-status-badge')).toHaveLength(1);
    expect(screen.getByTestId('agent-session-status-badge')).toHaveTextContent('Completed');
    expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Session completed.');
    expect(screen.getAllByTestId('agent-active-session-model')).toHaveLength(1);
    expect(screen.getByTestId('agent-active-session-model')).toHaveTextContent('fixture-model');
    expect(screen.getByTestId('agent-active-session-profile')).toHaveTextContent(profile.name);
    expect(screen.getByTestId('agent-active-session-mode')).toHaveTextContent('Isolated Directory Copy');
    expect(screen.getByTestId('agent-session-runtime')).toHaveTextContent('2m 5s');

    expect(screen.getByTestId('agent-active-session-title')).toHaveTextContent(session.userPrompt);
    expect(screen.getByTestId('agent-session-context-summary')).toHaveTextContent('pages 1–2');
  });

  it('folds a run of equivalent transport errors into one expandable group with its count', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    const group = screen.getByRole('button', { name: /3 repeated errors/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    // The three individual rows are folded away, not merely restyled.
    const regionId = group.getAttribute('aria-controls') ?? '';
    const region = document.getElementById(regionId);
    if (region === null) throw new Error('The error group names no region.');
    expect(region).not.toBeVisible();

    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(within(region).getAllByRole('alert')).toHaveLength(3);
    expect(region).toHaveTextContent('transport error: connection reset');
  });

  it('pins resume outside the scrolling feed and sends the follow-up prompt', async () => {
    const resume = vi.fn(() => Promise.resolve(true));
    useAgentStore.setState({ resume });
    render(<AgentComposer />);

    const feed = await screen.findByTestId('agent-activity-list');
    const composer = screen.getByTestId('agent-resume-section');
    expect(composer).not.toContainElement(feed);
    expect(feed.closest('[data-testid="agent-resume-section"]')).toBeNull();

    const button = screen.getByTestId('agent-resume-button');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Follow-up prompt'), { target: { value: 'Also update the README.' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => { expect(resume).toHaveBeenCalledWith('Also update the README.'); });
  });

  it('states why resume is unavailable once the environment was applied', async () => {
    useAgentStore.setState({ activeSession: { ...session, environmentState: 'applied' } });
    render(<AgentComposer />);

    expect(await screen.findByTestId('agent-resume-blocked')).toHaveTextContent(/already applied/);
    expect(screen.queryByTestId('agent-resume-button')).toBeNull();
  });

  it('keeps session navigation reachable from the run header overflow control', async () => {
    const deselectSession = vi.fn();
    const selectSession = vi.fn();
    useAgentStore.setState({ deselectSession, selectSession });
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    // A completed run offers no Stop: the reference header ends with the
    // overflow control, and stopping a finished run is not an action.
    expect(screen.queryByTestId('agent-stop-button')).toBeNull();

    const trigger = screen.getByTestId('agent-run-menu-button');
    expect(trigger).toHaveAccessibleName('All sessions');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const region = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    if (region === null) throw new Error('The overflow control names no region.');
    expect(region).not.toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(region).getByRole('list', { name: 'All agent sessions' })).toBeTruthy();

    // Escape closes it and gives focus back to the control that opened it.
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(screen.getByTestId('agent-back-button'));
    expect(deselectSession).toHaveBeenCalled();
  });

  it('offers Stop only while the run can still be stopped', async () => {
    useAgentStore.setState({
      activeSession: { ...session, status: 'running' },
      events: [{ sessionId: session.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:00:00.000Z' }],
    });
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    expect(screen.getByTestId('agent-stop-button')).toBeEnabled();
    // Stop and the overflow control wrap together at the trailing edge, so a
    // narrow panel never leaves the overflow alone under "New task".
    const cluster = screen.getByTestId('agent-stop-button').parentElement!;
    expect(cluster).toContainElement(screen.getByTestId('agent-run-menu-button'));
    expect(cluster).toHaveClass('ml-auto', 'shrink-0');
  });

  it('withholds Stop while a finished session is being resumed', async () => {
    // Resuming sets the store's global `loading` flag while the selected
    // session is still terminal. Stop must follow this session's lifecycle
    // instead, or the header offers a cancel that main can only refuse.
    let releaseResume!: () => void;
    const pending = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resumed: AgentSessionDetail = {
      ...session,
      status: 'running',
      eventCount: 1,
      events: [{ sessionId: session.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:03:00.000Z' }],
    };
    installApi({
      resumeSession: vi.fn(async () => { await pending; return { session: resumed }; }),
      getSession: vi.fn(() => Promise.resolve(resumed)),
    });
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');
    expect(screen.queryByTestId('agent-stop-button')).toBeNull();

    fireEvent.change(screen.getByLabelText('Follow-up prompt'), { target: { value: 'Also update the README.' } });
    fireEvent.click(screen.getByTestId('agent-resume-button'));
    await waitFor(() => { expect(useAgentStore.getState().loading).toBe(true); });
    expect(useAgentStore.getState().activeSession?.status).toBe('completed');
    expect(screen.queryByTestId('agent-stop-button')).toBeNull();

    // Once the run itself reports an active lifecycle, cancel is offered again.
    releaseResume();
    await waitFor(() => { expect(screen.getByTestId('agent-stop-button')).toBeEnabled(); });
  });

  it('describes a historical run from its own record, not the current composer state', async () => {
    // A directory chosen after the run must not retitle the run's header, and
    // the reference has no generic source label there at all.
    useAgentStore.setState({
      workingDirectory: { handle: 'handle-other', displayName: 'some-other-workspace' },
      workingDirectorySource: 'session-override',
    });
    const { rerender } = render(<AgentComposer />);
    const header = (await screen.findByTestId('agent-activity-list')).closest('section');
    if (header === null) throw new Error('The run view has no section.');

    expect(within(header).queryByTestId('agent-working-directory-source')).toBeNull();
    expect(header).not.toHaveTextContent('some-other-workspace');
    expect(header).toHaveTextContent('redesign-workspace');
    // An isolated run carries no direct-workspace warning.
    expect(screen.queryByTestId('agent-direct-mode-warning')).toBeNull();

    useAgentStore.setState({ activeSession: { ...session, executionMode: 'active-env' } });
    rerender(<AgentComposer />);
    await waitFor(() => {
      expect(screen.getByTestId('agent-direct-mode-warning')).toHaveTextContent('directly in the selected working directory');
    });
  });

  it('does not paint a test report with no counted results as a pass, and keeps a single run undivided', async () => {
    useAgentStore.setState({
      events: [
        ...runEvents,
        { sessionId: session.id, ordinal: 5, type: 'tests', data: { passed: 0, failed: 0 }, timestamp: '2026-09-01T00:02:01.000Z' },
        { sessionId: session.id, ordinal: 6, type: 'tests', data: { passed: 3, failed: 0 }, timestamp: '2026-09-01T00:02:02.000Z' },
      ],
    });
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    expect(screen.getByTestId('activity-tests-test-5')).toHaveTextContent('No results');
    expect(screen.getByTestId('activity-tests-test-6')).toHaveTextContent('Passed');
    expect(screen.queryByTestId('agent-run-divider')).toBeNull();
  });

  it('wraps the run meta as whole chips that keep their own case and full accessible values', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    const row = screen.getByTestId('agent-session-meta');
    expect(row.className).toContain('flex-wrap');
    expect(row.className).not.toContain('flex-nowrap');
    for (const [testId, label, value] of [
      ['agent-active-session-profile', 'Profile', profile.name],
      ['agent-active-session-model', 'Model', 'fixture-model'],
      ['agent-active-session-directory', 'Working directory', 'redesign-workspace'],
      ['agent-active-session-mode', 'Mode', 'Isolated Directory Copy'],
    ] as const) {
      const chip = screen.getByTestId(testId).parentElement;
      // Chips never shrink to share a line; only a value wider than the whole
      // row truncates, bounded to that row.
      expect(chip?.className).toContain('shrink-0');
      expect(chip?.className).toContain('max-w-full');
      expect(chip?.className).not.toContain('uppercase');
      expect(chip).toHaveAttribute('title', `${label}: ${value}`);
      expect(chip).toHaveTextContent(`${label}: ${value}`);
    }
    // The runtime never shrinks into an orphan line of its own.
    expect(screen.getByTestId('agent-session-runtime').className).toContain('shrink-0');
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('6b — failed run', () => {
  const failed: AgentSessionDetail = { ...session, status: 'failed', finalReport: null, executionMode: 'isolated-worktree' };
  const earlierRun: AgentEvent[] = [
    { sessionId: session.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:00:00.000Z' },
    { sessionId: session.id, ordinal: 1, type: 'stderr', stream: 'stderr', text: 'old warning from the first run', timestamp: '2026-09-01T00:00:01.000Z' },
    { sessionId: session.id, ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: '2026-09-01T00:00:02.000Z' },
  ];
  const failingRun: AgentEvent[] = [
    { sessionId: session.id, ordinal: 3, type: 'started', timestamp: '2026-09-01T00:01:00.000Z' },
    { sessionId: session.id, ordinal: 4, type: 'stderr', stream: 'stderr', text: 'compiling\nerror: cannot find module `parser`\n', timestamp: '2026-09-01T00:01:01.000Z' },
    { sessionId: session.id, ordinal: 5, type: 'ended', exitCode: 2, signal: null, timestamp: '2026-09-01T00:01:02.000Z' },
  ];

  beforeEach(() => {
    useAgentStore.setState({
      profiles: [profile], selectedProfileId: profile.id, hydrated: true,
      activeSession: failed, sessions: [failed], events: [...earlierRun, ...failingRun],
      workingDirectory: { handle: 'handle-redesign', displayName: 'redesign-workspace' },
    });
  });

  it('states what failed in the newest run, its exit code and its last stderr line', async () => {
    render(<AgentComposer />);
    const card = await screen.findByTestId('agent-failure-card');

    expect(within(card).getByTestId('agent-failure-reason')).toHaveTextContent('The agent exited with code 2.');
    expect(within(card).getByTestId('agent-failure-exit-code')).toHaveTextContent('Exit code 2');
    // Plain text, and only the newest run's output.
    const stderr = within(card).getByTestId('agent-failure-stderr');
    expect(stderr).toHaveTextContent('error: cannot find module `parser`');
    expect(stderr.children).toHaveLength(0);
    expect(card).not.toHaveTextContent('old warning');
    // A failed run has no result card to compete with it.
    expect(screen.queryByTestId('agent-result-card')).toBeNull();
  });

  it('reopens the task with its settings on Retry without starting anything', async () => {
    const start = vi.fn(() => Promise.resolve(false));
    const startSession = vi.fn();
    installApi({ startSession });
    useAgentStore.setState({ start });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: 'something else' } });
    render(<AgentComposer />);

    fireEvent.click(await screen.findByTestId('agent-failure-retry'));

    expect(await screen.findByTestId('agent-context-section')).toBeTruthy();
    expect(useAgentStore.getState().activeSession).toBeNull();
    expect(useUiStore.getState().composer.taskDraft).toBe(session.userPrompt);
    expect(useUiStore.getState().composer.executionMode).toBe('isolated-worktree');
    expect(screen.getByLabelText('Task description')).toHaveValue(session.userPrompt);
    expect(start).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it('never restores a direct-workspace mode, and Edit task focuses the task', async () => {
    useAgentStore.setState({ activeSession: { ...failed, executionMode: 'active-env' } });
    render(<AgentComposer />);

    fireEvent.click(await screen.findByTestId('agent-failure-edit'));

    const task = await screen.findByLabelText('Task description');
    expect(useUiStore.getState().composer.executionMode).toBe('auto-isolated');
    await waitFor(() => { expect(document.activeElement).toBe(task); });
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(<AgentComposer />);
    await screen.findByTestId('agent-failure-card');
    expect(await seriousViolations(container)).toEqual([]);
  });
});
