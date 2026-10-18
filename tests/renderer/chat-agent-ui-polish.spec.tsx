// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';
import type { AgentProfile, AgentSession } from '@shared/types/agent';
import type { DocumentMetadata, TableOfContentsItem } from '@shared/types/document';
import { ChatHistoryView } from '../../src/renderer/features/chat/ChatHistoryView';
import { isProviderDefaultModel } from '../../src/renderer/features/chat/chat-labels';
import { AgentComposer } from '../../src/renderer/features/agent/AgentComposer';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const stylesheet = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '../../src/renderer', relativePath), 'utf8');

const codexProvider: AIProviderStatus = {
  id: 'codex',
  name: 'Codex CLI',
  available: true,
  installed: true,
  authentication: 'connected',
  version: 'test',
  errorMessage: null,
  models: [{ id: 'codex-default', name: 'ChatGPT default', contextWindow: 128_000, maxOutputTokens: 4096, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: false, hostedWebSearch: false },
};

const openRouterProvider: AIProviderStatus = {
  id: 'openrouter',
  name: 'OpenRouter',
  available: true,
  installed: true,
  authentication: 'connected',
  version: 'test',
  errorMessage: null,
  models: [{ id: 'anthropic/claude-3', name: 'Claude 3', contextWindow: 200_000, maxOutputTokens: 4096, supportsStreaming: true }],
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: false, toolFreeMode: false, hostedWebSearch: true },
};

function chatSession(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 'session-a',
    documentId: 'doc-1',
    title: 'Consensus questions',
    providerId: 'codex',
    modelId: 'codex-default',
    isArchived: false,
    messageCount: 2,
    previewText: 'How does quorum overlap work?',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as ChatSession;
}

function renderHistory(sessions: readonly ChatSession[], onOpenSession = vi.fn()) {
  const result = renderWithChatStore(chat,
    <ChatHistoryView
      sessions={sessions}
      sessionsLoaded
      activeSessionId={sessions[0]?.id ?? null}
      cleaningSessionId={null}
      providers={[codexProvider, openRouterProvider]}
      providerDiscovery="succeeded"
      error={null}
      isStreaming={false}
      canCreateSession
      onCreateSession={vi.fn()}
      onOpenProviderSettings={vi.fn()}
      onOpenSession={onOpenSession}
      onRenameSession={vi.fn(() => Promise.resolve(true))}
      onDeleteSession={vi.fn()}
    />
  );
  return { ...result, onOpenSession };
}

afterEach(() => { cleanup(); });

