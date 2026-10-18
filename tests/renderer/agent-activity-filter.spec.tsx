// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent, AgentProfile, AgentSessionDetail } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { normalizeAgentEvents } from '../../src/renderer/features/agent/agent-activity';
import { groupRepeatedErrors } from '../../src/renderer/features/agent/agent-activity-groups';
import {
  activityCountLabel,
  AGENT_ACTIVITY_FILTERS,
  categorizeActivity,
  countActivityEvents,
  filterActivityEntries,
  isAgentActivityCategory,
} from '../../src/renderer/features/agent/agent-activity-filter';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { chooseValue } from '../helpers/listbox-select';

/**
 * Reference 6b's `All ▾` control. The filter is purely a view over the already
 * normalized client-side timeline: it groups first and filters second, states
 * both counts while something is hidden, and belongs to the session it was
 * chosen for.
 */

const fixtureDocument: DocumentMetadata = {
  id: 'doc-filter',
  title: 'Filter Fixture',
  author: 'Author',
  format: 'pdf',
  storageMode: 'link',
  fileSize: 100,
  fileMtimeMs: 100,
  fileHash: 'hash-filter',
  pageCount: 2,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const profile: AgentProfile = {
  id: 'profile-filter', providerId: 'fake', name: 'Filter Profile', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-09-01T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

function makeSession(id: string, prompt: string): AgentSessionDetail {
  return {
    id,
    documentId: fixtureDocument.id,
    profileId: profile.id,
    providerId: 'fake',
    targetDirectory: { handle: `handle-${id}`, displayName: 'filter-workspace' },
    executionMode: 'isolated-copy',
    status: 'completed',
    providerSessionId: `provider-${id}`,
    userPrompt: prompt,
    contextSummary: null,
    effectiveModel: 'fixture-model',
    effectiveReasoningEffort: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:02:05.000Z',
    finalReport: null,
    environment: null,
    eventCount: 0,
    events: [],
    artifacts: [],
  };
}

const sessionA = makeSession('session-filter-a', 'Do the mixed-activity run.');
const sessionB = makeSession('session-filter-b', 'Do the commands-only run.');

type EventBody = AgentEvent extends infer Event
  ? Event extends AgentEvent ? Omit<Event, 'sessionId' | 'ordinal' | 'timestamp'> : never
  : never;

function event(sessionId: string, ordinal: number, body: EventBody): AgentEvent {
  return {
    sessionId,
    ordinal,
    timestamp: `2026-09-01T00:00:${String(ordinal).padStart(2, '0')}.000Z`,
    ...body,
  };
}

/** The same transport failure retried three times, as the CLI logs it. */
function transportError(sessionId: string, ordinal: number): AgentEvent {
  return event(sessionId, ordinal, {
    type: 'error',
    error: { __interleafError: true, message: 'transport error: connection reset', code: 'internal' },
  });
}

/** One event of every category: status, message, command, file, test, errors, final. */
const mixedEvents: readonly AgentEvent[] = [
  event(sessionA.id, 0, { type: 'started' }),
  event(sessionA.id, 1, { type: 'structured', data: { type: 'agent_message', id: 'msg-1', text: 'Reading the project guidance first.' } }),
  event(sessionA.id, 2, { type: 'structured', data: { type: 'command_execution', id: 'cmd-1', command: 'npm run build', exit_code: 0 } }),
  event(sessionA.id, 3, { type: 'changed-files', data: { files: ['src/app/layout.tsx'] } }),
  event(sessionA.id, 4, { type: 'tests', data: { passed: 12, failed: 0, total: 12, summary: '12 passed' } }),
  transportError(sessionA.id, 5),
  transportError(sessionA.id, 6),
  transportError(sessionA.id, 7),
  event(sessionA.id, 8, { type: 'final', text: 'Build is green.' }),
];

const commandOnlyEvents: readonly AgentEvent[] = [
  event(sessionB.id, 0, { type: 'structured', data: { type: 'command_execution', id: 'cmd-b', command: 'npm run lint', exit_code: 0 } }),
];

function installApi(sessions: readonly AgentSessionDetail[]): void {
  const api = testInterleafApi({
    agent: {
      listProfiles: vi.fn(() => Promise.resolve([profile])),
      listSessions: vi.fn(() => Promise.resolve(sessions)),
      getSession: vi.fn(() => Promise.resolve(sessions[0] ?? null)),
      getModeAvailability: vi.fn(() => Promise.resolve([])),
      onEvent: vi.fn(() => () => undefined),
    },
  });
  stubBridge(api);
}

beforeEach(() => {
  useReaderStore.setState({ session: testReaderSession(fixtureDocument) });
  installApi([sessionA, sessionB]);
  useAgentStore.setState({
    profiles: [profile], selectedProfileId: profile.id, hydrated: true,
    activeSession: sessionA, sessions: [sessionA, sessionB], events: [...mixedEvents],
    workingDirectory: { handle: 'handle-session-filter-a', displayName: 'filter-workspace' },
  });
});

afterEach(() => {
  cleanup();
  useReaderStore.setState({ session: null });
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
});

describe('activity categories', () => {
  const activities = normalizeAgentEvents([...mixedEvents]);

  it('maps every normalized kind onto exactly one offered category', () => {
    const observed = activities.map((activity) => `${activity.kind}:${categorizeActivity(activity)}`);
    expect(observed).toEqual([
      'lifecycle:status',
      'message:messages',
      'command:commands',
      'file_change:files',
      'test_run:tests',
      'error:errors',
      'error:errors',
      'error:errors',
      'final:messages',
    ]);
    // Nothing can fall outside the control's own options.
    for (const activity of activities) {
      expect(AGENT_ACTIVITY_FILTERS.some((filter) => filter.value === categorizeActivity(activity))).toBe(true);
    }
  });

  it('rejects a value that is not an offered category', () => {
    expect(isAgentActivityCategory('commands')).toBe(true);
    expect(isAgentActivityCategory('everything')).toBe(false);
  });

  it('keeps a repeated-error group whole and counts the errors it folds', () => {
    const grouped = groupRepeatedErrors(activities);
    const errorsOnly = filterActivityEntries(grouped, 'errors');

    // One row, still the group, still carrying all three failures.
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]?.kind).toBe('error_group');
    expect(countActivityEvents(errorsOnly)).toBe(3);
    // Filtering never invents a group: grouping already ran over the whole
    // timeline, so a category that keeps two non-adjacent errors keeps two rows.
    expect(filterActivityEntries(grouped, 'all')).toEqual(grouped);
    expect(countActivityEvents(filterActivityEntries(grouped, 'messages'))).toBe(2);
    expect(filterActivityEntries(grouped, 'tests')).toHaveLength(1);
  });

  it('does not fold errors that the unfiltered timeline kept apart', () => {
    const separated = normalizeAgentEvents([
      transportError(sessionA.id, 0),
      event(sessionA.id, 1, { type: 'structured', data: { type: 'command_execution', id: 'c', command: 'ls', exit_code: 0 } }),
      transportError(sessionA.id, 2),
    ]);
    const errorsOnly = filterActivityEntries(groupRepeatedErrors(separated), 'errors');
    expect(errorsOnly).toHaveLength(2);
    expect(errorsOnly.every((entry) => entry.kind === 'single')).toBe(true);
  });

  it('states both numbers only while something is filtered out', () => {
    expect(activityCountLabel(9, 9)).toBe('9 events');
    expect(activityCountLabel(1, 1)).toBe('1 event');
    expect(activityCountLabel(0, 1)).toBe('0 of 1 event');
    expect(activityCountLabel(3, 9)).toBe('3 of 9 events');
  });
});

