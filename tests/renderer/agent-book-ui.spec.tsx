// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentProfile, AgentSessionDetail } from '@shared/types/agent';
import type { DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { AGENT_MAX_PROMPT_LENGTH } from '@shared/schemas/agent';
import type { InterleafAPI } from '@shared/types/api';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { AgentTaskCard } from '../../src/renderer/features/agent/AgentTaskCard';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { testReaderSession } from '../helpers/reader-session';

/**
 * What the Agents panel tells the reader while working in a book: session
 * failures, follow-up drafts, prompt limits, page-range errors and export
 * results each belong to the run or book they came from.
 */

function pdf(id: string, pageCount: number): DocumentMetadata {
  return {
    id, title: `Book ${id}`, author: null, format: 'pdf', storageMode: 'managed', fileSize: 1, fileMtimeMs: 1,
    fileHash: `${id}-hash`, pageCount, folderId: null, storageHealth: 'ok', readingPosition: null,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', source: null,
  };
}

const book = pdf('book-a', 4);

const profile: AgentProfile = {
  id: 'profile-ui', providerId: 'fake', name: 'Profile UI', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-10-13T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

function run(id: string, overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id, documentId: book.id, profileId: profile.id, providerId: 'fake',
    targetDirectory: { handle: 'h1', displayName: 'workspace' }, executionMode: 'isolated-copy',
    status: 'completed', providerSessionId: `provider-${id}`, userPrompt: `task ${id}`, contextSummary: null,
    effectiveModel: null, effectiveReasoningEffort: null,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    finalReport: `Report ${id}`, environment: null, eventCount: 0, events: [], artifacts: [],
    ...overrides,
  };
}

function withEnvironment(id: string): AgentSessionDetail {
  return run(id, {
    environment: {
      sessionId: id, mode: 'isolated-copy', riskLevel: 'low', workspaceLabel: 'Isolated directory copy',
      primaryWasDirty: false, applyAllowed: true, applied: false, applyDisabledReason: null,
      activeWorkspaceModified: false, changedFiles: [{ path: 'a.txt', kind: 'modified', additions: 1, deletions: 0, bytes: 4 }],
      tests: [], diffAvailable: true, diff: 'diff --git a/a.txt b/a.txt\n+a', patchAvailable: true, containerRuntime: null,
    },
  });
}

function installApi(agent: Partial<InterleafAPI['agent']> = {}, settings: AppSettings = DEFAULT_APP_SETTINGS): void {
  stubBridge({
    settings: { get: vi.fn(() => Promise.resolve(settings)) },
    agent: {
      listWorkingDirectories: vi.fn(() => Promise.resolve([])),
      listProfiles: vi.fn(() => Promise.resolve([profile])),
      listSessions: vi.fn(() => Promise.resolve([])),
      getModeAvailability: vi.fn(() => Promise.resolve([])),
      getSession: vi.fn(() => Promise.resolve(null)),
      onEvent: vi.fn(() => () => undefined),
      ...agent,
    },
  });
}

/** Opens the panel on `session` in the book, as if the reader had selected it. */
function showSession(session: AgentSessionDetail, sessions: readonly AgentSessionDetail[] = [session]): void {
  useAgentStore.setState({
    documentId: book.id, profiles: [profile], selectedProfileId: profile.id,
    activeSession: session, sessions: [...sessions], events: [], hydrated: true,
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function blankPages(document: DocumentMetadata): void {
  const adapter = testDocumentAdapter('pdf', {
    extractText: async function* () {
      await Promise.resolve();
      for (let index = 0; index < (document.pageCount ?? 0); index += 1) {
        const chunk: NormalizedTextChunk = {
          id: `${document.id}-${String(index)}`, documentId: document.id, ordinal: index, text: '   ', tokenCount: 0,
          location: { format: 'pdf', pageIndex: index }, heading: null, pageLabel: String(index + 1),
        };
        yield chunk;
      }
    },
  });
  useReaderStore.setState({ session: testReaderSession(document, { adapter }) });
}

afterEach(() => {
  cleanup();
  useReaderStore.setState({ session: null });
  useAgentStore.setState({
    documentId: null, profiles: [], selectedProfileId: null, workingDirectory: null, activeSession: null,
    sessions: [], events: [], loading: false, stopping: false, error: null, hydrated: false, contextPacket: null, pendingContext: null,
  });
  useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
});

describe('Agent book UI: session feedback', () => {
  it('shows why an action on the open run failed', async () => {
    installApi();
    useReaderStore.setState({ session: testReaderSession(book) });
    showSession(run('run-a'));

    render(<AgentComposer />);
    await screen.findByTestId('agent-final-report');
    act(() => { useAgentStore.setState({ error: 'The environment folder could not be opened.' }); });

    expect(await screen.findByTestId('agent-session-error')).toHaveTextContent('The environment folder could not be opened.');
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('agent-session-error'));
  });

  it('reports an exported patch as success, and not on another run', async () => {
    const exportPatch = vi.fn(() => Promise.resolve({ outcome: 'exported' as const, artifactId: 'artifact-1', fileName: 'run-a.patch', bytes: 42 }));
    installApi({ exportPatch });
    useReaderStore.setState({ session: testReaderSession(book) });
    const runA = withEnvironment('run-a');
    const runB = withEnvironment('run-b');
    showSession(runA, [runA, runB]);

    render(<AgentComposer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Patch…' }));

    expect(await screen.findByTestId('agent-review-action-status')).toHaveTextContent('Patch exported: run-a.patch (42 bytes).');
    expect(screen.queryByTestId('agent-session-error')).toBeNull();

    useAgentStore.setState({ activeSession: runB });
    await waitFor(() => { expect(screen.queryByTestId('agent-review-action-status')).toBeNull(); });
  });
});

describe('Agent book UI: follow-ups', () => {
  it('does not carry a follow-up draft to another session', async () => {
    installApi();
    useReaderStore.setState({ session: testReaderSession(book) });
    const runA = run('run-a');
    const runB = run('run-b');
    showSession(runA, [runA, runB]);

    render(<AgentComposer />);
    fireEvent.change(await screen.findByLabelText('Follow-up prompt'), { target: { value: 'only for run A' } });
    useAgentStore.setState({ activeSession: runB });

    await waitFor(() => { expect(screen.getByLabelText('Follow-up prompt')).toHaveValue(''); });
  });

  it('keeps text typed while a resume was in flight', async () => {
    const pending = deferred<{ session: AgentSessionDetail }>();
    installApi({ resumeSession: vi.fn(() => pending.promise) });
    useReaderStore.setState({ session: testReaderSession(book) });
    const runA = run('run-a');
    showSession(runA);

    render(<AgentComposer />);
    const field = await screen.findByLabelText('Follow-up prompt');
    fireEvent.change(field, { target: { value: 'first follow-up' } });
    fireEvent.click(screen.getByTestId('agent-resume-button'));
    fireEvent.change(field, { target: { value: 'next idea' } });
    pending.resolve({ session: run('run-a', { status: 'completed' }) });

    expect(await screen.findByTestId('agent-resume-status')).toHaveTextContent('Session resumed.');
    expect(screen.getByLabelText('Follow-up prompt')).toHaveValue('next idea');
  });

  it('blocks a follow-up over the prompt limit and says why', async () => {
    const resumeSession = vi.fn();
    installApi({ resumeSession });
    useReaderStore.setState({ session: testReaderSession(book) });
    showSession(run('run-a'));

    render(<AgentComposer />);
    const field = await screen.findByLabelText('Follow-up prompt');
    fireEvent.change(field, { target: { value: 'x'.repeat(AGENT_MAX_PROMPT_LENGTH + 1) } });

    expect(screen.getByTestId('agent-resume-length')).toHaveTextContent('Shorten the prompt to 100,000 characters or fewer');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'agent-followup-length');
    expect(screen.getByTestId('agent-resume-button')).toBeDisabled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('blocks a new task over the prompt limit and says why', async () => {
    installApi({ listWorkingDirectories: vi.fn(() => Promise.resolve([{ handle: 'h1', displayName: 'workspace' }])) }, {
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultWorkingDirectoryByProfile: { [profile.id]: 'h1' } },
    });
    useReaderStore.setState({ session: testReaderSession(book) });
    useAgentStore.setState({
      documentId: book.id, profiles: [profile], selectedProfileId: profile.id,
      workingDirectory: { handle: 'h1', displayName: 'workspace' }, workingDirectories: [{ handle: 'h1', displayName: 'workspace' }],
      workingDirectorySource: 'profile-default', hydrated: true,
    });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: 'x'.repeat(AGENT_MAX_PROMPT_LENGTH + 1) }, loadedSettings: null });

    render(<AgentComposer />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-session-status')).toHaveTextContent('Shorten the prompt to 100,000 characters or fewer');
    });
    expect(screen.getByTestId('agent-start-button')).toBeDisabled();
  });
});