describe('Conversations screen polish', () => {
  it('opens the conversation from every card surface, the current card included', () => {
    const onOpenSession = vi.fn();
    const sessions = [chatSession({}), chatSession({ id: 'session-b', title: 'Second conversation' })];
    renderHistory(sessions, onOpenSession);

    // The current card used to be the one card that could not be clicked open.
    const currentOpen = screen.getByTestId('open-session-session-a');
    expect(currentOpen).toHaveAccessibleName('Open Consensus questions');
    fireEvent.click(currentOpen);
    expect(onOpenSession).toHaveBeenCalledWith('session-a');

    fireEvent.click(screen.getByTestId('open-session-session-b'));
    expect(onOpenSession).toHaveBeenCalledWith('session-b');
  });

  it('keeps the open target out of the per-card controls and out of their markup', () => {
    const onOpenSession = vi.fn();
    renderHistory([chatSession({}), chatSession({ id: 'session-b', title: 'Second conversation' })], onOpenSession);

    // Rename, Delete and the overflow menu are siblings of the open target,
    // never its descendants, so no interactive element is nested in another.
    for (const testId of ['open-session-session-a', 'open-session-session-b']) {
      const target = screen.getByTestId(testId);
      expect(target.tagName).toBe('BUTTON');
      expect(target.querySelector('button, a, input, [role="button"]')).toBeNull();
    }

    fireEvent.click(screen.getByTestId('rename-chat-session'));
    expect(onOpenSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Edit chat session title'));
    expect(onOpenSession).not.toHaveBeenCalled();
    // The inline editor replaces the open target rather than sitting under it.
    expect(screen.queryByTestId('open-session-session-a')).toBeNull();

    fireEvent.click(screen.getByTestId('session-actions-session-b'));
    fireEvent.click(screen.getByTestId('delete-session-session-b'));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('omits the model chip when the conversation is on the provider default', () => {
    renderHistory([
      chatSession({}),
      chatSession({ id: 'session-claude', modelId: 'claude-default' }),
      chatSession({ id: 'session-agy', modelId: 'antigravity-default' }),
      chatSession({ id: 'session-unset', modelId: null }),
      chatSession({ id: 'session-picked', providerId: 'openrouter', modelId: 'anthropic/claude-3' }),
    ]);

    for (const id of ['session-a', 'session-claude', 'session-agy', 'session-unset']) {
      expect(screen.queryByTestId(`session-binding-${id}`)).toBeNull();
      // The binding still reaches assistive technology beside the card.
      expect(screen.getByTestId(`session-provider-${id}`).textContent).not.toBe('');
    }

    // An explicitly selected model is still named.
    expect(screen.getByTestId('session-binding-session-picked')).toHaveTextContent('Claude 3');
  });

  it('classifies default bindings from the stored id alone', () => {
    // The `-default` ids are exercised through the model-chip rendering above.
    expect(isProviderDefaultModel(null)).toBe(true);
    expect(isProviderDefaultModel('openrouter/auto')).toBe(false);
  });

  it('drops the history caption and enlarges the provider settings glyph', async () => {
    const { container } = renderHistory([chatSession({})]);

    expect(screen.queryByTestId('chat-document-line')).toBeNull();
    expect(screen.queryByTestId('chat-session-count')).toBeNull();
    expect(container.querySelector('.chat-design-sessions-caption')).toBeNull();

    const gear = screen.getByTestId('configure-ai-providers');
    expect(gear).toHaveAccessibleName('Configure AI providers');
    // The app's own icon vocabulary at app icon size, not a text glyph.
    const icon = gear.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-icon')).toBe('display-settings');
    expect(icon?.getAttribute('width')).toBe('18');
    expect(gear.textContent).toBe('');

    const results = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa'] });
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});

describe('Composer surfaces carry the focus their borderless fields decline', () => {
  const chatCss = stylesheet('features/chat/chat-design.css');
  const agentCss = stylesheet('features/agent/agent-design.css');
  const companionCss = stylesheet('styles/companion.css');

  it('lights the whole composer shell while its prompt field has focus', () => {
    expect(companionCss).toMatch(/\.companion-composer \{[^}]*border: 1px solid var\(--border-subtle\)/);
    expect(companionCss).toMatch(
      /\.companion-composer:has\(textarea:focus\) \{ border-color: var\(--border-focus-surface\); \}/
    );
    // The frame, not the field: the prompt still declines the app-wide unlayered
    // :focus-visible outline and draws no ring of its own.
    expect(companionCss).toMatch(
      /\.companion-composer textarea:focus,\s*\n\.companion-composer textarea:focus-visible \{ outline: none; box-shadow: none; \}/
    );
    expect(chatCss).toMatch(/\.chat-design-input:focus-visible \{ outline: none/);
    // Actionable controls keep their indicator.
    expect(chatCss).toMatch(/\.chat-design button:focus-visible \{ outline: 2px solid var\(--focus-ring\)/);
  });

  it('gives Chat and both Agent composers the one shared shell, never a parallel copy', () => {
    for (const legacy of ['.agent-composer-card', '.agent-task-card:has', '.agent-follow-up {', '.chat-design-follow-up {']) {
      expect(agentCss + chatCss).not.toContain(legacy);
    }
    // Only the narrow-pane padding override remains, inside its media query.
    expect(chatCss).not.toMatch(/^\.chat-design-composer \{/m);
  });

  it('keeps the whole-card open target visible to the keyboard on the clipped current card', () => {
    // `[data-current="true"]` clips to the card box, so the shared 2px outside
    // ring would be cut away there; the target draws its ring inside instead.
    expect(chatCss).toMatch(/\.chat-design-card\[data-current="true"\] \{[^}]*overflow: hidden/);
    expect(chatCss).toMatch(
      /\.chat-design button\.chat-design-card-open:focus-visible \{ outline: 2px solid var\(--focus-ring\); outline-offset: -3px; \}/
    );
  });
});

describe('Reader header leads with Outline and offers no library control', () => {
  const readerDocument: DocumentMetadata = {
    id: 'doc-reader', title: 'Attention Is All You Need', author: null, format: 'pdf', storageMode: 'link',
    fileSize: 10, fileMtimeMs: 10, fileHash: 'hash-reader', pageCount: 2,     folderId: null, storageHealth: 'ok', readingPosition: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    source: null,
  };

  const seedReader = (tableOfContents: readonly TableOfContentsItem[]): void => {
    const adapter = testDocumentAdapter('pdf', {
      getCurrentPage: () => 1,
      getReadingLocation: () => ({ location: { format: 'pdf', pageIndex: 0 }, progress: 0 }),
    });
    useReaderStore.setState({
      session: testReaderSession(readerDocument, { adapter }),
      currentPage: 1, pageCount: 2, zoom: 1, zoomMode: 'fit-width',
      tableOfContents, isTocOpen: false, isLoading: false, error: null,
    });
  };

  afterEach(() => { useReaderStore.setState(useReaderStore.getInitialState(), true); });

  it('makes Outline the first left-side control and keeps its contract', () => {
    seedReader([{ id: 'toc-0', title: 'Chapter 1', level: 0, location: { format: 'pdf', pageIndex: 0 }, children: [] }]);
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);

    expect(screen.queryByTestId('reader-back-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to library' })).toBeNull();

    const outline = screen.getByTestId('toggle-toc-button');
    expect(outline).toHaveAccessibleName('Toggle table of contents');
    expect(outline).toHaveAttribute('aria-pressed', 'false');

    // First control of the identity cluster — the position Library held.
    const header = screen.getByTestId('reader-header-toolbar');
    const identity = header.children[0];
    expect(identity?.firstElementChild).toBe(outline);
    // It leads the title rather than the page/display actions on the right.
    expect(identity?.contains(screen.getByTestId('reader-document-title'))).toBe(true);
    expect(identity?.contains(screen.getByTestId('next-page-button'))).toBe(false);
    // The compact tier still collapses its label to the icon alone.
    expect([...outline.querySelectorAll('span')].some((s) => s.className.includes('@max-[920px]:hidden'))).toBe(true);

    // Keyboard activation still toggles, and the active state still shows.
    fireEvent.click(outline);
    expect(useReaderStore.getState().isTocOpen).toBe(true);
  });

  it('leaves the Outline keyboard outline room to be drawn', () => {
    seedReader([{ id: 'toc-0', title: 'Chapter 1', level: 0, location: { format: 'pdf', pageIndex: 0 }, children: [] }]);
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);

    // The app-wide indicator is a 2px ring 2px outside the button box, so any
    // clipping ancestor between the button and the header would cut it away.
    expect(screen.getByTestId('toggle-toc-button').closest('.overflow-hidden')).toBeNull();
    // The clip that keeps the right-side controls on screen still exists — it
    // belongs to the title, which is the part that has to give width up.
    const title = screen.getByTestId('reader-document-title');
    expect(title.closest('.overflow-hidden')).not.toBeNull();
    expect(title.className).toContain('truncate');
  });

  it('renders Outline only when the document has a table of contents', () => {
    seedReader([]);
    renderWithChatStore(chat, <ReaderHeaderToolbar hidden={false} />);
    expect(screen.queryByTestId('toggle-toc-button')).toBeNull();
    // There is still no format badge beside the title.
    expect(screen.queryByTestId('reader-format-badge')).toBeNull();
  });
});

const fixtureDocument: DocumentMetadata = {
  id: 'doc-agent', title: 'Agent Fixture', author: null, format: 'pdf', storageMode: 'link',
  fileSize: 10, fileMtimeMs: 10, fileHash: 'hash-agent', pageCount: 2,   folderId: null, storageHealth: 'ok', readingPosition: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  source: null,
};

const agentProfile: AgentProfile = {
  id: 'profile-polish', providerId: 'fake', name: 'Polish Profile', defaultModel: null, availableModels: [],
  reasoningEffort: null, defaultSandboxMode: 'isolated-copy',
  capabilities: {
    structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
    modelSelection: false, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  detection: { availability: 'installed', version: 'test', checkedAt: '2026-09-01T00:00:00.000Z', errorMessage: null },
  isCustom: false, unsafe: false,
};

const pastSession: AgentSession = {
  id: 'session-past', documentId: fixtureDocument.id, profileId: agentProfile.id, providerId: 'fake',
  targetDirectory: { handle: 'handle-past', displayName: 'past-workspace' }, executionMode: 'isolated-copy',
  status: 'completed', providerSessionId: 'provider-past', userPrompt: 'Earlier run',
  contextSummary: null, finalReport: null, effectiveModel: null, effectiveReasoningEffort: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:01:00.000Z',
  eventCount: 0, environment: null,
};

describe('Agent session panels dismiss on an outside press', () => {
  beforeEach(() => {
    stubBridge({
      agent: {
        listProfiles: vi.fn(() => Promise.resolve([agentProfile])),
        listSessions: vi.fn(() => Promise.resolve([pastSession])),
        getSession: vi.fn(() => Promise.resolve(null)),
        getModeAvailability: vi.fn(() => Promise.resolve([])),
        onEvent: vi.fn(() => () => undefined),
      },
    });
    useReaderStore.setState({ session: testReaderSession(fixtureDocument) });
    useAgentStore.setState({ profiles: [agentProfile], selectedProfileId: agentProfile.id, hydrated: true, sessions: [pastSession] });
  });

  afterEach(() => {
    cleanup();
    useReaderStore.setState({ session: null });
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    useUiStore.setState({ composer: { executionMode: 'auto-isolated', taskDraft: '' }, loadedSettings: null });
  });

  it('closes the header session panel on an outside press without taking focus back', async () => {
    renderWithChatStore(chat, <AgentComposer />);
    await screen.findByTestId('agent-context-section');

    const list = screen.getByTestId('agent-session-list');
    const trigger = within(list).getByRole('button', { name: 'All sessions' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // A press inside the panel is not an outside press.
    fireEvent.pointerDown(within(list).getByRole('list', { name: 'All agent sessions' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // The press lands on another control, which keeps the focus it receives.
    const elsewhere = screen.getByTestId('agent-task-description');
    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(elsewhere);
    // The relationship it names survives the dismissal.
    expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')).not.toBeNull();

    // Escape is the keyboard path and does restore the trigger.
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const region = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    if (region === null) throw new Error('The session chip names no region.');
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);

    // The trigger still toggles the panel itself.
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the run-header session panel on an outside press without taking focus back', async () => {
    useAgentStore.setState({
      activeSession: {
        ...pastSession, events: [], artifacts: [],
      },
      events: [{ sessionId: pastSession.id, ordinal: 0, type: 'started', timestamp: '2026-09-01T00:00:00.000Z' }],
    });
    renderWithChatStore(chat, <AgentComposer />);
    await screen.findByTestId('agent-activity-list');

    const trigger = screen.getByTestId('agent-run-menu-button');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const region = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    if (region === null) throw new Error('The overflow control names no region.');
    fireEvent.pointerDown(region);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const elsewhere = screen.getByTestId('agent-back-button');
    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(elsewhere);

    // Escape keeps restoring the trigger.
    fireEvent.click(trigger);
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });
});
