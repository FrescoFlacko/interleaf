// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { AIProviderStatus } from '@shared/types/ai';
import { ChatComposer } from '../../src/renderer/features/chat/ChatComposer';
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
 * The composer's tool row: one model picker carrying provider and model
 * together, quiet Send and Stop, and nothing reserved for absent controls.
 */

const fakeProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: true, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  models: [
    { id: 'model-a', name: 'Model A', contextWindow: 8_000, maxOutputTokens: 2_000, supportsStreaming: true },
    { id: 'model-b', name: 'Model B', contextWindow: 16_000, maxOutputTokens: 4_000, supportsStreaming: true },
  ],
};

/** Canonical display labels win over the transport name, so this reads "Claude Code". */
const otherProvider: AIProviderStatus = {
  ...fakeProvider,
  id: 'claude',
  name: 'Claude Code',
  models: [
    { id: 'other-only', name: 'Other Only Model', contextWindow: 1_000, maxOutputTokens: 500, supportsStreaming: true },
  ],
};

type Overrides = Partial<Parameters<typeof ChatComposer>[0]>;

function renderComposer(overrides?: Overrides): {
  readonly onSelectModel: ReturnType<typeof vi.fn>;
  readonly onSubmit: ReturnType<typeof vi.fn>;
  readonly onStop: ReturnType<typeof vi.fn>;
} {
  const onSelectModel = vi.fn();
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  renderWithChatStore(chat,
    <ChatComposer
      draft=""
      placeholder="Ask about this document"
      shelf={null}
      addContext={null}
      composerRef={createRef<HTMLTextAreaElement>()}
      composerDisabled={false}
      providers={[fakeProvider, otherProvider]}
      readyProviders={[fakeProvider, otherProvider]}
      providerDiscovery="succeeded"
      currentProviderId="fake"
      currentProviderReady
      currentModelId="model-a"
      currentReasoningEffort={null}
      openRouterConfiguredModel={null}
      controlsDisabled={false}
      settingsOpen={false}
      isStreaming={false}
      canSend
      webSearchSupported={false}
      webSearchEnabled={false}
      onWebSearchChange={vi.fn()}
      submittedPrompts={[]}
      promptHistoryKey="doc-1:session-1"
      onDraftChange={vi.fn()}
      onSubmit={onSubmit}
      onSelectModel={onSelectModel}
      onOpenProviderSettings={vi.fn()}
      onStop={onStop}
      {...overrides}
    />
  );
  return { onSelectModel, onSubmit, onStop };
}

describe('composer tool row', () => {
  afterEach(() => { cleanup(); });

  it('offers one model control, with no separate provider or model menus', () => {
    renderComposer();
    const picker = screen.getByTestId('chat-model-picker');
    expect(picker).toHaveAccessibleName('AI model: Model A, Deterministic Test Provider');
    expect(screen.queryByLabelText('AI provider')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('chat-provider-select')).toBeNull();
  });

  it('shows a one-model provider once, still as the picker', () => {
    const singleModel: AIProviderStatus = { ...otherProvider };
    renderComposer({ providers: [singleModel], readyProviders: [singleModel], currentProviderId: 'claude', currentModelId: 'other-only' });
    expect(screen.getByTestId('chat-model-picker')).toHaveAccessibleName('AI model: Other Only Model, Claude Code');
  });

  it('reserves no slot for controls this conversation does not have', () => {
    renderComposer({ webSearchSupported: false });
    const row = screen.getByTestId('chat-model-picker').closest('.chat-design-controls');
    expect(row).not.toBeNull();
    expect(screen.queryByTestId('chat-web-search-toggle')).toBeNull();
    expect(screen.queryByTestId('chat-context-budget')).toBeNull();
    expect(Array.from(row!.children).map((child) => child.getAttribute('data-testid'))).toEqual(['chat-model-picker', 'send-chat-button']);
  });

  it('hands a cross-provider choice over in one call with the exact model', () => {
    const { onSelectModel } = renderComposer();
    fireEvent.click(screen.getByTestId('chat-model-picker'));
    fireEvent.click(screen.getAllByRole('option').find((option) => option.dataset.modelId === 'other-only')!);
    expect(onSelectModel.mock.calls).toEqual([['claude', 'other-only', null]]);
  });

  it('labels Send and Stop by name and keeps Send disabled until it can act', () => {
    const { onSubmit } = renderComposer({ canSend: false });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('type', 'submit');
    fireEvent.submit(send.closest('form')!);
    // The form handler still reports; the store refuses an empty or unready turn.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    cleanup();

    const streaming = renderComposer({ isStreaming: true });
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('data-tone', 'stop');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(stop);
    expect(streaming.onStop).toHaveBeenCalledTimes(1);
  });

  it('sends on Enter, inserts a newline on Shift+Enter, and never sends mid-composition', () => {
    const { onSubmit } = renderComposer({ draft: 'Hello' });
    const field = screen.getByLabelText('Message Reader AI');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disables the picker while the session is busy, and keeps it operable when the provider is not ready', () => {
    renderComposer({ controlsDisabled: true });
    expect(screen.getByTestId('chat-model-picker')).toBeDisabled();
    cleanup();

    // An unready provider is swapped out through the same picker.
    renderComposer({ currentProviderReady: false, readyProviders: [otherProvider] });
    const picker = screen.getByTestId('chat-model-picker');
    expect(picker).not.toBeDisabled();
    expect(picker).toHaveTextContent('Unavailable');
    fireEvent.click(picker);
    expect(screen.getAllByRole('option').map((option) => option.dataset.providerId)).toEqual(['claude']);
  });
});
