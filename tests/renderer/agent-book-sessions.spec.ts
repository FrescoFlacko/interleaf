// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AgentEnvironmentReviewResult } from '@shared/types/agent-environment';
import type { AgentContextPacket, AgentProfile, AgentSessionClaimResult, AgentSessionDetail, AgentWorkingDirectory } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { discardOriginOf } from '../../src/renderer/stores/agent/discard-origin';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { recordAgentFollowUp, setAgentFollowUpDraft, useAgentFollowUp } from '../../src/renderer/stores/agent/follow-up-drafts';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

/**
 * A run belongs to the book and session that started it. These cases keep a
 * slow response from replacing whatever the reader moved on to, while the run
 * itself stays recoverable under its own book.
 */

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const claimed: AgentSessionClaimResult = { claimed: true, ownerChanged: false };
const directory: AgentWorkingDirectory = { handle: 'workspace', displayName: 'Workspace' };

const profile: AgentProfile = {
  id: 'fake', providerId: 'fake', name: 'Fake', defaultModel: null, availableModels: [], reasoningEffort: null,
  defaultSandboxMode: 'auto-isolated',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-10-13T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

function session(id: string, documentId: string, status: AgentSessionDetail['status']): AgentSessionDetail {
  return {
    id, documentId, profileId: profile.id, providerId: 'fake', targetDirectory: directory, executionMode: 'isolated-copy',
    status, providerSessionId: null, userPrompt: `prompt ${id}`, contextSummary: null, finalReport: null,
    effectiveModel: null, effectiveReasoningEffort: null, createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z', eventCount: 0, environment: null, events: [], artifacts: [],
  };
}

function packet(documentId: string, quote: string): AgentContextPacket {
  return {
    version: 1,
    document: { id: documentId, hash: `${documentId}-hash`, title: documentId, author: null },
    selection: {
      exactQuote: quote,
      anchor: { format: 'pdf', quote: { exact: quote, prefix: '', suffix: '' }, pageIndex: 0 },
      location: { format: 'pdf', pageIndex: 0 },
      surroundingText: null,
    },
    provenance: { source: 'interleaf-reader-selection', capturedAt: '2026-10-13T00:00:00.000Z', contentIsUntrustedReference: true, truncated: false },
  };
}

function review(sessionId: string): AgentEnvironmentReviewResult {
  return {
    sessionId,
    review: {
      mode: 'isolated-copy', riskLevel: 'low', workspaceLabel: 'Workspace', primaryWasDirty: false, applyAllowed: true,
      applyDisabledReason: null, activeWorkspaceModified: false, changedFiles: [], tests: [], diffAvailable: false,
      diff: null, patchAvailable: true, containerRuntime: null, applied: true,
    },
  };
}

function book(id: string): DocumentMetadata {
  return {
    id, title: id, author: null, format: 'pdf', storageMode: 'managed', fileSize: 1, fileMtimeMs: 1, fileHash: `${id}-hash`,
    pageCount: 1, folderId: null, storageHealth: 'ok', readingPosition: null,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', source: null,
  };
}

/** Book A is open in the reader and its Agent panel has hydrated. */
function ready(patch: Partial<ReturnType<typeof useAgentStore.getState>> = {}): void {
  useReaderStore.setState({ session: testReaderSession(book('book-a')) });
  useAgentStore.setState({
    documentId: 'book-a', profiles: [profile], selectedProfileId: profile.id, selectedModel: null,
    workingDirectory: directory, workingDirectories: [directory], hydrated: true, loading: false, error: null,
    activeSession: null, sessions: [], events: [], contextPacket: null, stopping: false,
    ...patch,
  });
}

afterEach(() => {
  useReaderStore.setState({ session: null });
  useAgentStore.setState({
    documentId: null, profiles: [], selectedProfileId: null, workingDirectory: null, workingDirectories: [],
    activeSession: null, sessions: [], events: [], contextPacket: null, pendingContext: null, loading: false, error: null, stopping: false,
  });
});

describe('Agent start stays with the book that started it', () => {
  it('submits the book, context and directory the reader saw when pressing Start', async () => {
    const started = session('run-a', 'book-a', 'running');
    const startSession = vi.fn(() => Promise.resolve({ session: started }));
    const risk = deferred<{ readonly grantId: string; readonly expiresAt: number; readonly mode: 'active-env' }>();
    stubBridge({ agent: { startSession, getSession: () => Promise.resolve(started), issueRiskGrant: () => risk.promise } });
    ready({ contextPacket: packet('book-a', 'Book A text') });

    const starting = useAgentStore.getState().start(profile.id, 'active-env', 'Do the task');
    // While the confirmation is open the reader switches to another book.
    useAgentStore.setState({ documentId: 'book-b', contextPacket: packet('book-b', 'Book B text'), workingDirectory: { handle: 'other', displayName: 'Other' } });
    risk.resolve({ grantId: 'grant', expiresAt: Date.now() + 60_000, mode: 'active-env' });
    await starting;

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'book-a',
      workingDirectoryHandle: 'workspace',
      contextPacket: expect.objectContaining({ document: expect.objectContaining({ id: 'book-a' }) }),
    }));
    // The new book's panel is not replaced by the old book's run.
    expect(useAgentStore.getState().activeSession).toBeNull();
    expect(useAgentStore.getState().sessions).toEqual([]);
  });

  it('does not let a late start replace a session the reader opened meanwhile', async () => {
    const started = session('run-new', 'book-a', 'running');
    const other = session('run-old', 'book-a', 'completed');
    const start = deferred<{ readonly session: AgentSessionDetail }>();
    stubBridge({
      agent: {
        startSession: () => start.promise,
        claimSession: () => Promise.resolve(claimed),
        getSession: (id: string) => Promise.resolve(id === other.id ? other : started),
      },
    });
    ready({ sessions: [other] });

    const starting = useAgentStore.getState().start(profile.id, 'auto-isolated', 'Do the task');
    await useAgentStore.getState().selectSession(other.id);
    start.resolve({ session: started });
    await starting;

    expect(useAgentStore.getState().activeSession?.id).toBe(other.id);
    // The new run is still listed so it can be opened.
    expect(useAgentStore.getState().sessions.map((item) => item.id)).toContain(started.id);
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it('does not show the previous book\'s start failure in the next book', async () => {
    const start = deferred<{ readonly session: AgentSessionDetail }>();
    stubBridge({ agent: { startSession: () => start.promise, listProfiles: () => Promise.resolve([profile]), getModeAvailability: () => Promise.resolve([]) } });
    ready();

    const starting = useAgentStore.getState().start(profile.id, 'auto-isolated', 'Do the task');
    useAgentStore.setState({ documentId: 'book-b' });
    start.reject(new Error('Start failed in book A.'));
    await starting;

    expect(useAgentStore.getState().error).toBeNull();
  });
});