describe('6b — activity filter control', () => {
  it('filters the feed, keeps the group whole and reports filtered against total', async () => {
    render(<AgentComposer />);
    const feed = await screen.findByTestId('agent-activity-list');

    const control = screen.getByRole('combobox', { name: 'Filter activity by type' });
    expect(control).toHaveAttribute('data-value', 'all');
    expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('9 events');

    chooseValue(control, 'commands');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('1 of 9 events');
    });
    expect(feed).toHaveTextContent('npm run build');
    expect(feed).not.toHaveTextContent('Reading the project guidance first.');

    // The folded group survives filtering as one row that still counts three.
    chooseValue(control, 'errors');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('3 of 9 events');
    });
    const group = screen.getByRole('button', { name: /3 repeated errors/ });
    const region = document.getElementById(group.getAttribute('aria-controls') ?? '');
    if (region === null) throw new Error('The error group names no region.');
    fireEvent.click(group);
    expect(within(region).getAllByRole('alert')).toHaveLength(3);
  });

  it('says the feed is empty because of the filter, not because the run was', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    chooseValue(screen.getByRole('combobox', { name: 'Filter activity by type' }), 'files');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('1 of 9 events');
    });

    // A category with no rows explains itself rather than reusing the
    // "waiting for activity" wording of a run that has not spoken yet.
    chooseValue(screen.getByRole('combobox', { name: 'Filter activity by type' }), 'tests');
    useAgentStore.setState({ events: [...commandOnlyEvents] });
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-empty')).toHaveTextContent('No events match this filter.');
    });
    expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('0 of 1 event');
  });

  it('returns to All when another session is opened', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    chooseValue(screen.getByRole('combobox', { name: 'Filter activity by type' }), 'tests');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('1 of 9 events');
    });

    // Session B has no test run. Carrying the filter across would present it
    // as an empty run, so the control resets with the selection.
    useAgentStore.setState({ activeSession: sessionB, events: [...commandOnlyEvents] });
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Filter activity by type' })).toHaveAttribute('data-value', 'all');
    });
    expect(screen.getByTestId('agent-activity-count').textContent).toBe('1 event');
    expect(screen.getByTestId('agent-activity-list')).toHaveTextContent('npm run lint');
  });

  it('stays on All when the first session is reopened, and still filters there', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-activity-list');
    const control = (): HTMLElement => screen.getByRole('combobox', { name: 'Filter activity by type' });

    chooseValue(control(), 'tests');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('1 of 9 events');
    });

    useAgentStore.setState({ activeSession: sessionB, events: [...commandOnlyEvents] });
    await waitFor(() => { expect(control()).toHaveAttribute('data-value', 'all'); });

    // Going back must not resurrect A's category. The run view is reused
    // rather than remounted, so a reset that only hid the old selection would
    // restore Tests here and show 1 of 9 events again.
    useAgentStore.setState({ activeSession: sessionA, events: [...mixedEvents] });
    await waitFor(() => { expect(control()).toHaveAttribute('data-value', 'all'); });
    // Exact, because "1 of 9 events" also contains "9 events".
    expect(screen.getByTestId('agent-activity-count').textContent).toBe('9 events');
    expect(screen.getByTestId('agent-activity-list')).toHaveTextContent('Reading the project guidance first.');

    // The reset leaves a working control behind, not a stuck one.
    chooseValue(control(), 'commands');
    await waitFor(() => {
      expect(screen.getByTestId('agent-activity-count')).toHaveTextContent('1 of 9 events');
    });
    expect(screen.getByTestId('agent-activity-list')).toHaveTextContent('npm run build');
  });
});
