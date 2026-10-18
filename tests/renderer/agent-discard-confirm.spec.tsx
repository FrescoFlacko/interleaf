// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import { CompactDrawer } from '../../src/renderer/components/CompactDrawer';
import { AgentSessionView } from '../../src/renderer/features/agent/AgentSessionView';
import { useShortcuts } from '../../src/renderer/hooks/use-shortcuts';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { discardOriginOf, type AgentDiscardOrigin } from '../../src/renderer/stores/agent-discard-origin';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * Discard Sandbox removes work that cannot be recovered, so it asks first. The
 * run is rendered as the reader meets it on a narrow window: the session view
 * inside the compact drawer, with the app's shortcuts live, so Escape and Tab
 * are tested against the drawer's own handlers too. jsdom does not keep focus
 * out of inert content, so the inert background is checked here by attribute
 * and by the focus guard, and in real Electron by `agent-review-confirm`.
 */

const directory = { handle: 'dir-h', displayName: 'Project' };

function environment(sessionId: string, mode: AgentSessionEnvironment['mode'] = 'isolated-copy'): AgentSessionEnvironment {
  const direct = mode === 'active-env' || mode === 'native-restricted';
  return {
    sessionId, mode, riskLevel: direct ? 'high' : 'low',
    workspaceLabel: direct ? 'Selected working directory' : 'Interleaf isolated workspace',
    primaryWasDirty: false, applyAllowed: !direct, applied: false,
    applyDisabledReason: direct ? 'Direct workspace modes have no sandbox to apply.' : null,
    activeWorkspaceModified: direct, changedFiles: [{ path: 'result.txt', kind: 'created', additions: 1, deletions: 0, bytes: 2 }],
    tests: [], diffAvailable: true, diff: 'diff --git a/result.txt b/result.txt', patchAvailable: !direct, containerRuntime: null,
  };
}

function run(id: string, overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
  return {
    id, documentId: 'book-a', profileId: 'fake', providerId: 'fake', targetDirectory: directory, executionMode: 'isolated-copy',
    status: 'completed', providerSessionId: null, userPrompt: 'task', contextSummary: null, finalReport: 'report',
    effectiveModel: null, effectiveReasoningEffort: null, createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z', eventCount: 0, environment: environment(id), events: [], artifacts: [],
    ...overrides,
  };
}

/** The open run, as the session view shows it, inside the drawer. */
function Panel(): ReactElement {
  useShortcuts();
  const session = useAgentStore((state) => state.activeSession);
  return (
    <CompactDrawer
      side="right" label="Companion" testId="compact-drawer-right" inert={false} slidePhase="open"
      onClose={() => { useUiStore.getState().setCompactActivePanel(null); }}
      onSwitch={vi.fn()} switchLabel="Switch to library" switchTestId="switch-to-library-button"
    >
      {session !== null && <AgentSessionView session={session} />}
    </CompactDrawer>
  );
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Lets a main call and the reload after it land. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((done) => { setTimeout(done, 0); }); });
}

const discardButton = (): HTMLElement => screen.getByRole('button', { name: 'Discard Sandbox' });
const confirmation = (): HTMLElement => screen.getByRole('alertdialog');

