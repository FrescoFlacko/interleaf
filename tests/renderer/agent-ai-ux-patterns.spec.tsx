// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AgentEvent, AgentSessionDetail } from '@shared/types/agent';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import { AgentResultCard } from '../../src/renderer/features/agent/AgentResultCard';
import { AgentResumeFollowUps } from '../../src/renderer/features/agent/AgentResumeFollowUps';
import { AgentSessionView } from '../../src/renderer/features/agent/AgentSessionView';
import { AgentTaskSummary } from '../../src/renderer/features/agent/AgentTaskSummary';
import { agentOutcomeLine, deriveAgentFollowUps } from '../../src/renderer/features/agent/agent-follow-ups';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';

const writeText = vi.fn((text: string) => Promise.resolve({ copied: true as const, characterCount: text.length }));

const environment: AgentSessionEnvironment = {
  sessionId: 'session-ux',
  mode: 'isolated-copy',
  riskLevel: 'low',
  workspaceLabel: '',
  primaryWasDirty: false,
  applyAllowed: false,
  applied: false,
  applyDisabledReason: null,
  activeWorkspaceModified: false,
  diffAvailable: false,
  diff: null,
  patchAvailable: false,
  containerRuntime: null,
  changedFiles: [
    { path: 'src/a.ts', kind: 'modified', additions: 2, deletions: 1, bytes: 10 },
    { path: 'src/b.ts', kind: 'created', additions: 5, deletions: 0, bytes: 20 },
  ],
  tests: [
    { status: 'passed', summary: 'unit', exitCode: 0, durationMs: 10 },
    { status: 'failed', summary: 'e2e', exitCode: 1, durationMs: 20 },
  ],
};