describe('Agent book UI: task draft after Start', () => {
  /** The composer ready to start `draft` in the book, with `startSession` faked. */
  function readyToStart(draft: string, startSession: InterleafAPI['agent']['startSession']): void {
    installApi({
      listWorkingDirectories: vi.fn(() => Promise.resolve([{ handle: 'h1', displayName: 'workspace' }])),
      startSession,
    }, {
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultWorkingDirectoryByProfile: { [profile.id]: 'h1' } },
    });
    useReaderStore.setState({ session: testReaderSession(book) });
    useAgentStore.setState({
      documentId: book.id, profiles: [profile], selectedProfileId: profile.id,
      workingDirectory: { handle: 'h1', displayName: 'workspace' }, workingDirectories: [{ handle: 'h1', displayName: 'workspace' }],
      workingDirectorySource: 'profile-default', hydrated: true,
    });
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: draft }, loadedSettings: null });
  }

  async function pressStart(): Promise<void> {
    const button = await screen.findByTestId('agent-start-button');
    await waitFor(() => { expect(button).toBeEnabled(); });
    fireEvent.click(button);
  }

  it('clears the submitted task once the run has started, so it cannot be re-run on another book', async () => {
    readyToStart('summarize the pages', vi.fn(() => Promise.resolve({ session: run('started', { userPrompt: 'summarize the pages', status: 'running' }) })));
    render(<AgentComposer />);
    await pressStart();
    await waitFor(() => { expect(useAgentStore.getState().activeSession?.id).toBe('started'); });
    expect(useUiStore.getState().composer.taskDraft).toBe('');
  });

  it('keeps the task when the run could not start', async () => {
    readyToStart('summarize the pages', vi.fn(() => Promise.reject(new Error('Provider unavailable.'))));
    render(<AgentComposer />);
    await pressStart();
    await waitFor(() => { expect(useAgentStore.getState().error).toBe('Provider unavailable.'); });
    expect(useUiStore.getState().composer.taskDraft).toBe('summarize the pages');
  });

  it('keeps a new task typed while the run was starting', async () => {
    const started = deferred<{ readonly session: AgentSessionDetail }>();
    readyToStart('summarize the pages', vi.fn(() => started.promise));
    render(<AgentComposer />);
    await pressStart();
    act(() => { useUiStore.getState().setTaskDraft('next task'); });
    await act(async () => { started.resolve({ session: run('started', { status: 'running' }) }); await started.promise; });
    await waitFor(() => { expect(useAgentStore.getState().activeSession?.id).toBe('started'); });
    expect(useUiStore.getState().composer.taskDraft).toBe('next task');
  });
});

