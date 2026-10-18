// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentProfile, AgentSessionDetail } from '@shared/types/agent';
import type { DocumentMetadata } from '@shared/types/document';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { MENU_ITEM_TWO_LINE_CLASS, MENU_SURFACE_CLASS } from '../../src/renderer/components/ui/popover-presence';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

/**
 * A finished agent run used to dump the whole review at once. These assertions
 * hold the panel to a disclosure hierarchy instead: the three heavy blocks are
 * closed on arrival, each one is a real disclosure paired to the region it
 * controls, and opening one still reaches every action it used to expose.
 */

const fixtureDocument: DocumentMetadata = {
  id: 'doc-disclosure',
  title: 'Disclosure Fixture',
  author: 'Author',
  format: 'pdf',
  storageMode: 'link',
  fileSize: 100,
  fileMtimeMs: 100,
  fileHash: 'hash-disclosure',
  pageCount: 1,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const profile: AgentProfile = {
  id: 'profile-disclosure', providerId: 'fake', name: 'Profile', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-09-01T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

const reviewedSession: AgentSessionDetail = {
  id: 'session-disclosure',
  documentId: fixtureDocument.id,
  profileId: profile.id,
  providerId: 'fake',
  targetDirectory: { handle: 'h1', displayName: 'workspace' },
  executionMode: 'isolated-copy',
  status: 'completed',
  providerSessionId: 'provider-disclosure',
  userPrompt: 'review the fixture change',
  contextSummary: null,
  effectiveModel: null,
  effectiveReasoningEffort: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  finalReport: 'Fixture change is ready for review.',
  environment: {
    sessionId: 'session-disclosure',
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
  eventCount: 0,
  events: [],
  artifacts: [],
};

const secondSession: AgentSessionDetail = {
  ...reviewedSession,
  id: 'session-earlier',
  userPrompt: 'earlier task.',
  environment: null,
  finalReport: null,
};

/** The three named hierarchy blocks the design report asks for, verbatim. */
const DISCLOSURE_LABELS = ['Review', 'Test outcomes', 'All sessions'] as const;

function trigger(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

/**
 * Reference 6b replaces the session section's heading with the run header's
 * compact overflow control, so that one trigger shows a static glyph while the
 * in-place blocks still show a chevron.
 */
function expandedIcon(label: string): string {
  return label === 'All sessions' ? 'svg[data-icon="more-horizontal"]' : 'svg[data-icon="disclosure-expanded"]';
}

function collapsedIcon(label: string): string {
  return label === 'All sessions' ? 'svg[data-icon="more-horizontal"]' : 'svg[data-icon="disclosure-collapsed"]';
}

/** The region a disclosure trigger names, resolved through `aria-controls`. */
function controlledRegion(label: string): HTMLElement {
  const id = trigger(label).getAttribute('aria-controls');
  expect(id, `${label} names a controlled region`).toBeTruthy();
  const region = document.getElementById(id ?? '');
  if (region === null) throw new Error(`${label} names region "${String(id)}", which does not exist`);
  return region;
}

describe('agent panel review and session blocks are disclosures', () => {
  const getSession = vi.fn((id: string) =>
    Promise.resolve([reviewedSession, secondSession].find((session) => session.id === id) ?? null)
  );

  beforeEach(() => {
    cleanup();
    getSession.mockClear();
    const api = testInterleafApi({
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([profile])),
        listSessions: vi.fn(() => Promise.resolve([reviewedSession, secondSession])),
        getSession,
        getModeAvailability: vi.fn(() => Promise.resolve([])),
        onEvent: vi.fn(() => () => undefined),
      },
    });
    stubBridge(api);
    useReaderStore.setState({ session: testReaderSession(fixtureDocument) });
    useAgentStore.setState({
      profiles: [profile],
      selectedProfileId: profile.id,
      activeSession: reviewedSession,
      sessions: [reviewedSession, secondSession],
      events: [],
      hydrated: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts with all three blocks collapsed and no more than three expanded blocks anywhere', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-environment-review');

    for (const label of DISCLOSURE_LABELS) {
      const control = trigger(label);
      expect(control, label).toHaveAttribute('aria-expanded', 'false');
      expect(controlledRegion(label), label).not.toBeVisible();
    }

    // The run view opens with the task itself readable and nothing else
    // expanded, so the panel stays well under the three-expanded-block budget.
    const expanded = screen.queryAllByRole('button').filter((button) => button.getAttribute('aria-expanded') === 'true');
    expect(expanded.map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Run details']);
  });

  it('pairs each trigger to a stable region and toggles aria-expanded', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-environment-review');

    const regionIds = DISCLOSURE_LABELS.map((label) => trigger(label).getAttribute('aria-controls'));
    expect(new Set(regionIds).size).toBe(DISCLOSURE_LABELS.length);

    for (const label of DISCLOSURE_LABELS) {
      const control = trigger(label);
      const region = controlledRegion(label);

      fireEvent.click(control);
      expect(control, label).toHaveAttribute('aria-expanded', 'true');
      expect(region, label).toBeVisible();
      // The region is the same element across states, so `aria-controls`
      // never dangles.
      expect(controlledRegion(label)).toBe(region);
      // The state is carried by an icon rather than an emoji: a chevron for
      // the blocks that expand in place, and the run header's overflow glyph
      // for the session list, which opens as a panel over the header.
      expect(control.querySelector(expandedIcon(label)), label).not.toBeNull();

      fireEvent.click(control);
      expect(control, label).toHaveAttribute('aria-expanded', 'false');
      // An overlay panel fades out (100ms) before it is hidden.
      await waitFor(() => {
        expect(region, label).not.toBeVisible();
      });
      expect(control.querySelector(collapsedIcon(label)), label).not.toBeNull();
    }
  });

  it('reaches the changed files, the diff and every action through the Review block', async () => {
    render(<AgentComposer />);
    const card = await screen.findByTestId('agent-environment-review');

    // Everything the review used to show inline is reached along one access
    // path now: open Review, then read its controlled region.
    fireEvent.click(trigger('Review'));
    const region = controlledRegion('Review');
    const review = within(region);

    expect(review.getByRole('list', { name: 'Changed files' })).toBeTruthy();
    expect(region).toContainElement(screen.getByTestId('agent-review-files'));
    expect(region).toHaveTextContent('fixture.txt');
    expect(region).toHaveTextContent('modified · +1 / −0');

    for (const action of ['Apply Changes', 'Export Patch…', 'Open Folder', 'Discard Sandbox', 'Refresh']) {
      expect(region, action).toContainElement(review.getByRole('button', { name: action }));
    }

    const viewDiff = review.getByRole('button', { name: 'View Diff' });
    expect(viewDiff).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(viewDiff);
    expect(screen.getByTestId('agent-environment-diff').textContent).toContain('updated fixture');

    // Test outcomes stays a sibling block, so it opens without opening Review.
    fireEvent.click(trigger('Test outcomes'));
    expect(controlledRegion('Test outcomes')).toHaveTextContent('passed: fixture tests passed');

    // Risk and session context stay outside every disclosure: what tells the
    // reader whether this sandbox is safe to act on is never collapsed away.
    expect(card).toHaveTextContent('low risk');
    expect(controlledRegion('Review')).not.toContainElement(screen.getByTestId('agent-review-session-context'));
    expect(screen.getByTestId('agent-review-session-context')).toHaveTextContent('Execution mode: Isolated Directory Copy');
  });

  it('marks the review as the previous run and holds its test outcomes while a resumed run is in progress', async () => {
    useAgentStore.setState({
      activeSession: { ...reviewedSession, status: 'running' },
      events: [
        { sessionId: reviewedSession.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:00:00.000Z' },
        { sessionId: reviewedSession.id, ordinal: 1, type: 'final', text: 'first run report', timestamp: '2026-09-01T00:00:01.000Z' },
        { sessionId: reviewedSession.id, ordinal: 2, type: 'ended', exitCode: 0, signal: null, timestamp: '2026-09-01T00:00:02.000Z' },
        { sessionId: reviewedSession.id, ordinal: 3, type: 'started', timestamp: '2026-09-01T00:01:00.000Z' },
      ],
    });
    render(<AgentComposer />);
    await screen.findByTestId('agent-environment-review');

    expect(screen.getByTestId('agent-review-stale')).toHaveTextContent('From the previous run');
    fireEvent.click(trigger('Test outcomes'));
    expect(controlledRegion('Test outcomes')).toHaveTextContent('Running…');
    expect(controlledRegion('Test outcomes')).not.toHaveTextContent('fixture tests passed');

    // The earlier run's output stays in the history, under its own divider.
    expect(screen.getAllByTestId('agent-run-divider').map((divider) => divider.textContent)).toEqual(['Earlier run', 'Current run']);
  });

  it('still selects a session once the list is opened, keeping its accessible name', async () => {
    render(<AgentComposer />);
    await screen.findByTestId('agent-environment-review');

    // In the run view the list is reached through the header's overflow
    // control, which keeps the name the section used to carry. Its heading
    // form survives in the new-task view, where the chip still labels a
    // section (`agent-tab-redesign.spec.tsx`).
    const control = trigger('All sessions');
    expect(control).toHaveAccessibleName('All sessions');

    fireEvent.click(control);
    expect(controlledRegion('All sessions')).toHaveAccessibleName('All sessions');
    const list = within(controlledRegion('All sessions'));
    expect(list.getByRole('list', { name: 'All agent sessions' })).toBeTruthy();
    const current = list.getByRole('button', { name: /^Task: review the fixture change,/ });
    expect(current).toHaveAttribute('aria-current', 'true');

    const earlier = list.getByRole('button', { name: /^Task: earlier task,/ });
    // The rows are the shared two-line menu row: the current run carries the
    // shared check, and no accessible name exposes the internal run id.
    for (const row of [current, earlier]) {
      expect(row.className).toBe(MENU_ITEM_TWO_LINE_CLASS);
      expect(row.getAttribute('aria-label')).toMatch(/^Task: .+, (Queued|Running|Waiting|Completed|Failed|Cancelled|Interrupted)(, .+)?$/u);
      expect(row.getAttribute('aria-label')).not.toMatch(/session-/u);
      // A prompt's own closing full stop is not doubled against the status.
      expect(row.getAttribute('aria-label')).not.toMatch(/[.!?],/u);
    }
    expect(within(current).getByTestId('agent-session-item-check').querySelector('svg')).not.toBeNull();
    expect(within(earlier).getByTestId('agent-session-item-check').querySelector('svg')).toBeNull();
    expect(controlledRegion('All sessions').className).toContain(MENU_SURFACE_CLASS);
    fireEvent.click(earlier);
    // Selection first asks main to take ownership of the session (item C), so
    // the detail read lands on the following microtask.
    await waitFor(() => { expect(getSession).toHaveBeenCalledWith('session-earlier', fixtureDocument.id); });
  });
});