function agentSession(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id: 'session-ux',
    documentId: 'doc-ux',
    profileId: 'profile-ux',
    providerId: 'fake',
    targetDirectory: { handle: 'h1', displayName: 'workspace' },
    executionMode: 'isolated-copy',
    status: 'completed',
    providerSessionId: null,
    userPrompt: 'Fix the flaky test\nand explain why',
    contextSummary: 'Pages 3–5',
    finalReport: 'Done',
    effectiveModel: 'model-x',
    effectiveReasoningEffort: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:01:00.000Z',
    eventCount: 0,
    environment: null,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

beforeEach(() => {
  writeText.mockClear();
  stubBridge({ clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
});

describe('agent derivations', () => {
  it('offers Review only when files changed, Retry only after an unsuccessful run, and at most three', () => {
    const kinds = (session: AgentSessionDetail) => deriveAgentFollowUps(session, session.environment).map((followUp) => followUp.label);
    expect(kinds(agentSession())).toEqual(['Explain the result', 'Add or run tests']);
    expect(kinds(agentSession({ environment }))).toEqual(['Review the changes', 'Explain the result', 'Add or run tests']);
    expect(kinds(agentSession({ status: 'failed', environment }))).toEqual(['Retry', 'Review the changes', 'Explain the result']);
    expect(kinds(agentSession({ status: 'interrupted' }))).toEqual(['Retry', 'Explain the result', 'Add or run tests']);
    expect(deriveAgentFollowUps(agentSession({ status: 'cancelled' }), null)[0]?.prompt).toContain('Fix the flaky test');
  });

  it('builds the outcome line only from recorded data', () => {
    expect(agentOutcomeLine(null)).toBeNull();
    expect(agentOutcomeLine(environment)).toBe('2 changed files · tests 1 passed, 1 failed');
    expect(agentOutcomeLine({ changedFiles: [environment.changedFiles[0]!], tests: [] })).toBe('1 changed file');
  });

});

describe('AgentResultCard', () => {
  it('renders the report as inert Markdown with status, outcome and Copy Result', async () => {
    const copyResult = vi.fn(() => Promise.resolve({ copied: true, characterCount: 42 }));
    useAgentStore.setState({ copyResult });
    const report = '**Fixed** it.\n\n<script>window.pwned = true</script>\n\n<img src=x onerror="window.pwned = true">';
    const { container } = render(
      <AgentResultCard session={agentSession({ environment })} report={report} actionsReady />
    );

    const card = screen.getByRole('region', { name: 'Agent result' });
    expect(within(card).getByText('Completed')).toBeTruthy();
    const body = screen.getByTestId('agent-final-report');
    expect(body.querySelector('strong')?.textContent).toBe('Fixed');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
    expect(screen.getByTestId('agent-result-outcome')).toHaveTextContent('2 changed files · tests 1 passed, 1 failed');

    fireEvent.click(screen.getByTestId('agent-copy-result-button'));
    await waitFor(() => { expect(screen.getByTestId('agent-copy-status')).toHaveTextContent('42 chars'); });
    expect(copyResult).toHaveBeenCalledTimes(1);

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('omits Copy Result and the outcome line when neither is backed by data', () => {
    render(<AgentResultCard session={agentSession({ status: 'running' })} report="Working" actionsReady={false} />);
    expect(screen.queryByTestId('agent-copy-result-button')).toBeNull();
    expect(screen.queryByTestId('agent-result-outcome')).toBeNull();
  });
});

describe('AgentSessionView result placement', () => {
  it('shows the report once, in the Result card above and outside the pinned feed', () => {
    const report = 'Refactored the scheduler and added tests.';
    const final = { sessionId: 'session-ux', ordinal: 3, type: 'final', text: report, timestamp: '2026-09-22T00:01:00.000Z' } satisfies AgentEvent;
    useAgentStore.setState({ profiles: [], sessions: [], events: [final], loading: false, stopping: false });
    render(<AgentSessionView session={agentSession({ finalReport: report })} />);

    expect(screen.getAllByText(report)).toHaveLength(1);
    expect(screen.getByTestId('activity-final-final-3')).toHaveTextContent('Final report shown above.');
    const card = screen.getByTestId('agent-result-card');
    const feed = screen.getByTestId('agent-activity-scroll');
    expect(feed.contains(card)).toBe(false);
    expect(card.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('bounds a very long task prompt so the Result card still renders and Copy prompt copies it whole', async () => {
    const longPrompt = Array.from({ length: 400 }, (_, index) => `Step ${String(index)}: do the next thing.`).join('\n');
    useAgentStore.setState({ profiles: [], sessions: [], events: [], loading: false, stopping: false });
    const { container } = render(<AgentSessionView session={agentSession({ userPrompt: longPrompt, finalReport: 'All done.' })} />);

    const prompt = screen.getByRole('region', { name: 'Task prompt' });
    expect(prompt).toHaveClass('agent-run-prompt');
    expect(prompt).toHaveAttribute('tabindex', '0');
    expect(prompt).toContainElement(screen.getByTestId('agent-active-session-title'));
    expect(screen.getByTestId('agent-run-summary')).toHaveClass('agent-run-summary');
    expect(screen.getByTestId('agent-run-summary').compareDocumentPosition(screen.getByTestId('agent-result-card')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('agent-result-card')).toHaveTextContent('All done.');
    expect(screen.getByTestId('agent-activity-scroll')).toHaveClass('agent-activity-feed');

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(longPrompt); });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('keeps the final output in the timeline when there is no report to show above', () => {
    const final = { sessionId: 'session-ux', ordinal: 3, type: 'final', text: 'Streamed final text', timestamp: '2026-09-22T00:01:00.000Z' } satisfies AgentEvent;
    useAgentStore.setState({ profiles: [], sessions: [], events: [final], loading: false, stopping: false });
    render(<AgentSessionView session={agentSession({ finalReport: null })} />);

    expect(screen.queryByTestId('agent-result-card')).toBeNull();
    expect(screen.getByTestId('activity-final-final-3')).toHaveTextContent('Streamed final text');
  });
});

describe('Run details', () => {
  it('shows the full prompt and parameters, copies it, and reuses it as a draft without starting', async () => {
    const deselectSession = vi.fn();
    const start = vi.fn();
    useAgentStore.setState({ deselectSession, start });
    useUiStore.getState().setTaskDraft('');
    render(<AgentTaskSummary session={agentSession()} />);

    const toggle = screen.getByRole('button', { name: /run details/iu });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('agent-active-session-title').textContent).toBe('Fix the flaky test\nand explain why');
    expect(screen.getByTestId('agent-session-context-summary')).toHaveTextContent('Pages 3–5');
    // Profile, model, directory and mode are stated once, in the run header.
    expect(screen.queryByLabelText('Run parameters')).toBeNull();
    expect(screen.getByTestId('agent-run-summary')).not.toHaveTextContent('isolated-copy');

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('Fix the flaky test\nand explain why'); });

    fireEvent.click(screen.getByRole('button', { name: 'Use as new task' }));
    expect(useUiStore.getState().composer.taskDraft).toBe('Fix the flaky test\nand explain why');
    expect(deselectSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('AgentResumeFollowUps', () => {
  it('fills the resume field and never resumes', () => {
    const onFill = vi.fn();
    const resume = vi.fn();
    useAgentStore.setState({ resume });
    render(<AgentResumeFollowUps session={agentSession({ status: 'failed', environment })} disabled={false} onFill={onFill} />);

    const chips = within(screen.getByRole('group', { name: 'Suggested follow-ups' })).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Retry', 'Review the changes', 'Explain the result']);
    fireEvent.click(chips[1]!);
    expect(onFill).toHaveBeenCalledWith(expect.stringContaining('2 changed files'));
    expect(resume).not.toHaveBeenCalled();
  });
});
