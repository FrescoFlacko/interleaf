// @vitest-environment jsdom
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { AIProviderStatus, ChatContextItem, ChatSession } from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { ChatComposer } from '../../src/renderer/features/chat/ChatComposer';
import { ChatContextBar } from '../../src/renderer/features/chat/ChatContextBar';
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
 * The composer with several page ranges attached.
 *
 * Reported symptom: once a handful of page chips are pinned, the controls under
 * them stop lining up. Two causes are covered here — the chip row has to wrap
 * and bound itself rather than push the panel sideways, and the control row has
 * to give each control its own intrinsic width rather than reserve a slot that
 * paints one of them wider than its label.
 *
 * jsdom does no layout, so these assertions hold the rules and the structure
 * that produce the layout; the pixels are checked in the real window by
 * `tests/e2e/chat-multi-context-layout.spec.ts`.
 */

const chatStylesheet = readFileSync(
  resolve(__dirname, '../../src/renderer/features/chat/chat-design.css'),
  'utf8'
);

/** The declarations of a rule, whitespace collapsed. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const body = new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(chatStylesheet)?.[1];
  expect(body, `expected a rule for ${selector}`).toBeDefined();
  return (body ?? '').replace(/\s+/gu, ' ').trim();
}

const session: ChatSession = {
  id: 'session-1',
  documentId: 'doc-1',
  documentHash: 'a'.repeat(64),
  title: 'Chat',
  providerId: 'claude',
  modelId: 'claude-opus-5',
  reasoningEffort: null,
  messageCount: 4,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

const activeDocument: DocumentMetadata = {
  id: 'doc-1',
  title: 'Architecture Guide',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 10,
  fileMtimeMs: 1,
  fileHash: 'a'.repeat(64),
  pageCount: 400,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  source: null,
};

function pageRange(id: string, displayLabel: string): ChatContextItem {
  return {
    id,
    sessionId: session.id,
    documentHash: 'a'.repeat(64),
    kind: 'range',
    sourceRef: {},
    excerptText: 'text',
    excerptHash: 'b'.repeat(64),
    location: { format: 'pdf', pageIndex: 11 },
    provenance: {},
    displayLabel,
    pinned: true,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
}

/** Six pinned page ranges, the reported shape of the defect. */
const pageRanges: readonly ChatContextItem[] = [
  pageRange('ctx-1', 'Pages 12–14'),
  pageRange('ctx-2', 'Pages 48–52'),
  pageRange('ctx-3', 'Pages 101–103'),
  pageRange('ctx-4', 'Pages 188–190'),
  pageRange('ctx-5', 'Pages 244–249'),
  pageRange('ctx-6', 'Pages 377–380 of the appendix tables'),
];

/** A provider with a short name — the case that used to leave a dead gap. */
const shortNameProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Omp',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  models: [
    { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsStreaming: true },
    { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 400_000, maxOutputTokens: 32_000, supportsStreaming: true },
  ],
};

function renderComposerWithContext(): void {
  renderWithChatStore(chat,
    <ChatComposer
      draft=""
      placeholder="Ask about this document"
      composerRef={createRef<HTMLTextAreaElement>()}
      composerDisabled={false}
      providers={[shortNameProvider]}
      readyProviders={[shortNameProvider]}
      providerDiscovery="succeeded"
      openRouterConfiguredModel={null}
      currentProviderId="fake"
      currentProviderReady
      currentModelId="google/gemini-3.8-flash"
      currentReasoningEffort={null}
      controlsDisabled={false}
      settingsOpen={false}
      isStreaming={false}
      canSend
      activeSession={session}
      contextItems={pageRanges}
      cleanContext={{
        control: { present: true, canClean: false, isCleaning: false, contextMutationsDisabled: false, target: 'the current provider' },
        onClean: vi.fn(() => Promise.resolve(false)),
      }}
      webSearchSupported={false}
      webSearchEnabled={false}
      onWebSearchChange={vi.fn()}
      submittedPrompts={[]}
      promptHistoryKey="doc-1:session-1"
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onSelectModel={vi.fn()}
      onOpenProviderSettings={vi.fn()}
      onStop={vi.fn()}
      context={(
        <ChatContextBar
          activeDocument={activeDocument}
          currentPage={12}
          explicitLocation={null}
          activeSession={session}
          contextItems={pageRanges}
          disabled={false}
          addEntireDocument={vi.fn(() => Promise.resolve(true))}
          addPageRange={vi.fn(() => Promise.resolve(true))}
          removeContext={vi.fn(() => Promise.resolve())}
        />
      )}
    />
  );
}

describe('chat composer with several attached page contexts', () => {
  afterEach(() => { cleanup(); });

  it('keeps every chip in one wrapping, bounded row', () => {
    renderComposerWithContext();
    const list = screen.getByTestId('chat-context-list');
    expect(screen.getByTestId('chat-context-summary')).toHaveTextContent('Context · 6 items');
    // The context row sits inside the composer card, above the field.
    expect(screen.getByTestId('chat-context-bar').nextElementSibling?.querySelector('#chat-composer')).not.toBeNull();

    // All six are present and removable: none is dropped or clipped away by
    // count, and the row grows downward into its own scroll instead.
    for (const item of pageRanges) {
      expect(within(list).getByTitle(item.displayLabel)).toBeInTheDocument();
      expect(within(list).getByRole('button', { name: `Remove ${item.displayLabel} from AI context` })).toBeInTheDocument();
    }
    expect(list).toHaveAttribute('data-context-list-layout', 'wrapping-chips');

    const chips = rule('.chat-design-chips');
    expect(chips).toContain('flex-wrap: wrap');
    expect(chips).toContain('max-height: 130px');
    expect(chips).toContain('overflow-y: auto');
    // Never sideways: a horizontal scroller here would hide attached context.
    expect(chips).not.toContain('overflow-x');
    expect(chips).not.toContain('nowrap');
  });

  it('wraps the tool row instead of scrolling it, with Send pinned right', () => {
    renderComposerWithContext();

    const picker = screen.getByTestId('chat-model-picker');
    const row = picker.parentElement!;
    expect(row.className).toBe('chat-design-controls');
    expect(Array.from(row.children).map((child) => child.getAttribute('data-testid'))).toEqual([
      'chat-model-picker', 'chat-context-budget', 'send-chat-button',
    ]);

    // A wrapping row: nothing reachable only through a hidden scrollbar.
    const controls = rule('.chat-design-controls');
    expect(controls).toContain('flex-wrap: wrap');
    expect(controls).not.toContain('overflow');
    expect(chatStylesheet).not.toContain('chat-design-toolbar');
    expect(chatStylesheet).not.toMatch(/scrollbar-width:\s*none/u);

    // The picker takes the spare width and ellipsizes its model name; a short
    // name such as "Omp" gets no reserved slot and no floor that would clip it.
    expect(rule('.chat-model-trigger')).toContain('min-width: 0');
    expect(rule('.chat-model-trigger-model')).toContain('text-overflow: ellipsis');
    expect(rule('.chat-design-send')).toContain('margin-left: auto');
  });
});
