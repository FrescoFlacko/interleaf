// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModeAvailability } from '@shared/types/agent-environment';
import type { AgentEnvironmentReviewResult } from '@shared/types/agent-environment';
import type { AgentEvent, AgentProfile, AgentSessionDetail, AgentWorkingDirectory } from '@shared/types/agent';
import type { DocumentAnchor } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { documentAnchorSchema } from '@shared/schemas/annotation';
import { AGENT_MAX_CONTEXT_PACKET_BYTES, AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

function profile(id: string): AgentProfile {
  return {
    id, providerId: 'fake', name: `Fake ${id}`, defaultModel: null, availableModels: [], reasoningEffort: null,
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true,
      modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', version: 'test', checkedAt: new Date().toISOString(), errorMessage: null },
    isCustom: false, unsafe: false,
  };
}

function availability(reason: string): readonly AgentModeAvailability[] {
  return [{ mode: 'auto-isolated', available: true, reason, containerRuntime: null }];
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function settingsWithDefaults(defaultWorkingDirectoryByProfile: Readonly<Record<string, string>>): AppSettings {
  return {
    ...structuredClone(DEFAULT_APP_SETTINGS),
    agent: {
      ...structuredClone(DEFAULT_APP_SETTINGS.agent),
      defaultWorkingDirectoryByProfile,
    },
  };
}

// The store subscribes to agent events once for its lifetime, so every test
// registers the same recorder and replays events through the one listener.
let agentEventListener: ((event: AgentEvent) => void) | undefined;
function onAgentEvent(listener: (event: AgentEvent) => void): () => void {
  agentEventListener = listener;
  return () => undefined;
}
function emitAgentEvent(event: AgentEvent): void {
  agentEventListener?.(event);
}

function session(id: string, status: AgentSessionDetail['status']): AgentSessionDetail {
  return {
    id,
    documentId: 'test-document',
    profileId: 'profile-a',
    providerId: 'fake',
    targetDirectory: { handle: `handle-${id}`, displayName: `workspace-${id}` },
    executionMode: 'isolated-copy',
    status,
    providerSessionId: null,
    userPrompt: 'test prompt',
    contextSummary: null,
    finalReport: null,
    effectiveModel: null,
    effectiveReasoningEffort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    eventCount: 0,
    environment: null,
    events: [],
    artifacts: [],
  };
}

function doc(id: string, format: DocumentMetadata['format'], pageCount: number | null = null): DocumentMetadata {
  return {
    id, title: id, author: null, format, storageMode: 'managed', fileSize: 10, fileMtimeMs: 1, fileHash: `${id}-hash`,
    pageCount, folderId: null, storageHealth: 'ok',
    readingPosition: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    source: null,
  };
}


function review(sessionId: string): AgentEnvironmentReviewResult {
  return {
    sessionId,
    review: {
      mode: 'isolated-copy',
      riskLevel: 'low',
      workspaceLabel: 'Interleaf isolated workspace',
      primaryWasDirty: false,
      applyAllowed: true,
      applyDisabledReason: null,
      activeWorkspaceModified: false,
      changedFiles: [{ path: 'changed.txt', kind: 'modified', additions: 2, deletions: 1, bytes: 24 }],
      tests: [{ status: 'passed', summary: 'fixture tests passed', exitCode: 0, durationMs: 12 }],
      diffAvailable: true,
      diff: 'diff --git a/changed.txt b/changed.txt',
      patchAvailable: true,
      containerRuntime: null,
      applied: false,
    },
  };
}

describe('agent renderer store profile availability', () => {
  afterEach(() => {
    vi.useRealTimers();
    useReaderStore.setState({ session: null });
    useAgentStore.setState({ profiles: [], modeAvailability: [], selectedProfileId: null, workingDirectory: null, workingDirectories: [], workingDirectorySource: 'none', workingDirectoryDefaults: {}, hydrated: false, loading: false, stopping: false, error: null });
  });

  it('stores near-limit section text once with a compact location-only anchor', async () => {
    const document = doc('near-limit-document', 'markdown');
    useReaderStore.setState({ session: testReaderSession(document) });
    const exactQuote = 'A'.repeat(AGENT_MAX_CONTEXT_TEXT_LENGTH);
    await expect(useAgentStore.getState().attachSectionContext(
      document,
      { format: 'markdown', blockIndex: 4, lineIndex: 20, headingId: 'near-limit' },
      'Blocks 5–9',
      exactQuote,
    )).resolves.toBe(true);

    const packet = useAgentStore.getState().contextPacket;
    expect(packet?.selection.exactQuote).toMatch(/^A+$/u);
    expect(packet?.selection.exactQuote.length).toBeLessThan(exactQuote.length);
    expect(packet?.selection.anchor.quote.exact).toBe('');
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
  });

  it('applies the same packet budget to near-limit PDF page-range context', async () => {
    const document = doc('near-limit-pdf', 'pdf', 10);
    useReaderStore.setState({ session: testReaderSession(document) });
    const exactQuote = 'B'.repeat(AGENT_MAX_CONTEXT_TEXT_LENGTH);
    await expect(useAgentStore.getState().attachPageRange(document, 2, 4, exactQuote)).resolves.toBe(true);
    const packet = useAgentStore.getState().contextPacket;
    expect(packet?.selection.exactQuote).toMatch(/^B+$/u);
    expect(packet?.selection.exactQuote.length).toBeLessThan(exactQuote.length);
    expect(packet?.selection.anchor.quote.exact).toBe('');
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
  });

  it('fits a near-limit direct selection while retaining provenance and a safe location anchor', () => {
    const document = doc('direct-near-limit', 'markdown');
    const exactQuote = 'C'.repeat(250_000);
    const anchor: DocumentAnchor = {
      format: 'markdown',
      quote: { exact: exactQuote, prefix: 'before '.repeat(300), suffix: ' after'.repeat(300) },
      blockIndex: 12,
      lineIndex: 90,
      headingId: 'direct-near-limit',
    };

    useAgentStore.getState().setSelection(document, anchor, exactQuote);

    const packet = useAgentStore.getState().contextPacket;
    expect(packet).not.toBeNull();
    expect(packet?.selection.exactQuote.length).toBe(exactQuote.length);
    expect(packet?.provenance).toMatchObject({ truncated: false });
    expect(packet?.selection.anchor).toEqual({
      format: 'markdown',
      quote: { exact: '', prefix: '', suffix: '' },
      blockIndex: 12,
      lineIndex: 90,
      headingId: 'direct-near-limit',
    });
    expect(packet?.selection.surroundingText).toContain('before');
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
    expect(documentAnchorSchema.safeParse(packet?.selection.anchor).success).toBe(true);
  });

  it('fits near-limit composite selections without serializing duplicate segment quotes', () => {
    const document = doc('composite-near-limit', 'markdown');
    const first = 'D'.repeat(127_999);
    const second = 'E'.repeat(127_999);
    const exactQuote = `${first}\n\n${second}`;
    const anchor: DocumentAnchor = {
      format: 'markdown',
      quote: { exact: exactQuote, prefix: 'prefix', suffix: 'suffix' },
      blockIndex: 4,
      segments: [
        { blockIndex: 4, quote: { exact: first, prefix: 'prefix', suffix: '' }, characterStart: 0, characterEnd: first.length },
        { blockIndex: 8, quote: { exact: second, prefix: '', suffix: 'suffix' }, characterStart: first.length + 2, characterEnd: exactQuote.length, separatorBefore: '\n\n' },
      ],
    };

    useAgentStore.getState().setSelection(document, anchor, exactQuote);

    const packet = useAgentStore.getState().contextPacket;
    expect(packet).not.toBeNull();
    expect(packet?.selection.exactQuote.length).toBeGreaterThan(254_000);
    expect(packet?.provenance).toMatchObject({ truncated: true });
    expect(packet?.selection.anchor).toEqual({
      format: 'markdown',
      quote: { exact: '', prefix: '', suffix: '' },
      blockIndex: 4,
    });
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(AGENT_MAX_CONTEXT_PACKET_BYTES);
    expect(documentAnchorSchema.safeParse(packet?.selection.anchor).success).toBe(true);
  });

  it('fails closed with a typed user-safe error when selection anchor and location formats differ', () => {
    const document = doc('mismatched-selection', 'pdf', 2);
    useAgentStore.getState().setSelection(
      document,
      { format: 'pdf', pageIndex: 1, quote: { exact: 'Selected passage', prefix: '', suffix: '' } },
      'Selected passage',
      { format: 'markdown', blockIndex: 1 },
    );

    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toBe('Agent context anchor and location formats must match.');
  });

  it('reports and clears a safe error when entire-document context receives a mixed-format location', async () => {
    const document = doc('mismatched-entire-document', 'markdown');
    useReaderStore.setState({ session: testReaderSession(document) });
    useAgentStore.setState({ contextPacket: null, error: null });

    await expect(useAgentStore.getState().attachEntireDocument(
      document,
      { format: 'pdf', pageIndex: 1 },
      'Document context',
    )).resolves.toBe(false);

    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toBe('Agent context anchor and location formats must match.');
  });

  it('does not split a surrogate pair while bounding direct-selection surrounding text', () => {
    const document = doc('surrounding-boundary', 'markdown');
    const anchor = (prefix: string): DocumentAnchor => ({
      format: 'markdown', blockIndex: 1,
      quote: { exact: 'Selected passage', prefix, suffix: '' },
    });
    const prefixBeforeBoundary = `${'A'.repeat(19_999)}😀`;
    const prefixAtBoundary = `${'A'.repeat(19_998)}😀`;

    useAgentStore.getState().setSelection(document, anchor(prefixBeforeBoundary), 'Selected passage');
    expect(useAgentStore.getState().contextPacket?.selection.surroundingText).toBe('A'.repeat(19_999));
    expect(useAgentStore.getState().contextPacket?.selection.surroundingText).not.toContain('\uFFFD');

    useAgentStore.getState().setSelection(document, anchor(prefixAtBoundary), 'Selected passage');
    expect(useAgentStore.getState().contextPacket?.selection.surroundingText).toBe(prefixAtBoundary);
    expect(useAgentStore.getState().contextPacket?.selection.surroundingText?.endsWith('😀')).toBe(true);
  });

  it('hydrates authoritative directories and applies the initial built-in default', async () => {
    const workspace: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const currentProfile = profile('profile-a');
    const settings = settingsWithDefaults({ [currentProfile.id]: workspace.handle });
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => Promise.resolve([currentProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([workspace]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    await useAgentStore.getState().hydrate();
    expect(useAgentStore.getState().workingDirectories).toEqual([workspace]);
    expect(useAgentStore.getState().workingDirectory).toEqual(workspace);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('applies custom defaults on profile switch and reapplies them when switching back', async () => {
    const first = profile('profile-a');
    const custom = profile('custom:550e8400-e29b-41d4-a716-446655440000');
    const firstDirectory: AgentWorkingDirectory = { handle: 'workspace-a', displayName: 'Workspace A' };
    const customDirectory: AgentWorkingDirectory = { handle: 'workspace-custom', displayName: 'Custom workspace' };
    const settings = settingsWithDefaults({ [first.id]: firstDirectory.handle, [custom.id]: customDirectory.handle });
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => Promise.resolve([first, custom]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([firstDirectory, customDirectory]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    await useAgentStore.getState().hydrate();
    useAgentStore.getState().setSelectedProfile(custom.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(customDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    useAgentStore.getState().setSelectedProfile(first.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(firstDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('retains newer profiles, selection, default, source, and mode when an older hydrate settles after a newer refresh added and selected a custom profile', async () => {
    const defaultProfile = profile('profile-a');
    const customProfile = profile('custom:550e8400-e29b-41d4-a716-446655440000');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const customDirectory: AgentWorkingDirectory = { handle: 'workspace-custom', displayName: 'Custom workspace' };

    const listProfilesHydrate = deferred<readonly AgentProfile[]>();
    const listProfilesRefresh = deferred<readonly AgentProfile[]>();
    const listSessions = deferred<readonly AgentSessionDetail[]>();
    const listDirectories = deferred<readonly AgentWorkingDirectory[]>();

    const settings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: {
        ...structuredClone(DEFAULT_APP_SETTINGS.agent),
        defaultWorkingDirectoryByProfile: {
          [defaultProfile.id]: defaultDirectory.handle,
          [customProfile.id]: customDirectory.handle,
        },
      },
    };

    let listProfilesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => {
          listProfilesCallCount += 1;
          return listProfilesCallCount === 1 ? listProfilesHydrate.promise : listProfilesRefresh.promise;
        },
        listSessions: () => listSessions.promise,
        listWorkingDirectories: () => listDirectories.promise,
        getModeAvailability: (profileId?: string | null) => {
          if (profileId === customProfile.id) return Promise.resolve(availability('custom-mode-ready'));
          return Promise.resolve(availability('default-mode-ready'));
        },
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [defaultProfile],
      selectedProfileId: defaultProfile.id,
      workingDirectories: [defaultDirectory, customDirectory],
      workingDirectory: defaultDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: {
        [defaultProfile.id]: defaultDirectory.handle,
        [customProfile.id]: customDirectory.handle,
      },
    });

    // Step 1: Hydrate starts with old list
    const hydration = useAgentStore.getState().hydrate();

    // Step 2: Refresh starts and completes with new custom profile
    const refresh = useAgentStore.getState().refreshProfiles();
    listProfilesRefresh.resolve([defaultProfile, customProfile]);
    await refresh;

    expect(useAgentStore.getState().profiles).toEqual([defaultProfile, customProfile]);

    // Step 3: User selects custom profile
    useAgentStore.getState().setSelectedProfile(customProfile.id);
    await Promise.resolve();
    expect(useAgentStore.getState().selectedProfileId).toBe(customProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(customDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');

    // Step 4: Old hydrate settles with old list [defaultProfile]
    listProfilesHydrate.resolve([defaultProfile]);
    listSessions.resolve([]);
    listDirectories.resolve([defaultDirectory, customDirectory]);
    await hydration;

    // Must retain new profiles list, custom selectedProfileId, directory default, source, and mode availability!
    expect(useAgentStore.getState().profiles).toEqual([defaultProfile, customProfile]);
    expect(useAgentStore.getState().selectedProfileId).toBe(customProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(customDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().modeAvailability).toEqual(availability('custom-mode-ready'));
    expect(useAgentStore.getState().hydrated).toBe(true);
  });

  it('does not let an older refreshProfiles response overwrite a newer hydrate profile list', async () => {
    const initialProfile = profile('profile-a');
    const updatedProfile = profile('profile-updated');
    const staleProfile = profile('profile-stale');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };

    const listProfilesRefresh = deferred<readonly AgentProfile[]>();
    const listProfilesHydrate = deferred<readonly AgentProfile[]>();

    let listProfilesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(DEFAULT_APP_SETTINGS) },
      agent: {
        listProfiles: () => {
          listProfilesCallCount += 1;
          return listProfilesCallCount === 1 ? listProfilesRefresh.promise : listProfilesHydrate.promise;
        },
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([defaultDirectory]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [initialProfile],
      selectedProfileId: initialProfile.id,
      workingDirectories: [defaultDirectory],
      workingDirectory: defaultDirectory,
      workingDirectorySource: 'profile-default',
    });

    // Step 1: Older refresh starts
    const refresh = useAgentStore.getState().refreshProfiles();

    // Step 2: Newer hydrate starts and completes with updated profile list
    const hydration = useAgentStore.getState().hydrate();
    listProfilesHydrate.resolve([initialProfile, updatedProfile]);
    await hydration;

    expect(useAgentStore.getState().profiles).toEqual([initialProfile, updatedProfile]);

    // Step 3: Older refresh finishes later with stale list
    listProfilesRefresh.resolve([initialProfile, staleProfile]);
    await refresh;

    // Must NOT overwrite newer hydrate profile list
    expect(useAgentStore.getState().profiles).toEqual([initialProfile, updatedProfile]);
  });

  it('does not overwrite newer profile selection when hydrate was awaiting getModeAvailability while refreshProfiles loaded and selected a custom profile', async () => {
    const defaultProfile = profile('profile-a');
    const customProfile = profile('custom:550e8400-e29b-41d4-a716-446655440000');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const customDirectory: AgentWorkingDirectory = { handle: 'workspace-custom', displayName: 'Custom workspace' };

    const listProfilesRefresh = deferred<readonly AgentProfile[]>();
    const modeAvailabilityHydrate = deferred<readonly AgentModeAvailability[]>();

    const settings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: {
        ...structuredClone(DEFAULT_APP_SETTINGS.agent),
        defaultWorkingDirectoryByProfile: {
          [defaultProfile.id]: defaultDirectory.handle,
          [customProfile.id]: customDirectory.handle,
        },
      },
    };

    let listProfilesCallCount = 0;
    let modeAvailabilityCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => {
          listProfilesCallCount += 1;
          // 1st call: hydrate gets old profile list immediately
          if (listProfilesCallCount === 1) return Promise.resolve([defaultProfile]);
          // 2nd call: refreshProfiles gets deferred list
          return listProfilesRefresh.promise;
        },
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([defaultDirectory, customDirectory]),
        getModeAvailability: (profileId?: string | null) => {
          modeAvailabilityCallCount += 1;
          if (modeAvailabilityCallCount === 1) return modeAvailabilityHydrate.promise;
          if (profileId === customProfile.id) return Promise.resolve(availability('custom-mode-ready'));
          return Promise.resolve(availability('default-mode-ready'));
        },
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [defaultProfile],
      selectedProfileId: defaultProfile.id,
      workingDirectories: [defaultDirectory, customDirectory],
      workingDirectory: defaultDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: {
        [defaultProfile.id]: defaultDirectory.handle,
        [customProfile.id]: customDirectory.handle,
      },
    });

    // Step 1: Hydrate starts. Promise.all resolves immediately with [defaultProfile], then enters deferred getModeAvailability
    const hydration = useAgentStore.getState().hydrate();
    await Promise.resolve();
    await Promise.resolve();

    // Step 2: While hydrate is awaiting getModeAvailability, refreshProfiles starts, completes, and user selects custom profile
    const refresh = useAgentStore.getState().refreshProfiles();
    listProfilesRefresh.resolve([defaultProfile, customProfile]);
    await refresh;

    expect(useAgentStore.getState().profiles).toEqual([defaultProfile, customProfile]);

    useAgentStore.getState().setSelectedProfile(customProfile.id);
    await Promise.resolve();
    expect(useAgentStore.getState().selectedProfileId).toBe(customProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(customDirectory);

    // Step 3: Old hydrate's getModeAvailability resolves
    modeAvailabilityHydrate.resolve(availability('stale-default-mode'));
    await hydration;

    // Must NOT overwrite the custom profile, selection, or custom mode availability!
    expect(useAgentStore.getState().profiles).toEqual([defaultProfile, customProfile]);
    expect(useAgentStore.getState().selectedProfileId).toBe(customProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(customDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().modeAvailability).toEqual(availability('custom-mode-ready'));
  });

  it('does not surface an error when an older refreshProfiles fails after a newer hydrate has started', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };

    const failingRefresh = deferred<readonly AgentProfile[]>();

    let listProfilesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(DEFAULT_APP_SETTINGS) },
      agent: {
        listProfiles: () => {
          listProfilesCallCount += 1;
          // 1st call: older refresh
          if (listProfilesCallCount === 1) return failingRefresh.promise;
          // 2nd call: newer hydrate
          return Promise.resolve([currentProfile]);
        },
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([defaultDirectory]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      error: null,
    });

    // Step 1: Older refresh starts
    const refresh = useAgentStore.getState().refreshProfiles();

    // Step 2: Newer hydrate starts and succeeds
    await useAgentStore.getState().hydrate();
    expect(useAgentStore.getState().error).toBeNull();

    // Step 3: Older refresh fails later
    failingRefresh.reject(new Error('Older network failure'));
    await refresh;

    // Must NOT surface error from older stale refresh
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('clears a stale session override when hydrate list omits it, even if a newer refreshProfiles for the same unchanged list made hydrate stale for profile data', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const staleOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-stale', displayName: 'Stale workspace' };

    const listProfilesHydrate = deferred<readonly AgentProfile[]>();
    const listProfilesRefresh = deferred<readonly AgentProfile[]>();
    const listSessions = deferred<readonly AgentSessionDetail[]>();
    const listDirectories = deferred<readonly AgentWorkingDirectory[]>();

    const settings = settingsWithDefaults({ [currentProfile.id]: defaultDirectory.handle });

    let listProfilesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => {
          listProfilesCallCount += 1;
          return listProfilesCallCount === 1 ? listProfilesHydrate.promise : listProfilesRefresh.promise;
        },
        listSessions: () => listSessions.promise,
        listWorkingDirectories: () => listDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [staleOverrideDirectory],
      workingDirectory: staleOverrideDirectory,
      workingDirectorySource: 'session-override',
      documentId: 'test-document',
      workingDirectoryDefaults: { [currentProfile.id]: defaultDirectory.handle },
    });

    // Step 1: Hydrate starts with stale override in store
    const hydration = useAgentStore.getState().hydrate();

    // Step 2: A newer refreshProfiles starts and completes for the SAME unchanged profile list [currentProfile]
    const refresh = useAgentStore.getState().refreshProfiles();
    listProfilesRefresh.resolve([currentProfile]);
    await refresh;

    expect(useAgentStore.getState().profiles).toEqual([currentProfile]);
    // Stale override is still in store before hydrate finishes
    expect(useAgentStore.getState().workingDirectory).toEqual(staleOverrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');

    // Step 3: Hydrate finishes with authoritative directory list [defaultDirectory] omitting staleOverrideDirectory
    listProfilesHydrate.resolve([currentProfile]);
    listSessions.resolve([]);
    listDirectories.resolve([defaultDirectory]);
    await hydration;

    // Must clear stale override and apply authoritative default, NOT preserve just because refresh ran!
    expect(useAgentStore.getState().workingDirectory).toEqual(defaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectories).toEqual([defaultDirectory]);
  });

  it('uses a native choose result as a per-session override and ignores it after a profile switch race', async () => {
    const first = profile('profile-a');
    const second = profile('profile-b');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const overrideDirectory: AgentWorkingDirectory = { handle: 'workspace-override', displayName: 'Override workspace' };
    const choose = deferred<AgentWorkingDirectory | null>();
    const settings = settingsWithDefaults({ [second.id]: defaultDirectory.handle });
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => Promise.resolve([first, second]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([defaultDirectory]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        selectWorkingDirectory: () => choose.promise,
        onEvent: onAgentEvent,
      },
    });
    await useAgentStore.getState().hydrate();
    const pendingChoose = useAgentStore.getState().selectWorkingDirectory();
    useAgentStore.getState().setSelectedProfile(second.id);
    choose.resolve(overrideDirectory);
    await pendingChoose;
    expect(useAgentStore.getState().workingDirectory).toEqual(defaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');

    const immediateChoose = vi.fn(() => Promise.resolve(overrideDirectory));
    stubBridge({ settings: { get: () => Promise.resolve(settings) }, agent: { listProfiles: () => Promise.resolve([first, second]), listSessions: () => Promise.resolve([]), listWorkingDirectories: () => Promise.resolve([defaultDirectory]), getModeAvailability: () => Promise.resolve(availability('ready')), selectWorkingDirectory: immediateChoose, onEvent: onAgentEvent } });
    await useAgentStore.getState().selectWorkingDirectory();
    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
  });

  it('preserves a completed native picker override during hydration even if omitted by older list snapshot', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const overrideDirectory: AgentWorkingDirectory = { handle: 'workspace-override', displayName: 'Override workspace' };
    const listProfiles = deferred<readonly AgentProfile[]>();
    const listSessions = deferred<readonly AgentSessionDetail[]>();
    const listDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const settings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: { ...structuredClone(DEFAULT_APP_SETTINGS.agent), defaultWorkingDirectoryByProfile: { [currentProfile.id]: defaultDirectory.handle } },
    };
    const choose = vi.fn(() => Promise.resolve(overrideDirectory));
    stubBridge({ settings: { get: () => Promise.resolve(settings) }, agent: { listProfiles: () => listProfiles.promise, listSessions: () => listSessions.promise, listWorkingDirectories: () => listDirectories.promise, getModeAvailability: () => Promise.resolve(availability('ready')), selectWorkingDirectory: choose, onEvent: onAgentEvent } });
    const hydration = useAgentStore.getState().hydrate();
    // A user action wins even though the initial runtime hydration is still pending.
    useAgentStore.setState({ profiles: [currentProfile], selectedProfileId: currentProfile.id, workingDirectories: [overrideDirectory], workingDirectory: overrideDirectory, workingDirectorySource: 'session-override' });
    await useAgentStore.getState().selectWorkingDirectory();
    listProfiles.resolve([currentProfile]);
    listSessions.resolve([]);
    listDirectories.resolve([]);
    await hydration;
    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
  });

  it('clears a stale override when a picker request is pending during hydration and resolves snapshot default until picker completes', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const staleOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-stale', displayName: 'Stale workspace' };
    const newPickerDirectory: AgentWorkingDirectory = { handle: 'workspace-new-picker', displayName: 'New picker workspace' };
    const listProfiles = deferred<readonly AgentProfile[]>();
    const listSessions = deferred<readonly AgentSessionDetail[]>();
    const listDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingPicker = deferred<AgentWorkingDirectory | null>();

    const settings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: { ...structuredClone(DEFAULT_APP_SETTINGS.agent), defaultWorkingDirectoryByProfile: { [currentProfile.id]: defaultDirectory.handle } },
    };
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => listProfiles.promise,
        listSessions: () => listSessions.promise,
        listWorkingDirectories: () => listDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
        selectWorkingDirectory: () => pendingPicker.promise,
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [staleOverrideDirectory],
      workingDirectory: staleOverrideDirectory,
      workingDirectorySource: 'session-override',
    });

    const hydration = useAgentStore.getState().hydrate();
    const picker = useAgentStore.getState().selectWorkingDirectory();

    // Hydration finishes while picker is still pending
    listProfiles.resolve([currentProfile]);
    listSessions.resolve([]);
    listDirectories.resolve([defaultDirectory]);
    await hydration;

    // Stale override must NOT be preserved by a pending picker; snapshot default applies
    expect(useAgentStore.getState().workingDirectory).toEqual(defaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');

    // Later picker resolves and applies override
    pendingPicker.resolve(newPickerDirectory);
    await picker;

    expect(useAgentStore.getState().workingDirectory).toEqual(newPickerDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
  });

  it('clears a stale override when a picker request is cancelled during hydration and omitted by authoritative list', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const staleOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-stale', displayName: 'Stale workspace' };
    const listProfiles = deferred<readonly AgentProfile[]>();
    const listSessions = deferred<readonly AgentSessionDetail[]>();
    const listDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingPicker = deferred<AgentWorkingDirectory | null>();

    const settings = {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      agent: { ...structuredClone(DEFAULT_APP_SETTINGS.agent), defaultWorkingDirectoryByProfile: { [currentProfile.id]: defaultDirectory.handle } },
    };
    stubBridge({
      settings: { get: () => Promise.resolve(settings) },
      agent: {
        listProfiles: () => listProfiles.promise,
        listSessions: () => listSessions.promise,
        listWorkingDirectories: () => listDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
        selectWorkingDirectory: () => pendingPicker.promise,
        onEvent: onAgentEvent,
      },
    });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [staleOverrideDirectory],
      workingDirectory: staleOverrideDirectory,
      workingDirectorySource: 'session-override',
    });

    const hydration = useAgentStore.getState().hydrate();
    const picker = useAgentStore.getState().selectWorkingDirectory();

    // Picker cancelled
    pendingPicker.resolve(null);
    await picker;

    listProfiles.resolve([currentProfile]);
    listSessions.resolve([]);
    listDirectories.resolve([defaultDirectory]);
    await hydration;

    // No stale override survives
    expect(useAgentStore.getState().workingDirectory).toEqual(defaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectories).toEqual([defaultDirectory]);
  });

  it('synchronizes changed, removed, and stale defaults while the composer stays mounted', async () => {
    const currentProfile = profile('profile-a');
    const oldDirectory: AgentWorkingDirectory = { handle: 'workspace-old', displayName: 'Old workspace' };
    const newDirectory: AgentWorkingDirectory = { handle: 'workspace-new', displayName: 'New workspace' };
    const listWorkingDirectories = vi.fn(() => Promise.resolve([newDirectory]));
    stubBridge({ agent: { listWorkingDirectories } });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [oldDirectory],
      workingDirectory: oldDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [currentProfile.id]: oldDirectory.handle },
    });

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: newDirectory.handle }));
    expect(listWorkingDirectories).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().workingDirectories).toEqual([newDirectory]);
    expect(useAgentStore.getState().workingDirectory).toEqual(newDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({}));
    expect(useAgentStore.getState().workingDirectory).toBeNull();
    expect(useAgentStore.getState().workingDirectorySource).toBe('none');

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: 'stale-handle' }));
    expect(useAgentStore.getState().workingDirectory).toBeNull();
    expect(useAgentStore.getState().workingDirectorySource).toBe('none');
  });

  it('preserves an authoritative per-session override during settings synchronization', async () => {
    const currentProfile = profile('profile-a');
    const overrideDirectory: AgentWorkingDirectory = { handle: 'workspace-override', displayName: 'Override workspace' };
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    stubBridge({ agent: { listWorkingDirectories: () => Promise.resolve([overrideDirectory, defaultDirectory]) } });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [overrideDirectory],
      workingDirectory: overrideDirectory,
      workingDirectorySource: 'session-override',
      workingDirectoryDefaults: {},
    });

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: defaultDirectory.handle }));
    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: defaultDirectory.handle });
  });

  it('applies only the latest concurrent native picker result', async () => {
    const currentProfile = profile('profile-a');
    const firstDirectory: AgentWorkingDirectory = { handle: 'workspace-first', displayName: 'First workspace' };
    const secondDirectory: AgentWorkingDirectory = { handle: 'workspace-second', displayName: 'Second workspace' };
    const first = deferred<AgentWorkingDirectory | null>();
    const second = deferred<AgentWorkingDirectory | null>();
    const selectWorkingDirectory = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    stubBridge({ agent: { selectWorkingDirectory } });
    useAgentStore.setState({ profiles: [currentProfile], selectedProfileId: currentProfile.id });

    const firstRequest = useAgentStore.getState().selectWorkingDirectory();
    const secondRequest = useAgentStore.getState().selectWorkingDirectory();
    second.resolve(secondDirectory);
    await secondRequest;
    first.resolve(firstDirectory);
    await firstRequest;

    expect(useAgentStore.getState().workingDirectory).toEqual(secondDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
  });

  it('converges to the new profile default when profile switches after sync starts', async () => {
    const firstProfile = profile('profile-a');
    const secondProfile = profile('profile-b');
    const defaultFirst: AgentWorkingDirectory = { handle: 'workspace-a', displayName: 'Workspace A' };
    const defaultSecond: AgentWorkingDirectory = { handle: 'workspace-b', displayName: 'Workspace B' };
    const pendingDirectories = deferred<readonly AgentWorkingDirectory[]>();
    stubBridge({
      agent: {
        listWorkingDirectories: () => pendingDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
      },
    });
    useAgentStore.setState({
      profiles: [firstProfile, secondProfile],
      selectedProfileId: firstProfile.id,
      workingDirectories: [defaultFirst],
      workingDirectory: defaultFirst,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [firstProfile.id]: defaultFirst.handle },
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({
      [firstProfile.id]: defaultFirst.handle,
      [secondProfile.id]: defaultSecond.handle,
    }));
    useAgentStore.getState().setSelectedProfile(secondProfile.id);
    expect(useAgentStore.getState().selectedProfileId).toBe(secondProfile.id);

    pendingDirectories.resolve([defaultFirst, defaultSecond]);
    await sync;

    expect(useAgentStore.getState().selectedProfileId).toBe(secondProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(defaultSecond);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({
      [firstProfile.id]: defaultFirst.handle,
      [secondProfile.id]: defaultSecond.handle,
    });
    expect(useAgentStore.getState().workingDirectories).toEqual([defaultFirst, defaultSecond]);
  });

  it('preserves an in-flight picker override while updating defaults during settings synchronization', async () => {
    const firstProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const overrideDirectory: AgentWorkingDirectory = { handle: 'workspace-override', displayName: 'Override workspace' };
    const pendingDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingPicker = deferred<AgentWorkingDirectory | null>();
    stubBridge({
      agent: {
        listWorkingDirectories: () => pendingDirectories.promise,
        selectWorkingDirectory: () => pendingPicker.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
      },
    });
    useAgentStore.setState({
      profiles: [firstProfile],
      selectedProfileId: firstProfile.id,
      workingDirectories: [defaultDirectory],
      workingDirectory: defaultDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: {},
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [firstProfile.id]: defaultDirectory.handle }));
    const picker = useAgentStore.getState().selectWorkingDirectory();
    pendingPicker.resolve(overrideDirectory);
    await picker;
    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');

    // List returns only defaultDirectory (predating picker registration)
    pendingDirectories.resolve([defaultDirectory]);
    await sync;

    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [firstProfile.id]: defaultDirectory.handle });
    expect(useAgentStore.getState().workingDirectories).toEqual(expect.arrayContaining([defaultDirectory, overrideDirectory]));
  });

  it('clears a pre-existing stale session override when omitted by authoritative sync list and resolves profile default', async () => {
    const currentProfile = profile('profile-a');
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const staleOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-stale-override', displayName: 'Stale override' };
    stubBridge({ agent: { listWorkingDirectories: () => Promise.resolve([defaultDirectory]) } });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [staleOverrideDirectory],
      workingDirectory: staleOverrideDirectory,
      workingDirectorySource: 'session-override',
      workingDirectoryDefaults: {},
    });

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: defaultDirectory.handle }));

    expect(useAgentStore.getState().workingDirectory).toEqual(defaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: defaultDirectory.handle });
    expect(useAgentStore.getState().workingDirectories).toEqual([defaultDirectory]);
  });

  it('preserves both override value and session-override source during concurrent hydrate until convergence', async () => {
    const currentProfile = profile('profile-a');
    const overrideDirectory: AgentWorkingDirectory = { handle: 'workspace-override', displayName: 'Override workspace' };
    const defaultDirectory: AgentWorkingDirectory = { handle: 'workspace-default', displayName: 'Default workspace' };
    const pendingSyncDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingHydrateDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const oldSettings = settingsWithDefaults({});
    const newSettings = settingsWithDefaults({ [currentProfile.id]: defaultDirectory.handle });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [overrideDirectory],
      workingDirectory: overrideDirectory,
      workingDirectorySource: 'session-override',
      workingDirectoryDefaults: {},
    });

    let listWorkingDirectoriesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(oldSettings) },
      agent: {
        listProfiles: () => Promise.resolve([currentProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => {
          listWorkingDirectoriesCallCount += 1;
          return listWorkingDirectoriesCallCount === 1 ? pendingSyncDirectories.promise : pendingHydrateDirectories.promise;
        },
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(newSettings);
    const hydration = useAgentStore.getState().hydrate();

    pendingHydrateDirectories.resolve([defaultDirectory]);
    await hydration;

    // During in-flight sync, hydrate must preserve both override value and session-override source
    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');

    // When sync completes with both directories, session override remains preserved
    pendingSyncDirectories.resolve([defaultDirectory, overrideDirectory]);
    await sync;

    expect(useAgentStore.getState().workingDirectory).toEqual(overrideDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('session-override');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: defaultDirectory.handle });
    expect(useAgentStore.getState().workingDirectories).toEqual([defaultDirectory, overrideDirectory]);
  });

  it('converges to validated sync when sync starts before hydrate with an older settings snapshot', async () => {
    const currentProfile = profile('profile-a');
    const oldDirectory: AgentWorkingDirectory = { handle: 'workspace-old', displayName: 'Old workspace' };
    const newDirectory: AgentWorkingDirectory = { handle: 'workspace-new', displayName: 'New workspace' };
    const pendingSyncDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingHydrateDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const oldSettings = settingsWithDefaults({ [currentProfile.id]: oldDirectory.handle });
    const newSettings = settingsWithDefaults({ [currentProfile.id]: newDirectory.handle });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [oldDirectory],
      workingDirectory: oldDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [currentProfile.id]: oldDirectory.handle },
    });

    let listWorkingDirectoriesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(oldSettings) },
      agent: {
        listProfiles: () => Promise.resolve([currentProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => {
          listWorkingDirectoriesCallCount += 1;
          return listWorkingDirectoriesCallCount === 1 ? pendingSyncDirectories.promise : pendingHydrateDirectories.promise;
        },
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });
    const sync = useAgentStore.getState().syncWorkingDirectorySettings(newSettings);
    const hydration = useAgentStore.getState().hydrate();

    pendingHydrateDirectories.resolve([oldDirectory]);
    await hydration;

    pendingSyncDirectories.resolve([newDirectory]);
    await sync;

    expect(useAgentStore.getState().workingDirectories).toEqual([newDirectory]);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: newDirectory.handle });
    expect(useAgentStore.getState().workingDirectory).toEqual(newDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('allows a later successful hydrate to apply settings and directories after a failed sync', async () => {
    const currentProfile = profile('profile-a');
    const oldDirectory: AgentWorkingDirectory = { handle: 'workspace-old', displayName: 'Old workspace' };
    const recoveredDirectory: AgentWorkingDirectory = { handle: 'workspace-recovered', displayName: 'Recovered workspace' };
    const recoveredSettings = settingsWithDefaults({ [currentProfile.id]: recoveredDirectory.handle });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [oldDirectory],
      workingDirectory: oldDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [currentProfile.id]: oldDirectory.handle },
      error: null,
    });

    // Step 1: Sync fails
    stubBridge({ agent: { listWorkingDirectories: () => Promise.reject(new Error('List failed')) } });
    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: 'stale' }));
    expect(useAgentStore.getState().error).toBe('List failed');
    expect(useAgentStore.getState().workingDirectories).toEqual([oldDirectory]);

    // Step 2: Hydrate runs later and must successfully apply recovered settings and directories
    stubBridge({
      settings: { get: () => Promise.resolve(recoveredSettings) },
      agent: {
        listProfiles: () => Promise.resolve([currentProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([recoveredDirectory]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });
    await useAgentStore.getState().hydrate();

    expect(useAgentStore.getState().workingDirectories).toEqual([recoveredDirectory]);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: recoveredDirectory.handle });
    expect(useAgentStore.getState().workingDirectory).toEqual(recoveredDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('preserves validated sync when sync finishes before concurrent hydrate with an older settings snapshot', async () => {
    const currentProfile = profile('profile-a');
    const oldDirectory: AgentWorkingDirectory = { handle: 'workspace-old', displayName: 'Old workspace' };
    const newDirectory: AgentWorkingDirectory = { handle: 'workspace-new', displayName: 'New workspace' };
    const pendingHydrateDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const oldSettings = settingsWithDefaults({ [currentProfile.id]: oldDirectory.handle });
    const newSettings = settingsWithDefaults({ [currentProfile.id]: newDirectory.handle });

    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [oldDirectory],
      workingDirectory: oldDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [currentProfile.id]: oldDirectory.handle },
    });

    let listWorkingDirectoriesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(oldSettings) },
      agent: {
        listProfiles: () => Promise.resolve([currentProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => {
          listWorkingDirectoriesCallCount += 1;
          return listWorkingDirectoriesCallCount === 1 ? Promise.resolve([newDirectory]) : pendingHydrateDirectories.promise;
        },
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });
    const sync = useAgentStore.getState().syncWorkingDirectorySettings(newSettings);
    const hydration = useAgentStore.getState().hydrate();

    await sync;
    pendingHydrateDirectories.resolve([oldDirectory]);
    await hydration;

    expect(useAgentStore.getState().workingDirectories).toEqual([newDirectory]);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: newDirectory.handle });
    expect(useAgentStore.getState().workingDirectory).toEqual(newDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('converges to validated settings sync when refreshProfiles runs concurrently', async () => {
    const currentProfile = profile('profile-a');
    const newDirectory: AgentWorkingDirectory = { handle: 'workspace-new', displayName: 'New workspace' };
    const pendingDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingProfiles = deferred<readonly AgentProfile[]>();
    stubBridge({
      agent: {
        listProfiles: () => pendingProfiles.promise,
        listWorkingDirectories: () => pendingDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
      },
    });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [],
      workingDirectory: null,
      workingDirectorySource: 'none',
      workingDirectoryDefaults: {},
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: newDirectory.handle }));
    const refresh = useAgentStore.getState().refreshProfiles();

    pendingProfiles.resolve([currentProfile]);
    await refresh;

    pendingDirectories.resolve([newDirectory]);
    await sync;

    expect(useAgentStore.getState().workingDirectories).toEqual([newDirectory]);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: newDirectory.handle });
    expect(useAgentStore.getState().workingDirectory).toEqual(newDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
  });

  it('ensures the latest of two concurrent settings syncs wins regardless of resolution order', async () => {
    const currentProfile = profile('profile-a');
    const firstDirectory: AgentWorkingDirectory = { handle: 'workspace-first', displayName: 'First workspace' };
    const secondDirectory: AgentWorkingDirectory = { handle: 'workspace-second', displayName: 'Second workspace' };
    const firstPending = deferred<readonly AgentWorkingDirectory[]>();
    const secondPending = deferred<readonly AgentWorkingDirectory[]>();

    let listCallCount = 0;
    stubBridge({
      agent: {
        listWorkingDirectories: () => {
          listCallCount += 1;
          return listCallCount === 1 ? firstPending.promise : secondPending.promise;
        },
        getModeAvailability: () => Promise.resolve(availability('ready')),
      },
    });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [],
      workingDirectory: null,
      workingDirectorySource: 'none',
      workingDirectoryDefaults: {},
    });

    const firstSync = useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: firstDirectory.handle }));
    const secondSync = useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: secondDirectory.handle }));

    // Second sync resolves first
    secondPending.resolve([secondDirectory]);
    await secondSync;
    expect(useAgentStore.getState().workingDirectory).toEqual(secondDirectory);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: secondDirectory.handle });

    // First sync resolves later, must not overwrite second sync
    firstPending.resolve([firstDirectory]);
    await firstSync;
    expect(useAgentStore.getState().workingDirectory).toEqual(secondDirectory);
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: secondDirectory.handle });
    expect(useAgentStore.getState().workingDirectories).toEqual([secondDirectory]);
  });

  it('preserves prior safe state on list failure and allows a later sync to recover', async () => {
    const currentProfile = profile('profile-a');
    const initialDirectory: AgentWorkingDirectory = { handle: 'workspace-initial', displayName: 'Initial workspace' };
    const recoveredDirectory: AgentWorkingDirectory = { handle: 'workspace-recovered', displayName: 'Recovered workspace' };
    const failingList = vi.fn(() => Promise.reject(new Error('IPC directory list failed')));
    stubBridge({ agent: { listWorkingDirectories: failingList } });
    useAgentStore.setState({
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectories: [initialDirectory],
      workingDirectory: initialDirectory,
      workingDirectorySource: 'profile-default',
      workingDirectoryDefaults: { [currentProfile.id]: initialDirectory.handle },
      error: null,
    });

    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: recoveredDirectory.handle }));
    expect(useAgentStore.getState().error).toBe('IPC directory list failed');
    expect(useAgentStore.getState().workingDirectories).toEqual([initialDirectory]);
    expect(useAgentStore.getState().workingDirectory).toEqual(initialDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: initialDirectory.handle });

    // Second sync succeeds and recovers
    const succeedingList = vi.fn(() => Promise.resolve([recoveredDirectory]));
    stubBridge({ agent: { listWorkingDirectories: succeedingList } });
    await useAgentStore.getState().syncWorkingDirectorySettings(settingsWithDefaults({ [currentProfile.id]: recoveredDirectory.handle }));
    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().workingDirectories).toEqual([recoveredDirectory]);
    expect(useAgentStore.getState().workingDirectory).toEqual(recoveredDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({ [currentProfile.id]: recoveredDirectory.handle });
  });

  it('clears an old override immediately upon hydrate fallback when custom profile disappeared during in-flight sync and converges to fallback default', async () => {
    const customProfile = profile('custom:profile-1');
    const fallbackProfile = profile('profile-fallback');
    const oldOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-old-override', displayName: 'Old override' };
    const fallbackDefaultDirectory: AgentWorkingDirectory = { handle: 'workspace-fallback-default', displayName: 'Fallback default' };
    const pendingSyncDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingHydrateDirectories = deferred<readonly AgentWorkingDirectory[]>();

    const validatedSettings = settingsWithDefaults({
      [fallbackProfile.id]: fallbackDefaultDirectory.handle,
    });

    useAgentStore.setState({
      profiles: [customProfile, fallbackProfile],
      selectedProfileId: customProfile.id,
      workingDirectories: [oldOverrideDirectory],
      workingDirectory: oldOverrideDirectory,
      workingDirectorySource: 'session-override',
      workingDirectoryDefaults: {},
    });

    let listWorkingDirectoriesCallCount = 0;
    stubBridge({
      settings: { get: () => Promise.resolve(DEFAULT_APP_SETTINGS) },
      agent: {
        listProfiles: () => Promise.resolve([fallbackProfile]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => {
          listWorkingDirectoriesCallCount += 1;
          return listWorkingDirectoriesCallCount === 1 ? pendingSyncDirectories.promise : pendingHydrateDirectories.promise;
        },
        getModeAvailability: () => Promise.resolve(availability('ready')),
        onEvent: onAgentEvent,
      },
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(validatedSettings);
    const hydration = useAgentStore.getState().hydrate();

    pendingHydrateDirectories.resolve([fallbackDefaultDirectory]);
    await hydration;

    // Hydrate fell back because customProfile disappeared. Override must NOT be carried over!
    expect(useAgentStore.getState().selectedProfileId).toBe(fallbackProfile.id);
    expect(useAgentStore.getState().workingDirectory).toBeNull();
    expect(useAgentStore.getState().workingDirectorySource).toBe('none');

    // Sync completes and converges to the validated default for fallbackProfile
    pendingSyncDirectories.resolve([fallbackDefaultDirectory]);
    await sync;

    expect(useAgentStore.getState().selectedProfileId).toBe(fallbackProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(fallbackDefaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({
      [fallbackProfile.id]: fallbackDefaultDirectory.handle,
    });
  });

  it('clears an old override immediately upon refreshProfiles fallback when custom profile disappeared during in-flight sync and converges to fallback default', async () => {
    const customProfile = profile('custom:profile-1');
    const fallbackProfile = profile('profile-fallback');
    const oldOverrideDirectory: AgentWorkingDirectory = { handle: 'workspace-old-override', displayName: 'Old override' };
    const fallbackDefaultDirectory: AgentWorkingDirectory = { handle: 'workspace-fallback-default', displayName: 'Fallback default' };
    const pendingSyncDirectories = deferred<readonly AgentWorkingDirectory[]>();
    const pendingProfiles = deferred<readonly AgentProfile[]>();

    const validatedSettings = settingsWithDefaults({
      [fallbackProfile.id]: fallbackDefaultDirectory.handle,
    });

    useAgentStore.setState({
      profiles: [customProfile, fallbackProfile],
      selectedProfileId: customProfile.id,
      workingDirectories: [oldOverrideDirectory],
      workingDirectory: oldOverrideDirectory,
      workingDirectorySource: 'session-override',
      workingDirectoryDefaults: {},
    });

    stubBridge({
      agent: {
        listProfiles: () => pendingProfiles.promise,
        listWorkingDirectories: () => pendingSyncDirectories.promise,
        getModeAvailability: () => Promise.resolve(availability('ready')),
      },
    });

    const sync = useAgentStore.getState().syncWorkingDirectorySettings(validatedSettings);
    const refresh = useAgentStore.getState().refreshProfiles();

    // refreshProfiles resolves without customProfile
    pendingProfiles.resolve([fallbackProfile]);
    await refresh;

    // Refresh fell back to fallbackProfile. Old override must NOT be carried over!
    expect(useAgentStore.getState().selectedProfileId).toBe(fallbackProfile.id);
    expect(useAgentStore.getState().workingDirectory).toBeNull();
    expect(useAgentStore.getState().workingDirectorySource).toBe('none');

    // Sync finishes and converges to the validated default for fallbackProfile
    pendingSyncDirectories.resolve([fallbackDefaultDirectory]);
    await sync;

    expect(useAgentStore.getState().selectedProfileId).toBe(fallbackProfile.id);
    expect(useAgentStore.getState().workingDirectory).toEqual(fallbackDefaultDirectory);
    expect(useAgentStore.getState().workingDirectorySource).toBe('profile-default');
    expect(useAgentStore.getState().workingDirectoryDefaults).toEqual({
      [fallbackProfile.id]: fallbackDefaultDirectory.handle,
    });
  });

  it('passes the displayed current handle to startSession', async () => {
    const currentProfile = profile('profile-a');
    const currentDirectory: AgentWorkingDirectory = { handle: 'workspace-current', displayName: 'Current workspace' };
    const started = { ...session('started-handle', 'running'), targetDirectory: currentDirectory };
    const startSession = vi.fn(() => Promise.resolve({ session: started }));
    stubBridge({
      agent: {
        startSession,
        getSession: () => Promise.resolve(null),
      },
    });
    useReaderStore.setState({ session: testReaderSession(doc('test-document', 'pdf', 1)) });
    useAgentStore.setState({
      documentId: 'test-document',
      profiles: [currentProfile],
      selectedProfileId: currentProfile.id,
      workingDirectory: currentDirectory,
      workingDirectories: [currentDirectory],
      workingDirectorySource: 'session-override',
      activeSession: null,
      loading: false,
      hydrated: true,
    });

    await useAgentStore.getState().start(currentProfile.id, 'auto-isolated', 'run this task');
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: currentProfile.id,
      workingDirectoryHandle: currentDirectory.handle,
      documentId: 'test-document',
      prompt: 'run this task',
    }));
  });

  it('refetches on profile changes and ignores an older response', async () => {
    const first = profile('profile-a');
    const second = profile('profile-b');
    const newer = deferred<readonly AgentModeAvailability[]>();
    const older = deferred<readonly AgentModeAvailability[]>();
    const getModeAvailability = vi.fn<(profileId?: string | null) => Promise<readonly AgentModeAvailability[]>>((profileId) => {
      if (profileId === 'profile-b') return older.promise;
      if (profileId === 'profile-a' && getModeAvailability.mock.calls.length > 1) return newer.promise;
      return Promise.resolve(availability('initial'));
    });
    stubBridge({
      agent: {
        listProfiles: () => Promise.resolve([first, second]),
        listSessions: () => Promise.resolve([]),
        getModeAvailability,
        onEvent: onAgentEvent,
      },
    });
    await useAgentStore.getState().hydrate();
    useAgentStore.getState().setSelectedProfile('profile-b');
    useAgentStore.getState().setSelectedProfile('profile-a');
    newer.resolve(availability('newer-profile-a'));
    await Promise.resolve();
    await Promise.resolve();
    older.resolve(availability('stale-profile-b'));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAgentStore.getState().selectedProfileId).toBe('profile-a');
    expect(useAgentStore.getState().modeAvailability[0]?.reason).toBe('newer-profile-a');
    expect(getModeAvailability).toHaveBeenCalledWith('profile-b');
    expect(getModeAvailability).toHaveBeenCalledWith('profile-a');
  });

  it('refreshes the terminal review once after main reports the reaped session', async () => {
    const running = session('terminal-refresh', 'running');
    const terminal = { ...session('terminal-refresh', 'completed'), events: [{ sessionId: 'terminal-refresh', ordinal: 4, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } satisfies AgentEvent] };
    let sessionReads = 0;
    const getEnvironmentReview = vi.fn(() => Promise.resolve(review('terminal-refresh')));
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([running]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession: vi.fn(() => {
          sessionReads += 1;
          return Promise.resolve(sessionReads === 1 ? running : terminal);
        }),
        getEnvironmentReview,
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: running, sessions: [running] });

    emitAgentEvent(terminal.events[0]!);
    await vi.waitFor(() => { expect(getEnvironmentReview).toHaveBeenCalledTimes(1); });
    expect(useAgentStore.getState().activeSession?.environment?.changedFiles[0]?.path).toBe('changed.txt');
    expect(sessionReads).toBeGreaterThanOrEqual(2);
  });

  it('ignores a terminal review response after the selected session changes', async () => {
    const first = session('stale-review', 'running');
    const second = session('new-selection', 'completed');
    const terminal = { ...session('stale-review', 'completed'), events: [{ sessionId: 'stale-review', ordinal: 1, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } satisfies AgentEvent] };
    const pendingReview = deferred<AgentEnvironmentReviewResult>();
    const getEnvironmentReview = vi.fn(() => pendingReview.promise);
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([first, second]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession: vi.fn(() => Promise.resolve(terminal)),
        getEnvironmentReview,
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: first, sessions: [first, second] });

    emitAgentEvent(terminal.events[0]!);
    await vi.waitFor(() => { expect(getEnvironmentReview).toHaveBeenCalledTimes(1); });
    useAgentStore.setState({ activeSession: second });
    pendingReview.resolve(review('stale-review'));
    await Promise.resolve();
    await Promise.resolve();

    expect(useAgentStore.getState().activeSession?.id).toBe('new-selection');
    expect(useAgentStore.getState().activeSession?.environment).toBeNull();
  });

  it('releases a timed-out terminal refresh so a later ended event can retry', async () => {
    vi.useFakeTimers();
    const running = session('retry-terminal-refresh', 'running');
    const ended = { sessionId: 'retry-terminal-refresh', ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } satisfies AgentEvent;
    let processEnded = false;
    const getEnvironmentReview = vi.fn(() => Promise.resolve(review('retry-terminal-refresh')));
    const getSession = vi.fn(() => Promise.resolve(processEnded ? { ...running, status: 'completed' as const, events: [ended] } : running));
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([running]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession,
        getEnvironmentReview,
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: running, sessions: [running] });

    emitAgentEvent({ sessionId: running.id, ordinal: 1, type: 'error', error: { __interleafError: true, code: 'internal', message: 'still running' }, timestamp: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(getEnvironmentReview).not.toHaveBeenCalled();

    processEnded = true;
    emitAgentEvent(ended);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => { expect(getEnvironmentReview).toHaveBeenCalledTimes(1); });
    expect(useAgentStore.getState().activeSession?.environment?.sessionId).toBe(running.id);
  });

  it('invalidates an in-flight terminal review when the session is resumed', async () => {
    const completed = session('resume-refresh-race', 'completed');
    const running = { ...completed, status: 'running' as const };
    const ended = { sessionId: completed.id, ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() } satisfies AgentEvent;
    const pendingReview = deferred<AgentEnvironmentReviewResult>();
    let resumed = false;
    const getSession = vi.fn(() => Promise.resolve(resumed ? running : { ...completed, events: [ended] }));
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([completed]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession,
        getEnvironmentReview: vi.fn(() => pendingReview.promise),
        resumeSession: vi.fn(() => {
          resumed = true;
          return Promise.resolve({ session: running });
        }),
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: completed, sessions: [completed] });

    emitAgentEvent(ended);
    await vi.waitFor(() => { expect(api.agent.getEnvironmentReview).toHaveBeenCalledTimes(1); });
    await expect(useAgentStore.getState().resume('continue the task')).resolves.toBe(true);
    pendingReview.resolve(review(completed.id));
    await Promise.resolve();
    await Promise.resolve();

    expect(useAgentStore.getState().activeSession?.status).toBe('running');
    expect(useAgentStore.getState().activeSession?.environment).toBeNull();
    expect(getSession).toHaveBeenCalled();
  });

  it('trusts running status before a resumed started event and clears the prior report', async () => {
    const oldEvents: readonly AgentEvent[] = [
      { sessionId: 'resume-history', ordinal: 0, type: 'started', timestamp: new Date().toISOString() },
      { sessionId: 'resume-history', ordinal: 1, type: 'final', text: 'old report', timestamp: new Date().toISOString() },
      { sessionId: 'resume-history', ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() },
    ];
    const completed = { ...session('resume-history', 'completed'), finalReport: 'old report', eventCount: 3, events: oldEvents };
    const resumed = { ...completed, status: 'running' as const, events: oldEvents };
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([completed]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        resumeSession: vi.fn(() => Promise.resolve({ session: resumed })),
        getSession: vi.fn(() => Promise.resolve(resumed)),
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: completed, sessions: [completed] });

    await expect(useAgentStore.getState().resume('continue')).resolves.toBe(true);
    expect(useAgentStore.getState().activeSession?.status).toBe('running');
    expect(useAgentStore.getState().activeSession?.finalReport).toBeNull();

    emitAgentEvent({ sessionId: completed.id, ordinal: 3, type: 'started', timestamp: new Date().toISOString() });
    expect(useAgentStore.getState().activeSession?.status).toBe('running');
    emitAgentEvent({ sessionId: completed.id, ordinal: 4, type: 'ended', exitCode: 0, signal: null, timestamp: new Date().toISOString() });
    expect(useAgentStore.getState().activeSession?.status).toBe('completed');
  });

  it('keeps stopping through a cancellation acknowledgement until a later ended event', async () => {
    const current = session('stop-reconciliation', 'running');
    const started: AgentEvent = { sessionId: current.id, ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
    const cancelled: AgentEvent = { sessionId: current.id, ordinal: 1, type: 'cancelled', timestamp: new Date().toISOString() };
    const ended: AgentEvent = { sessionId: current.id, ordinal: 2, type: 'ended', exitCode: null, signal: 'SIGTERM', timestamp: new Date().toISOString() };
    const acknowledgement = { ...current, status: 'cancelled' as const, eventCount: 2, events: [started, cancelled] };
    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: () => Promise.resolve([]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession: vi.fn(() => Promise.resolve(acknowledgement)),
        stopSession: vi.fn(() => Promise.resolve()),
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);
    await useAgentStore.getState().hydrate();
    useAgentStore.setState({ activeSession: current, sessions: [current], events: [started], stopping: false });

    await useAgentStore.getState().stop();
    expect(useAgentStore.getState().activeSession?.status).toBe('cancelled');
    expect(useAgentStore.getState().stopping).toBe(true);

    await useAgentStore.getState().selectSession(current.id);
    expect(useAgentStore.getState().stopping).toBe(true);

    // Hydration/replay during the acknowledgement window must not make the
    // Stop control appear available again.
    await useAgentStore.getState().hydrate();
    expect(useAgentStore.getState().stopping).toBe(true);

    emitAgentEvent(ended);
    expect(useAgentStore.getState().activeSession?.status).toBe('cancelled');
    expect(useAgentStore.getState().stopping).toBe(false);

    const normal = session('normal-ended', 'running');
    const normalStarted: AgentEvent = { sessionId: normal.id, ordinal: 0, type: 'started', timestamp: new Date().toISOString() };
    useAgentStore.setState({ activeSession: { ...normal, eventCount: 1, events: [normalStarted] }, sessions: [normal], events: [normalStarted], stopping: true });
    emitAgentEvent({ sessionId: normal.id, ordinal: 1, type: 'ended', exitCode: null, signal: null, timestamp: new Date().toISOString() });
    expect(useAgentStore.getState().activeSession?.status).toBe('failed');
    expect(useAgentStore.getState().stopping).toBe(false);
  });

  it('manages document-specific sessions, clearing and rehydrating on document change', async () => {
    const sessionDoc1 = { ...session('s-doc-1', 'completed'), documentId: 'doc-1' };
    const sessionDoc2 = { ...session('s-doc-2', 'completed'), documentId: 'doc-2' };

    const listSessionsMock = vi.fn((documentId?: string) => {
      if (documentId === 'doc-1') return Promise.resolve([sessionDoc1]);
      if (documentId === 'doc-2') return Promise.resolve([sessionDoc2]);
      return Promise.resolve([]);
    });

    const api = {
      agent: {
        listProfiles: () => Promise.resolve([profile('profile-a')]),
        listSessions: listSessionsMock,
        listWorkingDirectories: () => Promise.resolve([]),
        getModeAvailability: () => Promise.resolve(availability('ready')),
        getSession: (id: string) => Promise.resolve(id === 's-doc-1' ? sessionDoc1 : id === 's-doc-2' ? sessionDoc2 : null),
        onEvent: onAgentEvent,
      },
    };
    stubBridge(api);

    // 1. Hydrate for doc-1
    await useAgentStore.getState().hydrate('doc-1');
    expect(useAgentStore.getState().documentId).toBe('doc-1');
    expect(useAgentStore.getState().sessions).toEqual([sessionDoc1]);
    expect(listSessionsMock).toHaveBeenCalledWith('doc-1');

    // 2. Select session from doc-1
    await useAgentStore.getState().selectSession('s-doc-1');
    expect(useAgentStore.getState().activeSession?.id).toBe('s-doc-1');

    // 3. Switch to doc-2: sessions and activeSession must clear, then load doc-2 sessions
    const switchPromise = useAgentStore.getState().hydrate('doc-2');
    // Synchronous clearing check immediately after initiating switch
    expect(useAgentStore.getState().activeSession).toBeNull();
    expect(useAgentStore.getState().sessions).toEqual([]);

    await switchPromise;
    expect(useAgentStore.getState().documentId).toBe('doc-2');
    expect(useAgentStore.getState().sessions).toEqual([sessionDoc2]);
    expect(useAgentStore.getState().activeSession).toBeNull();

    // 4. An event for doc-1 session while doc-2 is active must NOT display as active session
    emitAgentEvent({ sessionId: 's-doc-1', ordinal: 1, type: 'stdout', stream: 'stdout', text: 'foreign event', timestamp: new Date().toISOString() });
    expect(useAgentStore.getState().activeSession).toBeNull();
    expect(useAgentStore.getState().sessions).toEqual([sessionDoc2]);

    // 5. Attempting to select a doc-1 session while doc-2 is active must not set it as activeSession
    await useAgentStore.getState().selectSession('s-doc-1');
    expect(useAgentStore.getState().activeSession).toBeNull();

    // 6. Switch to doc-3 with no sessions
    await useAgentStore.getState().hydrate('doc-3');
    expect(useAgentStore.getState().documentId).toBe('doc-3');
    expect(useAgentStore.getState().sessions).toEqual([]);
    expect(useAgentStore.getState().activeSession).toBeNull();
  });
});