async function openConfirmation(): Promise<HTMLElement> {
  render(<Panel />);
  // The drawer claims focus a frame after it opens; let that settle first.
  await act(async () => { await new Promise((done) => { window.requestAnimationFrame(done); }); });
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  const trigger = discardButton();
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('Discard Sandbox asks before it discards', () => {
  let discard: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
  let getSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<AgentSessionDetail | null>>>;

  beforeEach(() => {
    discard = vi.fn(() => Promise.resolve());
    getSession = vi.fn((id: string) => Promise.resolve(run(id, { environment: null, environmentState: 'discarded' })));
    stubBridge({ agent: { discardSandbox: discard, getSession } });
    useAgentStore.setState({ documentId: 'book-a', activeSession: run('run-a'), sessions: [], events: [], error: null, loading: false, launching: false });
    useUiStore.getState().setCompactActivePanel('right');
  });

  afterEach(() => {
    cleanup();
    useAgentStore.setState({ activeSession: null, error: null });
    useUiStore.getState().setCompactActivePanel(null);
  });

  it('opens a described confirmation with Cancel focused, and nothing is discarded yet', async () => {
    await openConfirmation();
    const dialog = confirmation();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Discard sandbox?');
    expect(dialog).toHaveAccessibleDescription(/permanently removes the agent’s un-applied changes.*cannot be resumed/u);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(discard).not.toHaveBeenCalled();
  });

  it('says a direct run’s working directory is not restored', async () => {
    useAgentStore.setState({ activeSession: run('run-a', { executionMode: 'active-env', environment: environment('run-a', 'active-env') }) });
    await openConfirmation();
    const dialog = confirmation();
    expect(dialog).toHaveAccessibleName('Discard review data?');
    expect(dialog).toHaveAccessibleDescription(/snapshot and review data.*does not undo changes the agent already made in Project/u);
    expect(within(dialog).getByRole('button', { name: 'Discard review data' })).toBeInTheDocument();
  });

  it('keeps the work when cancelled, and gives focus back to Discard Sandbox', async () => {
    const trigger = await openConfirmation();
    fireEvent.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(discard).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-environment-review')).toHaveTextContent('1 changed file');
  });

  it('closes on Escape without closing the drawer behind it', async () => {
    const trigger = await openConfirmation();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useUiStore.getState().compactActivePanel).toBe('right');
    expect(document.activeElement).toBe(trigger);
    expect(discard).not.toHaveBeenCalled();
    // The drawer still closes on the next Escape, as before.
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(useUiStore.getState().compactActivePanel).toBeNull();
  });

  it('closes on a click outside it, and a click inside it does not', async () => {
    await openConfirmation();
    fireEvent.click(confirmation());
    expect(confirmation()).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-discard-scrim'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('keeps Tab and Shift+Tab inside the confirmation', async () => {
    await openConfirmation();
    const dialog = confirmation();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Discard sandbox' });
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });

  it('discards the run it was opened for exactly once', async () => {
    const pending = deferred<undefined>();
    discard.mockImplementation(() => pending.promise);
    await openConfirmation();
    const confirm = within(confirmation()).getByRole('button', { name: 'Discard sandbox' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(confirmation()).toHaveAttribute('aria-busy', 'true');
    // Busy: neither Escape nor Cancel walks away from a discard in flight.
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(confirmation()).toBeInTheDocument();

    pending.resolve(undefined);
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith('run-a');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('agent-environment-review')).toBeNull();
  });

  it('shows why main refused, keeps the work, and can be retried', async () => {
    discard.mockRejectedValueOnce(new Error('The sandbox is busy; try again.'));
    await openConfirmation();
    const confirm = within(confirmation()).getByRole('button', { name: 'Discard sandbox' });
    fireEvent.click(confirm);
    await settle();
    expect(within(confirmation()).getByRole('alert')).toHaveTextContent('The sandbox is busy; try again.');
    expect(confirmation()).toHaveAttribute('aria-busy', 'false');
    expect(getSession).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await settle();
    expect(discard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('is withdrawn when another run is opened, and never discards either run', async () => {
    await openConfirmation();
    act(() => { useAgentStore.setState({ activeSession: run('run-b') }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('is withdrawn when the run starts again', async () => {
    await openConfirmation();
    act(() => { useAgentStore.setState({ activeSession: run('run-a', { status: 'running' }) }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => { useAgentStore.setState({ activeSession: run('run-a') }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('is withdrawn when the review it described changes', async () => {
    await openConfirmation();
    const changed = { ...environment('run-a'), diff: 'diff --git a/other.txt b/other.txt' };
    act(() => { useAgentStore.setState({ activeSession: run('run-a', { environment: changed }) }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('is withdrawn when the middle of a same-length diff changes', async () => {
    const before = { ...environment('run-a'), diff: `${'a'.repeat(64)}oldmiddle${'z'.repeat(64)}` };
    useAgentStore.setState({ activeSession: run('run-a', { environment: before }) });
    await openConfirmation();
    act(() => { useAgentStore.setState({ activeSession: run('run-a', { environment: { ...before, diff: `${'a'.repeat(64)}newmiddle${'z'.repeat(64)}` } }) }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('is withdrawn when the workspace it described changes', async () => {
    await openConfirmation();
    act(() => { useAgentStore.setState({ activeSession: run('run-a', { targetDirectory: { handle: 'dir-other', displayName: 'Project' } }) }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('is withdrawn, and refused, when the same run is resumed and finishes before it is confirmed', async () => {
    const next = run('run-a', { eventCount: 1, updatedAt: '2026-10-14T00:01:00.000Z' });
    getSession.mockResolvedValue(next);
    stubBridge({ agent: { resumeSession: () => Promise.resolve({ session: next }) } });
    await openConfirmation();
    const staleConfirm = within(confirmation()).getByRole('button', { name: 'Discard sandbox' });
    await act(async () => { await useAgentStore.getState().resume('new attempt'); });
    expect(useAgentStore.getState().activeSession?.status).toBe('completed');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(staleConfirm);
    await settle();
    expect(discard).not.toHaveBeenCalled();
  });

  // The store changes and the old Confirm is clicked in one batch, before React
  // can withdraw the dialog: the store itself must refuse what was not confirmed.
  it.each([
    ['the middle of a same-length diff changes', () => run('run-a', { environment: { ...environment('run-a'), diff: `${'a'.repeat(64)}newmiddle${'z'.repeat(64)}` } })],
    ['the working directory changes', () => run('run-a', { targetDirectory: { handle: 'dir-other', displayName: 'Project' } })],
    ['the run starts again', () => run('run-a', { status: 'running' })],
    ['the environment is already discarded', () => run('run-a', { environment: null, environmentState: 'discarded' })],
  ])('refuses an old Confirm clicked before React re-renders when %s', async (_case, latest) => {
    useAgentStore.setState({ activeSession: run('run-a', { environment: { ...environment('run-a'), diff: `${'a'.repeat(64)}oldmiddle${'z'.repeat(64)}` } }) });
    await openConfirmation();
    const confirm = within(confirmation()).getByRole('button', { name: 'Discard sandbox' });
    act(() => {
      useAgentStore.setState({ activeSession: latest() });
      fireEvent.click(confirm);
    });
    await settle();
    expect(discard).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not give focus to the old run’s button once another run is open', async () => {
    const trigger = await openConfirmation();
    const focus = vi.spyOn(trigger, 'focus');
    act(() => { useAgentStore.setState({ activeSession: run('run-b') }); });
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps the whole background out of reach while open, and hands it back as it was', async () => {
    const outside = document.createElement('div');
    outside.setAttribute('inert', '');
    document.body.append(outside);
    await openConfirmation();
    const scrim = screen.getByTestId('agent-discard-scrim');
    expect(scrim.parentElement).toBe(document.body);
    const covered = [...document.body.children].filter((element) => element !== scrim);
    expect(covered.length).toBeGreaterThan(1);
    for (const element of covered) expect(element).toHaveAttribute('inert');
    // jsdom still lets inert content take focus; the guard returns it at once.
    for (const name of ['Review', 'Close drawer', 'Back to all sessions and new task']) {
      screen.getByRole('button', { name, hidden: true }).focus();
      expect(confirmation()).toContainElement(document.activeElement as HTMLElement);
    }
    fireEvent.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    expect(outside).toHaveAttribute('inert');
    for (const element of covered.filter((element) => element !== outside)) expect(element).not.toHaveAttribute('inert');
    outside.remove();
  });

  it('names the run, its workspace and its mode', async () => {
    useAgentStore.setState({ activeSession: run('run-a', { userPrompt: 'tidy the fixtures' }) });
    await openConfirmation();
    const details = within(confirmation()).getByTestId('agent-discard-run');
    expect(details).toHaveTextContent('Runtidy the fixtures');
    expect(details).toHaveTextContent('WorkspaceInterleaf isolated workspace');
    expect(details).toHaveTextContent(/Mode.*isolated/iu);
    expect(confirmation()).toHaveAccessibleDescription(/tidy the fixtures.*working directory, Project, is not changed/u);
  });

  it('moves focus to the run’s New task once the discarded review is gone', async () => {
    await openConfirmation();
    const confirm = within(confirmation()).getByRole('button', { name: 'Discard sandbox' });
    confirm.focus();
    fireEvent.click(confirm);
    await settle();
    expect(screen.queryByTestId('agent-environment-review')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('agent-back-button'));
    expect(screen.getByTestId('compact-drawer-right')).toContainElement(document.activeElement as HTMLElement);
  });

  it.each([
    ['fails', (): Promise<AgentSessionDetail | null> => Promise.reject(new Error('reload offline'))],
    ['returns nothing', (): Promise<AgentSessionDetail | null> => Promise.resolve(null)],
  ])('retires the discarded run and says so when reloading it %s', async (_case, reload) => {
    getSession.mockImplementationOnce(reload);
    await openConfirmation();
    fireEvent.click(within(confirmation()).getByRole('button', { name: 'Discard sandbox' }));
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const { activeSession } = useAgentStore.getState();
    expect(activeSession?.environment).toBeNull();
    expect(activeSession?.environmentState).toBe('discarded');
    expect(screen.queryByTestId('agent-environment-review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard Sandbox' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Sandbox discarded, but this run could not be reloaded.');
    expect(document.activeElement).toBe(screen.getByTestId('agent-back-button'));
  });

  it('is unavailable while the run is active', () => {
    useAgentStore.setState({ activeSession: run('run-a', { status: 'running' }) });
    render(<Panel />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(discardButton()).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    await openConfirmation();
    const results = await axe.run(confirmation(), { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe('the store discards only the exact review it was asked to', () => {
  /** The origin a confirmation opened on the open run would carry. */
  const origin = (): AgentDiscardOrigin => {
    const taken = discardOriginOf(useAgentStore.getState());
    if (taken === null) throw new Error('the open run has nothing to discard');
    return taken;
  };

  afterEach(() => { useAgentStore.setState({ activeSession: null, sessions: [], error: null }); });

  it.each([
    ['another run is open', (stale: AgentDiscardOrigin) => { useAgentStore.setState({ activeSession: run('run-b') }); return stale; }],
    ['another book is open', (stale: AgentDiscardOrigin) => { useAgentStore.setState({ documentId: 'book-b' }); return stale; }],
    ['the run has been resumed since', (stale: AgentDiscardOrigin) => {
      stubBridge({ agent: { resumeSession: () => new Promise(() => undefined) } });
      void useAgentStore.getState().resume('again');
      return stale;
    }],
    ['the review differs from the one confirmed', (stale: AgentDiscardOrigin) => ({ ...stale, review: `${stale.review} ` })],
    ['the diff changed since', (stale: AgentDiscardOrigin) => {
      useAgentStore.setState({ activeSession: run('run-a', { environment: { ...environment('run-a'), diff: 'diff --git a/result.txt b/result.TXT' } }) });
      return stale;
    }],
  ])('refuses without calling main when %s', async (_case, arrange) => {
    const discard = vi.fn(() => Promise.resolve());
    stubBridge({ agent: { discardSandbox: discard } });
    useAgentStore.setState({ documentId: 'book-a', activeSession: run('run-a'), loading: false, launching: false });
    const stale = arrange(origin());
    await expect(useAgentStore.getState().discardSandbox(stale)).resolves.toBe('refused');
    expect(discard).not.toHaveBeenCalled();
    useAgentStore.setState({ loading: false, launching: false });
  });

  it('has nothing to confirm for a run that is active or already discarded', () => {
    useAgentStore.setState({ documentId: 'book-a', events: [], activeSession: run('run-a', { status: 'running' }) });
    expect(discardOriginOf(useAgentStore.getState())).toBeNull();
    useAgentStore.setState({ activeSession: run('run-a', { environment: null, environmentState: 'discarded' }) });
    expect(discardOriginOf(useAgentStore.getState())).toBeNull();
  });

  it('discards an unchanged confirmed review once, and retires it', async () => {
    const discard = vi.fn(() => Promise.resolve());
    stubBridge({ agent: { discardSandbox: discard, getSession: () => Promise.resolve(null) } });
    useAgentStore.setState({ documentId: 'book-a', events: [], activeSession: run('run-a'), sessions: [run('run-a')], error: null });
    await expect(useAgentStore.getState().discardSandbox(origin())).resolves.toBe('discarded');
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith('run-a');
    expect(useAgentStore.getState().activeSession?.environmentState).toBe('discarded');
    expect(useAgentStore.getState().sessions[0]?.environment).toBeNull();
  });

  it('marks only the discarded run once main has, leaving the run opened meanwhile untouched', async () => {
    const pending = deferred<undefined>();
    stubBridge({ agent: { discardSandbox: () => pending.promise, getSession: () => Promise.reject(new Error('offline')) } });
    const second = run('run-b');
    useAgentStore.setState({ documentId: 'book-a', activeSession: run('run-a'), sessions: [run('run-a'), second], error: null });
    const discarding = useAgentStore.getState().discardSandbox(origin());
    useAgentStore.setState({ activeSession: second });
    pending.resolve(undefined);
    await expect(discarding).resolves.toBe('discarded');
    const state = useAgentStore.getState();
    expect(state.activeSession).toBe(second);
    expect(state.error).toBeNull();
    expect(state.sessions.find((item) => item.id === 'run-a')?.environmentState).toBe('discarded');
    expect(state.sessions.find((item) => item.id === 'run-b')).toBe(second);
  });
});
