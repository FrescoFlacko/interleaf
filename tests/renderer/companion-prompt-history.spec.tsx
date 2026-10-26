// @vitest-environment jsdom
import { createRef, useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { AgentSession, AgentSessionDetail } from '@shared/types/agent';
import type { AIProviderStatus } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { ChatComposer } from '../../src/renderer/features/chat/ChatComposer';
import { AgentTaskCard } from '../../src/renderer/features/agent/AgentTaskCard';
import { AgentResumeComposer } from '../../src/renderer/features/agent/AgentResumeComposer';
import { resetAgentFollowUps, setAgentFollowUpDraft } from '../../src/renderer/stores/agent-follow-up-drafts';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * ArrowUp/ArrowDown recall in the two companion composers, as the reader meets
 * it: pressing keys on a real field and reading back what the field then holds.
 * The traversal rules themselves are covered in `tests/unit/prompt-history.spec.ts`;
 * what matters here is that both panels are wired to them and that neither one
 * takes a key press the text field still needs.
 */

const provider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  models: [{ id: 'model-a', name: 'Model A', contextWindow: 8_000, maxOutputTokens: 2_000, supportsStreaming: true }],
};

const fixtureDocument: DocumentMetadata = {
  id: 'doc-fixture',
  title: 'Fixture Doc',
  author: 'Author',
  format: 'pdf',
  storageMode: 'link',
  fileSize: 100,
  fileMtimeMs: 100,
  fileHash: 'hash',
  pageCount: 12,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

function agentSession(id: string, userPrompt: string): AgentSession {
  return {
    id,
    documentId: fixtureDocument.id,
    profileId: 'profile-copy',
    providerId: 'fake',
    targetDirectory: { handle: 'dir-1', displayName: 'Workspace' },
    executionMode: 'isolated-copy',
    status: 'completed',
    providerSessionId: null,
    userPrompt,
    contextSummary: null,
    finalReport: null,
    effectiveModel: null,
    effectiveReasoningEffort: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    eventCount: 0,
    environment: null,
  };
}

/** The chat composer with its draft held where the panel holds it. */
function ChatHarness({
  submitted,
  historyKey = 'doc-1:session-1',
  onSubmit = (): undefined => undefined,
}: {
  readonly submitted: readonly string[];
  readonly historyKey?: string;
  readonly onSubmit?: () => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  return (
    <ChatComposer
      draft={draft}
      placeholder="Ask about this document"
      composerRef={createRef<HTMLTextAreaElement>()}
      composerDisabled={false}
      providers={[provider]}
      readyProviders={[provider]}
      providerDiscovery="succeeded"
      openRouterConfiguredModel={null}
      currentProviderId="fake"
      currentProviderReady
      currentModelId="model-a"
      currentReasoningEffort={null}
      controlsDisabled={false}
      settingsOpen={false}
      isStreaming={false}
      canSend
      webSearchSupported={false}
      webSearchEnabled={false}
      onWebSearchChange={vi.fn()}
      submittedPrompts={submitted}
      promptHistoryKey={historyKey}
      onDraftChange={setDraft}
      onSubmit={() => { setDraft(''); onSubmit(); }}
      onSelectModel={vi.fn()}
      onOpenProviderSettings={vi.fn()}
      onStop={vi.fn()}
      shelf={null}
      addContext={null}
    />
  );
}

/** Types into a field the way a reader does, caret left at the end. */
function type(field: HTMLTextAreaElement, value: string): void {
  fireEvent.change(field, { target: { value } });
  field.setSelectionRange(value.length, value.length);
}

function arrow(field: HTMLTextAreaElement, key: 'ArrowUp' | 'ArrowDown', init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(field, { key, ...init });
}

describe('AI Chat composer recalls previous prompts', () => {
  afterEach(() => { cleanup(); });

  it('walks back and forward through what was sent, restoring the unsent draft', () => {
    renderWithChatStore(chat, <ChatHarness submitted={['summarise chapter one', 'list the open questions']} />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    type(field, 'half-written');

    arrow(field, 'ArrowUp');
    expect(field.value).toBe('list the open questions');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('summarise chapter one');
    // Nothing older: the oldest entry stays put rather than clearing the field.
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('summarise chapter one');

    arrow(field, 'ArrowDown');
    expect(field.value).toBe('list the open questions');
    arrow(field, 'ArrowDown');
    expect(field.value).toBe('half-written');
  });

  it('leaves ordinary caret movement alone inside a multiline draft', () => {
    renderWithChatStore(chat, <ChatHarness submitted={['an earlier prompt']} />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    type(field, 'first line\nsecond line');

    // Caret on the second line: ArrowUp has a line to move to.
    field.setSelectionRange(14, 14);
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('first line\nsecond line');

    // Caret on the first line: ArrowDown has a line to move to.
    field.setSelectionRange(3, 3);
    arrow(field, 'ArrowDown');
    expect(field.value).toBe('first line\nsecond line');

    // At the top boundary, the same key recalls.
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('an earlier prompt');
  });

  it('ignores modified presses, open selections, and IME composition', () => {
    renderWithChatStore(chat, <ChatHarness submitted={['an earlier prompt']} />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    type(field, 'draft');

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      arrow(field, 'ArrowUp', { [modifier]: true });
      expect(field.value).toBe('draft');
    }
    // `isComposing` is read off the native event, so it is set there.
    fireEvent.keyDown(field, { key: 'ArrowUp', isComposing: true });
    expect(field.value).toBe('draft');

    field.setSelectionRange(0, 5);
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('draft');
  });

  it('starts again from the newest prompt after sending', () => {
    renderWithChatStore(chat, <ChatHarness submitted={['older prompt', 'newest prompt']} />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');

    arrow(field, 'ArrowUp');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('older prompt');

    fireEvent.submit(field.closest('form')!);
    expect(field.value).toBe('');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('newest prompt');
  });

  it('starts again when the reader moves to another session', () => {
    const { rerender } = renderWithChatStore(chat, <ChatHarness submitted={['older prompt', 'newest prompt']} historyKey="doc-1:session-1" />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    arrow(field, 'ArrowUp');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('older prompt');

    rerender(<ChatHarness submitted={['older prompt', 'newest prompt']} historyKey="doc-1:session-2" />);
    const moved = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    arrow(moved, 'ArrowUp');
    expect(moved.value).toBe('newest prompt');
  });
});

describe('Agent task composer recalls previous tasks', () => {
  beforeEach(() => {
    // The store lists sessions newest first, as main returns them.
    useAgentStore.setState({
      sessions: [agentSession('session-2', 'refactor the parser'), agentSession('session-1', 'add a regression test')],
    });
    useUiStore.getState().setTaskDraft('');
  });

  afterEach(() => {
    cleanup();
    useAgentStore.setState({ sessions: [] });
    useUiStore.getState().setTaskDraft('');
  });

  it('walks back through past tasks, newest first, and returns to the draft', () => {
    renderWithChatStore(chat, <AgentTaskCard activeDocument={fixtureDocument} disabled={false} />);
    const field = screen.getByTestId<HTMLTextAreaElement>('agent-task-description');
    type(field, 'unsent task');

    arrow(field, 'ArrowUp');
    expect(field.value).toBe('refactor the parser');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('add a regression test');

    arrow(field, 'ArrowDown');
    expect(field.value).toBe('refactor the parser');
    arrow(field, 'ArrowDown');
    expect(field.value).toBe('unsent task');
  });

  it('starts over when a new run begins', () => {
    renderWithChatStore(chat, <AgentTaskCard activeDocument={fixtureDocument} disabled={false} />);
    const field = screen.getByTestId<HTMLTextAreaElement>('agent-task-description');
    arrow(field, 'ArrowUp');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('add a regression test');

    // A finished run is prepended, exactly as `start` leaves the store.
    useAgentStore.setState({
      sessions: [
        agentSession('session-3', 'document the adapter'),
        agentSession('session-2', 'refactor the parser'),
        agentSession('session-1', 'add a regression test'),
      ],
    });
    // Traversal was reconciled by the edit-aware check: the newest task is what
    // the next ArrowUp offers, not the position in the old, shorter list.
    type(field, '');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('document the adapter');
  });
});

/**
 * A recall leaves the caret at the end of the recalled prompt. It used to be
 * placed one animation frame later, and that frame then overrode whatever the
 * reader did in between: typed text, a selection, another field, another book
 * or run. Frames are queued by hand here so each case acts in exactly the gap
 * a slow frame would leave, then lets every queued frame run.
 */
describe('a recalled prompt\'s deferred caret never overrides what came after it', () => {
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    frames = new Map();
    let next = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = next;
      next += 1;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    useAgentStore.setState({ sessions: [agentSession('session-1', 'short recalled text')] });
    useUiStore.getState().setTaskDraft('');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAgentStore.setState({ sessions: [] });
    useUiStore.getState().setTaskDraft('');
    resetAgentFollowUps();
  });

  function flushFrames(): void {
    const pending = [...frames.values()];
    frames.clear();
    act(() => { for (const callback of pending) callback(16); });
  }

  /** Focuses the field and recalls the newest entry, leaving its frame pending. */
  function recall(field: HTMLTextAreaElement, expected: string): void {
    field.focus();
    field.setSelectionRange(0, 0);
    arrow(field, 'ArrowUp');
    expect(field.value).toBe(expected);
  }

  const taskField = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>('agent-task-description');
  const renderTask = (): ReturnType<typeof renderWithChatStore> =>
    renderWithChatStore(chat, <AgentTaskCard activeDocument={fixtureDocument} disabled={false} />);

  it('still leaves the caret at the end of an ordinary recall', () => {
    renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    expect([field.selectionStart, field.selectionEnd]).toEqual([19, 19]);
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([19, 19]);
    expect(document.activeElement).toBe(field);
  });

  it('keeps text and caret the reader entered after the recall', () => {
    renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    fireEvent.change(field, { target: { value: 'a fresh task the reader typed' } });
    field.setSelectionRange(2, 2);
    flushFrames();
    expect(field.value).toBe('a fresh task the reader typed');
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2]);
  });

  it('keeps a selection the reader made inside the recalled text', () => {
    renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    // The reader then selects part of the recalled text.
    field.setSelectionRange(2, 5);
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 5]);
  });

  it('does not touch a field the reader has left', () => {
    renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    field.setSelectionRange(4, 4);
    const elsewhere = screen.getByRole('button', { name: /page|section|book|context/i });
    elsewhere.focus();
    flushFrames();
    expect(document.activeElement).toBe(elsewhere);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
  });

  it('does not touch a field once the composer has unmounted', () => {
    const view = renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    const place = vi.spyOn(field, 'setSelectionRange');
    view.unmount();
    flushFrames();
    expect(place).not.toHaveBeenCalled();
  });

  it('drops the pending caret when the task field moves to another book', () => {
    const view = renderTask();
    const field = taskField();
    recall(field, 'short recalled text');
    view.rerender(<AgentTaskCard activeDocument={{ ...fixtureDocument, id: 'doc-other' }} disabled={false} />);
    field.setSelectionRange(3, 3);
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3]);
  });

  it('places the caret for the latest of several quick recalls', () => {
    useAgentStore.setState({ sessions: [agentSession('session-2', 'newest task'), agentSession('session-1', 'an older, longer task')] });
    renderTask();
    const field = taskField();
    recall(field, 'newest task');
    arrow(field, 'ArrowUp');
    expect(field.value).toBe('an older, longer task');
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([21, 21]);
  });

  describe('in the follow-up field', () => {
    const detail = (id: string): AgentSessionDetail => ({
      ...agentSession(id, 'short recalled text'), events: [], artifacts: [],
    });
    const followUp = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Follow-up prompt' });

    it('places the caret after an ordinary recall', () => {
      renderWithChatStore(chat, <AgentResumeComposer session={detail('run-a')} blockedReason={null} busy={false} />);
      const field = followUp();
      recall(field, 'short recalled text');
      flushFrames();
      expect([field.selectionStart, field.selectionEnd]).toEqual([19, 19]);
    });

    it('keeps a follow-up the reader typed after the recall', () => {
      renderWithChatStore(chat, <AgentResumeComposer session={detail('run-a')} blockedReason={null} busy={false} />);
      const field = followUp();
      recall(field, 'short recalled text');
      fireEvent.change(field, { target: { value: 'continue with the tests' } });
      field.setSelectionRange(8, 8);
      flushFrames();
      expect(field.value).toBe('continue with the tests');
      expect([field.selectionStart, field.selectionEnd]).toEqual([8, 8]);
    });

    it('drops the pending caret when another run is opened', () => {
      setAgentFollowUpDraft('run-b', 'a draft kept for the other run');
      const view = renderWithChatStore(chat, <AgentResumeComposer session={detail('run-a')} blockedReason={null} busy={false} />);
      recall(followUp(), 'short recalled text');
      view.rerender(<AgentResumeComposer session={detail('run-b')} blockedReason={null} busy={false} />);
      const current = followUp();
      expect(current.value).toBe('a draft kept for the other run');
      current.focus();
      current.setSelectionRange(0, 0);
      flushFrames();
      expect([current.selectionStart, current.selectionEnd]).toEqual([0, 0]);
    });
  });

  it('keeps the chat composer\'s recall caret and a later fill', () => {
    renderWithChatStore(chat, <ChatHarness submitted={['short recalled text']} />);
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about this document');
    recall(field, 'short recalled text');
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([19, 19]);

    type(field, '');
    recall(field, 'short recalled text');
    fireEvent.change(field, { target: { value: 'my own question' } });
    field.setSelectionRange(1, 1);
    flushFrames();
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
  });
});