describe('Agent book UI: page range', () => {
  it('rejects a fractional page instead of rounding it', async () => {
    installApi();
    useReaderStore.setState({ session: testReaderSession(book) });
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    const start = await screen.findByLabelText('Start');
    fireEvent.change(start, { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('agent-pages-submit'));

    expect(await screen.findByTestId('agent-pages-error')).toHaveTextContent('Page numbers must be positive whole numbers.');
    expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(start).toHaveAttribute('aria-describedby', 'agent-pages-error');
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('opens fresh when reopened during its closing animation', async () => {
    installApi();
    useReaderStore.setState({ session: testReaderSession(book) });
    render(<AgentTaskCard activeDocument={book} disabled={false} />);
    const trigger = screen.getByTestId('agent-pages-trigger');

    fireEvent.click(trigger);
    fireEvent.change(await screen.findByLabelText('Start'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('agent-pages-submit'));
    await screen.findByTestId('agent-pages-error');
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    const start = await screen.findByLabelText('Start');
    expect(start).toHaveValue(1);
    expect(screen.queryByTestId('agent-pages-error')).toBeNull();
    await waitFor(() => { expect(start).toHaveFocus(); });
  });

  it('explains a failed capture inside the dialog that asked for it', async () => {
    installApi();
    blankPages(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    await screen.findByLabelText('Start');
    fireEvent.click(screen.getByTestId('agent-pages-submit'));

    expect(await screen.findByTestId('agent-pages-error')).toHaveTextContent('Page 1 has no readable text to attach to Agent context.');
    expect(screen.getByRole('dialog', { name: 'Add pages to agent context' })).toBeInTheDocument();
    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('does not carry an open page picker to another book', async () => {
    installApi();
    const other = pdf('book-b', 9);
    useReaderStore.setState({ session: testReaderSession(book) });
    const { rerender } = render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    await screen.findByRole('dialog', { name: 'Add pages to agent context' });

    useReaderStore.setState({ session: testReaderSession(other) });
    rerender(<AgentTaskCard activeDocument={other} disabled={false} />);

    expect(screen.queryByRole('dialog', { name: 'Add pages to agent context' })).toBeNull();
    expect(screen.getByTestId('agent-pages-trigger')).toHaveAttribute('aria-expanded', 'false');
  });
});

/** A one-page PDF whose text is released only when the test says so. */
function heldPage(document: DocumentMetadata): { readonly release: () => Promise<void> } {
  const gate = deferred<undefined>();
  const adapter = testDocumentAdapter('pdf', {
    extractText: async function* () {
      await gate.promise;
      const chunk: NormalizedTextChunk = {
        id: `${document.id}-0`, documentId: document.id, ordinal: 0, text: 'Page text', tokenCount: 1,
        location: { format: 'pdf', pageIndex: 0 }, heading: null, pageLabel: '1',
      };
      yield chunk;
    },
  });
  useReaderStore.setState({ session: testReaderSession(document, { adapter }) });
  return { release: () => act(async () => { gate.resolve(undefined); await gate.promise; }) };
}

describe('Agent book UI: closing the page picker withdraws its capture', () => {
  it.each([
    ['Cancel', () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); }],
    ['Escape', () => { fireEvent.keyDown(screen.getByRole('dialog', { name: 'Add pages to agent context' }), { key: 'Escape' }); }],
    ['an outside click', () => { fireEvent.pointerDown(window.document.body); }],
  ])('stops a pending page capture on %s', async (_name, close) => {
    installApi();
    const held = heldPage(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    await screen.findByLabelText('Start');
    fireEvent.click(screen.getByTestId('agent-pages-submit'));
    expect(await screen.findByTestId('agent-context-pending')).toHaveTextContent('Attaching Page 1…');
    close();
    await held.release();

    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().pendingContext).toBeNull();
    expect(screen.getByTestId('agent-no-context-notice')).toBeInTheDocument();
  });

  it('moves focus to Remove once the range lands, though the summary unmounts the picker', async () => {
    installApi();
    const held = heldPage(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    await screen.findByLabelText('Start');
    fireEvent.click(screen.getByTestId('agent-pages-submit'));
    await screen.findByTestId('agent-context-pending');
    (window.document.activeElement as HTMLElement | null)?.blur();
    await held.release();

    expect(await screen.findByTestId('agent-context-range')).toHaveTextContent('Page 1');
    await waitFor(() => { expect(screen.getByTestId('agent-remove-context')).toHaveFocus(); });
  });

  it('never clears an error that belongs to something else', async () => {
    installApi();
    const held = heldPage(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-pages-trigger'));
    await screen.findByLabelText('Start');
    fireEvent.click(screen.getByTestId('agent-pages-submit'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => { useAgentStore.setState({ error: 'Another operation failed.' }); });
    await held.release();

    expect(useAgentStore.getState().error).toBe('Another operation failed.');
  });
});

describe('Agent book UI: a capture in progress', () => {
  it('shows a whole-book capture while it reads, and Cancel withdraws it and keeps focus in the panel', async () => {
    installApi();
    const held = heldPage(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-attach-entire-doc'));
    const pending = await screen.findByTestId('agent-context-pending');
    expect(pending).toHaveTextContent('Attaching Entire document…');
    expect(screen.getByRole('status')).toHaveTextContent('Attaching Entire document…');
    expect(screen.queryByTestId('agent-no-context-notice')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel attaching Entire document' }));
    await held.release();

    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(screen.queryByTestId('agent-context-pending')).toBeNull();
    await waitFor(() => { expect(screen.getByTestId('agent-attach-entire-doc')).toHaveFocus(); });
  });

  it('replaces the pending status with what was attached once it lands', async () => {
    installApi();
    const held = heldPage(book);
    render(<AgentTaskCard activeDocument={book} disabled={false} />);

    fireEvent.click(screen.getByTestId('agent-attach-entire-doc'));
    await screen.findByTestId('agent-context-pending');
    await held.release();

    expect(await screen.findByTestId('agent-context-range')).toHaveTextContent('Entire document');
    expect(screen.queryByTestId('agent-context-pending')).toBeNull();
  });
});

describe('Agent book UI: follow-ups across a real run', () => {
  it('keeps the next idea and the sent follow-up through running and back to completed', async () => {
    const pending = deferred<{ session: AgentSessionDetail }>();
    installApi({ resumeSession: () => pending.promise, getSession: () => Promise.resolve(run('run-a', { status: 'running' })) });
    useReaderStore.setState({ session: testReaderSession(book) });
    showSession(run('run-a'));

    render(<AgentComposer />);
    const field = await screen.findByLabelText('Follow-up prompt');
    fireEvent.change(field, { target: { value: 'first' } });
    fireEvent.click(screen.getByTestId('agent-resume-button'));
    fireEvent.change(field, { target: { value: 'next idea' } });
    await act(async () => { pending.resolve({ session: run('run-a', { status: 'running' }) }); await pending.promise; });
    await waitFor(() => { expect(screen.queryByLabelText('Follow-up prompt')).toBeNull(); });

    act(() => { useAgentStore.setState({ activeSession: run('run-a', { status: 'completed' }), loading: false }); });

    const restored = await screen.findByLabelText('Follow-up prompt');
    expect(restored).toHaveValue('next idea');
    // The follow-up already sent is still in this run's history.
    fireEvent.change(restored, { target: { value: '' } });
    fireEvent.keyDown(restored, { key: 'ArrowUp' });
    expect(restored).toHaveValue('first');
  });

  it('keeps each run\'s draft to itself across an unmount', async () => {
    installApi();
    useReaderStore.setState({ session: testReaderSession(book) });
    const runA = run('run-a');
    const runB = run('run-b');
    showSession(runA, [runA, runB]);

    const view = render(<AgentComposer />);
    fireEvent.change(await screen.findByLabelText('Follow-up prompt'), { target: { value: 'only for run A' } });
    view.unmount();
    showSession(runB, [runA, runB]);
    render(<AgentComposer />);

    expect(await screen.findByLabelText('Follow-up prompt')).toHaveValue('');
  });
});

describe('Agent book UI: patch export', () => {
  it('reports a closed save dialog neutrally, not as an error', async () => {
    installApi({ exportPatch: vi.fn(() => Promise.resolve({ outcome: 'cancelled' as const })) });
    useReaderStore.setState({ session: testReaderSession(book) });
    showSession(withEnvironment('run-a'));

    render(<AgentComposer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Patch…' }));

    expect(await screen.findByTestId('agent-review-action-status')).toHaveTextContent('Patch export cancelled. Nothing was saved.');
    expect(screen.queryByTestId('agent-session-error')).toBeNull();
  });
});
