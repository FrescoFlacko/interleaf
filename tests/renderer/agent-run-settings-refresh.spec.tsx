// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AgentProfile, AgentSession } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import { AgentTaskView } from '../../src/renderer/features/agent/AgentTaskView';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testAgentProfile } from '../helpers/agent-profile';
import { testReaderSession } from '../helpers/reader-session';
import { chooseValue } from '../helpers/listbox-select';

/**
 * The Agent panel reloads its profiles, sessions and directories whenever the
 * panel is shown again for the same book. That refresh used to share the
 * launch's busy flag, so it disabled the profile and model pickers — closing a
 * menu the reader had open and dropping focus — even though every choice made
 * during a refresh is already kept by the store. These cases drive the real
 * panel against a refresh whose answer is held back.
 */

const book: DocumentMetadata = {
  id: 'book-refresh', title: 'Refresh Book', author: null, format: 'pdf', storageMode: 'managed',
  fileSize: 1, fileMtimeMs: 1, fileHash: 'h', pageCount: 4, folderId: null, storageHealth: 'ok',
  readingPosition: null, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', source: null,
};

function modelProfile(id: 'codex' | 'claude-code', name: string): AgentProfile {
  const base = testAgentProfile(id, name);
  return { ...base, defaultModel: 'model-a', availableModels: ['model-a', 'model-b'], capabilities: { ...base.capabilities, modelSelection: true } };
}
const fixture = modelProfile('codex', 'Fixture Agent');
const other = modelProfile('claude-code', 'Other Agent');
const directory = { handle: 'dir-h', displayName: 'Project' };

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A panel that has already loaded once for this book, as the reader left it. */
function seedLoadedPanel(): void {
  useReaderStore.setState({ session: testReaderSession(book) });
  useAgentStore.setState({
    documentId: book.id, profiles: [fixture, other], selectedProfileId: fixture.id, selectedModel: 'model-a',
    modeAvailability: [], workingDirectory: directory, workingDirectorySource: 'global-default', workingDirectories: [directory],
    activeSession: null, sessions: [], events: [], loading: false, launching: false, stopping: false, error: null, hydrated: true,
  });
  useUiStore.getState().setTaskDraft('summarise the book');
}

function renderPanel(): void {
  // The composer forwards a model choice to the store; the panel only reports it.
  const onModelChange = (model: string | null): void => { useAgentStore.getState().setSelectedModel(model); };
  render(<AgentTaskView activeDocument={book} onModeChange={vi.fn()} onModelChange={onModelChange} />);
}

const picker = (name: string): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('combobox', { name });

describe('Agent run settings during a same-book refresh', () => {
  let profiles: ReturnType<typeof deferred<readonly AgentProfile[]>>;

  beforeEach(() => {
    seedLoadedPanel();
    profiles = deferred();
    stubBridge({
      agent: {
        listProfiles: () => profiles.promise,
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([directory]),
        getModeAvailability: () => Promise.resolve([]),
        onEvent: () => () => undefined,
      },
    });
  });

  afterEach(() => {
    cleanup();
    useReaderStore.setState({ session: null });
    useAgentStore.setState({ activeSession: null, sessions: [], loading: false, launching: false, hydrated: false });
    useUiStore.getState().setTaskDraft('');
  });

  it.each(['Agent profile', 'Agent model'])('keeps the %s menu open and usable while the refresh is pending', async (name) => {
    renderPanel();
    const trigger = picker(name);
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    let refresh!: Promise<void>;
    act(() => { refresh = useAgentStore.getState().hydrate(book.id); });
    expect(useAgentStore.getState().loading).toBe(true);
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(trigger);
    // Start still waits for the refresh: the store would refuse it meanwhile.
    expect(screen.getByTestId('agent-start-button')).toBeDisabled();

    await act(async () => { profiles.resolve([fixture, other]); await refresh; });
    expect(trigger).toBeEnabled();
  });

  it('keeps a profile and a model chosen while the refresh is pending', async () => {
    renderPanel();
    let refresh!: Promise<void>;
    act(() => { refresh = useAgentStore.getState().hydrate(book.id); });
    chooseValue(picker('Agent profile'), other.id);
    chooseValue(picker('Agent model'), 'model-b');

    await act(async () => { profiles.resolve([fixture, other]); await refresh; });
    expect(useAgentStore.getState()).toMatchObject({ selectedProfileId: other.id, selectedModel: 'model-b' });
    expect(picker('Agent profile')).toHaveTextContent('Other Agent');
    expect(picker('Agent model')).toHaveTextContent('model-b');
  });

  it('stays locked until the panel has loaded for the first time', async () => {
    useAgentStore.setState({ hydrated: false });
    renderPanel();
    let first!: Promise<void>;
    act(() => { first = useAgentStore.getState().hydrate(book.id); });
    expect(picker('Agent profile')).toBeDisabled();
    expect(picker('Agent model')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Task description' })).toBeDisabled();

    await act(async () => { profiles.resolve([fixture, other]); await first; });
    expect(picker('Agent profile')).toBeEnabled();
    expect(picker('Agent model')).toBeEnabled();
  });

  it('locks the task and its settings while a run is launching, even across a refresh', async () => {
    profiles.resolve([fixture, other]);
    const started = deferred<{ readonly session: AgentSession }>();
    // The refresh keeps the persisted working directory, so nothing but the launch itself holds Start back.
    const settings = { ...DEFAULT_APP_SETTINGS, agent: { ...DEFAULT_APP_SETTINGS.agent, defaultWorkingDirectory: directory.handle } };
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: { startSession: () => started.promise, getSession: () => Promise.resolve(null) },
    });
    renderPanel();

    let launch!: Promise<boolean>;
    act(() => { launch = useAgentStore.getState().start(fixture.id, 'isolated-copy', 'summarise the book'); });
    expect(useAgentStore.getState().launching).toBe(true);
    expect(picker('Agent profile')).toBeDisabled();
    expect(picker('Agent model')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Task description' })).toBeDisabled();

    // A refresh that finishes first must not unlock a launch still in flight.
    await act(async () => { await useAgentStore.getState().hydrate(book.id); });
    expect(useAgentStore.getState()).toMatchObject({ launching: true, loading: false, workingDirectory: directory });
    expect(picker('Agent profile')).toBeDisabled();
    const start = screen.getByTestId('agent-start-button');
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(useAgentStore.getState().launching).toBe(true);

    await act(async () => { started.resolve({ session: launchedSession() }); await launch; });
    expect(useAgentStore.getState().launching).toBe(false);
  });
});

function launchedSession(): AgentSession {
  return {
    id: 'run-1', documentId: book.id, profileId: fixture.id, providerId: 'codex', targetDirectory: directory,
    executionMode: 'isolated-copy', status: 'running', providerSessionId: null, userPrompt: 'summarise the book',
    contextSummary: null, finalReport: null, effectiveModel: null, effectiveReasoningEffort: null,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', eventCount: 0, environment: null,
  };
}