describe('Agent session responses stay with their session', () => {
  it('ignores a session load that finishes after the reader went back', async () => {
    const pending = deferred<AgentSessionDetail | null>();
    stubBridge({ agent: { claimSession: () => Promise.resolve(claimed), getSession: () => pending.promise } });
    ready();

    const selecting = useAgentStore.getState().selectSession('run-a');
    await Promise.resolve();
    useAgentStore.getState().deselectSession();
    pending.resolve(session('run-a', 'book-a', 'completed'));
    await selecting;

    expect(useAgentStore.getState().activeSession).toBeNull();
  });

  it('clears an earlier session\'s error when another session is opened', async () => {
    const next = session('run-b', 'book-a', 'completed');
    stubBridge({ agent: { claimSession: () => Promise.resolve(claimed), getSession: () => Promise.resolve(next) } });
    ready({ activeSession: session('run-a', 'book-a', 'completed'), error: 'Apply failed for run A.' });

    await useAgentStore.getState().selectSession(next.id);

    expect(useAgentStore.getState().activeSession?.id).toBe(next.id);
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('keeps a newly opened session when a resume of the previous one completes late', async () => {
    const first = session('run-a', 'book-a', 'completed');
    const second = session('run-b', 'book-a', 'completed');
    const resumed = deferred<{ readonly session: AgentSessionDetail }>();
    stubBridge({
      agent: {
        resumeSession: () => resumed.promise,
        claimSession: () => Promise.resolve(claimed),
        getSession: (id: string) => Promise.resolve(id === second.id ? second : { ...first, status: 'running' as const }),
      },
    });
    ready({ activeSession: first, sessions: [first, second] });

    const resuming = useAgentStore.getState().resume('continue');
    await useAgentStore.getState().selectSession(second.id);
    resumed.resolve({ session: { ...first, status: 'running' } });

    await expect(resuming).resolves.toBe(true);
    expect(useAgentStore.getState().activeSession?.id).toBe(second.id);
    expect(useAgentStore.getState().sessions.find((item) => item.id === first.id)?.status).toBe('running');
  });

  it.each(['applyChanges', 'discardSandbox'] as const)('does not let a late %s replace the session the reader opened', async (action) => {
    const first = { ...session('run-a', 'book-a', 'completed'), environment: { sessionId: 'run-a', ...review('run-a').review } };
    const second = session('run-b', 'book-a', 'completed');
    const pending = deferred<AgentEnvironmentReviewResult>();
    const discard = vi.fn(() => pending.promise.then(() => undefined));
    stubBridge({
      agent: {
        applyChanges: () => pending.promise,
        discardSandbox: discard,
        claimSession: () => Promise.resolve(claimed),
        getSession: (id: string) => Promise.resolve(id === second.id ? second : first),
      },
    });
    ready({ activeSession: first, sessions: [first, second] });

    const store = useAgentStore.getState();
    const acting = action === 'applyChanges' ? store.applyChanges() : store.discardSandbox(discardOriginOf(useAgentStore.getState())!);
    await useAgentStore.getState().selectSession(second.id);
    pending.resolve(review(first.id));
    await acting;

    expect(useAgentStore.getState().activeSession?.id).toBe(second.id);
    expect(discard).toHaveBeenCalledTimes(Number(action === 'discardSandbox'));
  });

  it('does not show a previous session\'s apply failure on the session opened meanwhile', async () => {
    const first = session('run-a', 'book-a', 'completed');
    const second = session('run-b', 'book-a', 'completed');
    const pending = deferred<AgentEnvironmentReviewResult>();
    stubBridge({
      agent: {
        applyChanges: () => pending.promise,
        claimSession: () => Promise.resolve(claimed),
        getSession: () => Promise.resolve(second),
      },
    });
    ready({ activeSession: first, sessions: [first, second] });

    const acting = useAgentStore.getState().applyChanges();
    await useAgentStore.getState().selectSession(second.id);
    pending.reject(new Error('Apply failed for run A.'));
    await acting;

    expect(useAgentStore.getState().error).toBeNull();
  });

  it('reports a successful patch export as a result, not as an error', async () => {
    const first = session('run-a', 'book-a', 'completed');
    stubBridge({ agent: { exportPatch: () => Promise.resolve({ outcome: 'exported' as const, artifactId: 'artifact', fileName: 'run-a.patch', bytes: 42 }) } });
    ready({ activeSession: first });

    await expect(useAgentStore.getState().exportPatch()).resolves.toBe('Patch exported: run-a.patch (42 bytes).');
    expect(useAgentStore.getState().error).toBeNull();
  });
});

describe('Agent start launches exactly what the reader chose', () => {
  it('launches the model selected when Start was pressed, even if it changes while settings flush', async () => {
    const choosable: AgentProfile = {
      ...profile,
      capabilities: { ...profile.capabilities, modelSelection: true },
      availableModels: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    };
    const started = session('run-a', 'book-a', 'running');
    const startSession = vi.fn(() => Promise.resolve({ session: started }));
    stubBridge({ agent: { startSession, getSession: () => Promise.resolve(started) } });
    ready({ profiles: [choosable], selectedModel: 'model-a' });

    const starting = useAgentStore.getState().start(choosable.id, 'auto-isolated', 'Do the task');
    useAgentStore.setState({ selectedModel: 'model-b' });
    await starting;

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-a' }));
    // The newer choice is the reader's, and is not overwritten by the launch.
    expect(useAgentStore.getState().selectedModel).toBe('model-b');
  });

  it('does not launch for the previous book while the newly opened one is still loading', async () => {
    const startSession = vi.fn(() => Promise.resolve({ session: session('run-a', 'book-a', 'running') }));
    stubBridge({ agent: { startSession } });
    ready();
    useReaderStore.setState({ session: testReaderSession(book('book-b')) });

    await expect(useAgentStore.getState().start(profile.id, 'auto-isolated', 'New book task')).resolves.toBe(false);

    expect(startSession).not.toHaveBeenCalled();
    expect(useAgentStore.getState().error).toMatch(/still loading/iu);
  });

  it('does not launch without the context still being attached', async () => {
    const startSession = vi.fn(() => Promise.resolve({ session: session('run-a', 'book-a', 'running') }));
    stubBridge({ agent: { startSession } });
    ready({ pendingContext: { revision: 1, label: 'Entire document' } });

    await expect(useAgentStore.getState().start(profile.id, 'auto-isolated', 'Do the task')).resolves.toBe(false);

    expect(startSession).not.toHaveBeenCalled();
    expect(useAgentStore.getState().error).toMatch(/Entire document is still being attached/u);
  });

  it('does not report a late start failure on another session opened in the same book', async () => {
    const start = deferred<{ readonly session: AgentSessionDetail }>();
    const other = session('run-other', 'book-a', 'completed');
    stubBridge({
      agent: {
        startSession: () => start.promise,
        getSession: () => Promise.resolve(other),
        claimSession: () => Promise.resolve(claimed),
        listProfiles: () => Promise.resolve([profile]),
        getModeAvailability: () => Promise.resolve([]),
      },
    });
    ready({ sessions: [other] });

    const starting = useAgentStore.getState().start(profile.id, 'auto-isolated', 'Do the task');
    await useAgentStore.getState().selectSession(other.id);
    start.reject(new Error('Old launch failed.'));
    await starting;

    expect(useAgentStore.getState().activeSession?.id).toBe(other.id);
    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().loading).toBe(false);
  });
});

describe('Agent action results stay with the run that asked for them', () => {
  it('does not let an action\'s late detail replace the same session after it resumed', async () => {
    const first = session('run-a', 'book-a', 'completed');
    const held = deferred<AgentSessionDetail | null>();
    let reads = 0;
    stubBridge({
      agent: {
        applyChanges: () => Promise.resolve(review(first.id)),
        getSession: () => ++reads === 1 ? held.promise : Promise.resolve({ ...first, status: 'running' as const }),
        resumeSession: () => Promise.resolve({ session: { ...first, status: 'running' as const } }),
      },
    });
    ready({ activeSession: first, sessions: [first] });

    const acting = useAgentStore.getState().applyChanges();
    await Promise.resolve();
    await Promise.resolve();
    await useAgentStore.getState().resume('continue');
    held.resolve(first);
    await acting;

    expect(useAgentStore.getState().activeSession?.status).toBe('running');
    expect(useAgentStore.getState().sessions.find((item) => item.id === first.id)?.status).toBe('running');
  });

  it('does not show an earlier run\'s action failure on the same session once resumed', async () => {
    const first = session('run-a', 'book-a', 'completed');
    const pending = deferred<AgentEnvironmentReviewResult>();
    stubBridge({
      agent: {
        applyChanges: () => pending.promise,
        getSession: () => Promise.resolve({ ...first, status: 'running' as const }),
        resumeSession: () => Promise.resolve({ session: { ...first, status: 'running' as const } }),
      },
    });
    ready({ activeSession: first, sessions: [first] });

    const acting = useAgentStore.getState().applyChanges();
    await useAgentStore.getState().resume('continue');
    pending.reject(new Error('Apply failed for the earlier run.'));
    await acting;

    expect(useAgentStore.getState().error).toBeNull();
  });

  it('does not let a Stop\'s late detail replace the same session after it resumed', async () => {
    const first = session('run-a', 'book-a', 'running');
    const held = deferred<AgentSessionDetail | null>();
    let reads = 0;
    stubBridge({
      agent: {
        stopSession: () => Promise.resolve(),
        getSession: () => ++reads === 1 ? held.promise : Promise.resolve({ ...first, status: 'running' as const }),
        resumeSession: () => Promise.resolve({ session: { ...first, status: 'running' as const } }),
      },
    });
    ready({ activeSession: first, sessions: [first] });

    const stopping = useAgentStore.getState().stop();
    await Promise.resolve();
    await Promise.resolve();
    // The live event stream can finish the cancellation before the old detail reply lands.
    useAgentStore.setState({ activeSession: { ...first, status: 'cancelled' }, stopping: false });
    await useAgentStore.getState().resume('continue');
    held.resolve({ ...first, status: 'cancelled' });
    await stopping;

    expect(useAgentStore.getState().activeSession?.status).toBe('running');
    expect(useAgentStore.getState().sessions.find((item) => item.id === first.id)?.status).toBe('running');
    expect(useAgentStore.getState().stopping).toBe(false);
  });

  it('keeps a resumed run\'s own pending Stop when the earlier run\'s Stop fails late', async () => {
    const first = session('run-a', 'book-a', 'running');
    const earlier = deferred<undefined>();
    const later = deferred<undefined>();
    let stops = 0;
    stubBridge({
      agent: {
        stopSession: () => ++stops === 1 ? earlier.promise : later.promise,
        getSession: () => Promise.resolve({ ...first, status: 'running' as const }),
        resumeSession: () => Promise.resolve({ session: { ...first, status: 'running' as const } }),
      },
    });
    ready({ activeSession: first, sessions: [first] });

    const stoppingEarlier = useAgentStore.getState().stop();
    useAgentStore.setState({ activeSession: { ...first, status: 'cancelled' }, stopping: false });
    await useAgentStore.getState().resume('continue');
    const stoppingLater = useAgentStore.getState().stop();
    earlier.reject(new Error('Stop failed for the earlier run.'));
    await stoppingEarlier;

    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().stopping).toBe(true);
    later.resolve(undefined);
    await stoppingLater;
  });

  it('reports a cancelled patch save neutrally, not as an error', async () => {
    stubBridge({ agent: { exportPatch: () => Promise.resolve({ outcome: 'cancelled' as const }) } });
    ready({ activeSession: session('run-a', 'book-a', 'completed'), error: null });

    await expect(useAgentStore.getState().exportPatch()).resolves.toBe('Patch export cancelled. Nothing was saved.');
    expect(useAgentStore.getState().error).toBeNull();
  });
});

describe('Agent follow-ups are remembered per run', () => {
  it('records a follow-up however it was sent, keeping a next idea typed meanwhile', async () => {
    const first = session('run-a', 'book-a', 'completed');
    const resumed = deferred<{ readonly session: AgentSessionDetail }>();
    stubBridge({ agent: { resumeSession: () => resumed.promise, getSession: () => Promise.resolve({ ...first, status: 'running' as const }) } });
    ready({ activeSession: first, sessions: [first] });

    const resuming = useAgentStore.getState().resume('continue');
    setAgentFollowUpDraft(first.id, 'next idea');
    resumed.resolve({ session: { ...first, status: 'running' } });
    await resuming;

    recordAgentFollowUp('run-b', 'unrelated');
    const { result } = renderHook(() => useAgentFollowUp(first.id));
    expect(result.current).toEqual({ draft: 'next idea', resumedPrompts: ['continue'] });
  });
});
