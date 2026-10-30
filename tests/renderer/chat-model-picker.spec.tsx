// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { ChatModelPicker } from '../../src/renderer/features/chat/ChatModelPicker';
import { isProviderReady } from '../../src/renderer/stores/chat/provider-readiness';
import { stubBridge } from '../helpers/interleaf-api';

function model(id: string, name = id): AIModelInfo {
  return { id, name, contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true };
}

const capabilities = { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false };

const fakeProvider: AIProviderStatus = {
  id: 'fake',
  name: 'Deterministic Test Provider',
  available: true,
  installed: true,
  authentication: 'connected',
  version: '1.0',
  errorMessage: null,
  models: [model('fake-grounded', 'Deterministic Grounded Model'), model('fake-fast', 'Deterministic Fast Model')],
  capabilities,
};

const claude: AIProviderStatus = {
  ...fakeProvider,
  id: 'claude',
  name: 'Claude Code',
  models: [model('claude-default', 'Claude Code default'), model('claude-opus-5-5', 'Claude Opus 5.5')],
};

/** Codex is listed from main's runtime catalog, with its constrained path. */
const codex: AIProviderStatus = {
  ...fakeProvider,
  id: 'codex',
  name: 'Codex CLI',
  models: [model('codex-default', 'Codex default'), model('gpt-6-sol', 'GPT-6 Sol')],
  capabilities: { ...capabilities, subscriptionAuth: true, toolFreeMode: false },
};

const openRouter: AIProviderStatus = {
  ...fakeProvider,
  id: 'openrouter',
  name: 'OpenRouter',
  models: [model('openrouter/auto', 'OpenRouter Auto')],
  capabilities: { ...capabilities, apiKeyAuth: true, persistentSessions: false },
};

/** A fake catalog, larger than the default, as main's listing would return it. */
const catalog: AIModelInfo[] = [
  model('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5'),
  model('google/gemini-3-pro', 'Google: Gemini 3 Pro'),
  ...Array.from({ length: 40 }, (_, index) => model(`vendor/model-${String(index)}`, `Vendor Model ${String(index)}`)),
];

type Props = Parameters<typeof ChatModelPicker>[0];

function renderPicker(overrides: Partial<Props> = {}) {
  const onSelectModel = vi.fn();
  const onOpenProviderSettings = vi.fn();
  const providers = overrides.providers ?? [fakeProvider, claude, codex];
  const props: Props = {
    providers,
    readyProviders: providers.filter(isProviderReady),
    discovery: 'succeeded',
    currentProviderId: 'fake',
    currentModelId: 'fake-grounded',
    currentReasoningEffort: null,
    currentProviderReady: true,
    openRouterConfiguredModel: null,
    disabled: false,
    settingsOpen: false,
    onSelectModel,
    onOpenProviderSettings,
    ...overrides,
  };
  const view = render(<ChatModelPicker {...props} />);
  return { ...view, props, onSelectModel, onOpenProviderSettings };
}

const trigger = (): HTMLElement => screen.getByTestId('chat-model-picker');
const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search models and providers' });
const optionIds = (): string[] =>
  screen.queryAllByRole('option').map((option) => `${option.dataset.providerId ?? ''}:${option.dataset.modelId ?? ''}`);
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatModelPicker trigger', () => {
  it('names the model first and the provider second, once each', () => {
    renderPicker();
    expect(trigger()).toHaveTextContent('Deterministic Grounded Model');
    expect(trigger()).toHaveTextContent('Deterministic Test Provider');
    expect(trigger()).toHaveAccessibleName('AI model: Deterministic Grounded Model, Deterministic Test Provider');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not repeat a provider the model name already names', () => {
    renderPicker({ currentProviderId: 'claude', currentModelId: 'claude-default' });
    expect(trigger()).toHaveAccessibleName('AI model: Claude Code default');
    expect(trigger().querySelector('.chat-model-trigger-provider')).toBeNull();
  });

  it('labels an Auto binding as the Settings default when Settings names a model', () => {
    renderPicker({
      providers: [openRouter],
      currentProviderId: 'openrouter',
      currentModelId: 'openrouter/auto',
      openRouterConfiguredModel: 'anthropic/claude-sonnet-4.5',
    });
    expect(trigger()).toHaveTextContent('Settings default');
    expect(trigger()).toHaveTextContent('OpenRouter');
  });

  it('marks a bound provider unavailable only once discovery has answered', () => {
    const { rerender, props } = renderPicker({ currentProviderId: 'codex', currentModelId: 'gpt-6-sol', currentProviderReady: false, discovery: 'loading' });
    expect(trigger()).not.toHaveTextContent('Unavailable');
    rerender(<ChatModelPicker {...props} discovery="succeeded" />);
    expect(trigger()).toHaveTextContent('Unavailable');
    // The binding is still named truthfully, as plain ChatGPT.
    expect(trigger()).toHaveAccessibleName('AI model: GPT-6 Sol, ChatGPT, unavailable');
    expect(trigger()).toHaveTextContent('GPT-6 Sol');
    fireEvent.click(trigger());
    expect(screen.getByTestId('chat-model-picker-unavailable')).toHaveTextContent(/^ChatGPT is not ready\./u);
  });

  it('names a provider main has not reported instead of a blank value', () => {
    renderPicker({ providers: [], readyProviders: [], currentProviderId: 'openrouter', currentModelId: null, currentProviderReady: false });
    expect(trigger()).toHaveTextContent('OpenRouter (status unavailable)');
  });

  it('cannot be opened while chat controls are disabled', () => {
    renderPicker({ disabled: true });
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ChatModelPicker list', () => {
  it('groups ready providers with the bound model selected and passes axe', async () => {
    const { baseElement } = renderPicker();
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog', { name: 'Choose AI model' });
    expect(trigger()).toHaveAttribute('aria-controls', dialog.id);
    expect(search()).toHaveFocus();
    expect(search()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    const groups = within(dialog).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toEqual([
      'chat-model-group-fake', 'chat-model-group-claude', 'chat-model-group-codex',
    ]);
    // Codex is offered from main's runtime catalog, default first.
    expect(within(groups[2]!).getAllByRole('option').map((option) => option.dataset.modelId)).toEqual(['codex-default', 'gpt-6-sol']);
    const selected = screen.getByRole('option', { selected: true });
    expect(selected.dataset.modelId).toBe('fake-grounded');
    expect(search()).toHaveAttribute('aria-activedescendant', selected.id);

    const results = await axe.run(baseElement, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('omits providers main does not report ready', () => {
    renderPicker({
      providers: [
        fakeProvider,
        { ...claude, authentication: 'disconnected' },
        { ...codex, available: false },
        { ...fakeProvider, id: 'cursor', name: 'Cursor', capabilities: { ...capabilities, toolFreeMode: false } },
      ],
    });
    fireEvent.click(trigger());
    expect(screen.getAllByRole('group')).toHaveLength(1);
  });

  it('searches provider and model names and ids', () => {
    renderPicker();
    fireEvent.click(trigger());
    fireEvent.change(search(), { target: { value: 'claude' } });
    expect(optionIds()).toEqual(['claude:claude-default', 'claude:claude-opus-5-5']);
    fireEvent.change(search(), { target: { value: 'gpt-6' } });
    expect(optionIds()).toEqual(['codex:gpt-6-sol']);
    fireEvent.change(search(), { target: { value: 'codex sol' } });
    expect(optionIds()).toEqual(['codex:gpt-6-sol']);
    fireEvent.change(search(), { target: { value: 'chatgpt sol' } });
    expect(optionIds()).toEqual(['codex:gpt-6-sol']);
    fireEvent.change(search(), { target: { value: 'subscription' } });
    expect(optionIds()).toEqual([]);
    fireEvent.change(search(), { target: { value: 'nothing-like-this' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('No models match “nothing-like-this”.');
    expect(search()).toHaveAttribute('aria-expanded', 'false');
  });

  it('walks options with the arrows and chooses the exact pair with Enter', async () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(trigger());
    const active = (): string | undefined =>
      document.getElementById(search().getAttribute('aria-activedescendant') ?? '')?.dataset.modelId;
    // Display order puts Fast before the bound Grounded model; the walk starts there.
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(active()).toBe('claude-default');
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(active()).toBe('claude-opus-5-5');
    fireEvent.keyDown(search(), { key: 'PageUp' });
    expect(active()).toBe('fake-fast');
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    fireEvent.keyDown(search(), { key: 'PageDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });

    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-6-sol', null);
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    expect(trigger()).toHaveFocus();
  });

  it('ignores Enter while an IME composition is open', () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(trigger());
    fireEvent.keyDown(search(), { key: 'Enter', isComposing: true });
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('chooses a cross-provider row by pointer in one call', () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(trigger());
    const row = screen.getAllByRole('option').find((option) => option.dataset.modelId === 'claude-opus-5-5')!;
    fireEvent.click(row);
    expect(onSelectModel.mock.calls).toEqual([['claude', 'claude-opus-5-5', null]]);
    expect(trigger()).toHaveFocus();
  });

  it('treats re-choosing the bound row as a dismissal', () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(trigger());
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape without letting the key reach the drawer, then restores focus', async () => {
    const { onSelectModel } = renderPicker();
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(search(), { key: 'Escape' });
    document.removeEventListener('keydown', outer);

    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelectModel).not.toHaveBeenCalled();
    await flush();
    expect(trigger()).toHaveFocus();
  });

  it('closes on an outside pointer press without rebinding', () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('returns focus to the trigger after a binding write disables it', async () => {
    const { rerender, props } = renderPicker();
    fireEvent.click(trigger());
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    trigger().blur();
    rerender(<ChatModelPicker {...props} disabled />);
    rerender(<ChatModelPicker {...props} disabled={false} />);
    await waitFor(() => { expect(trigger()).toHaveFocus(); });
  });

  it('keeps Manage providers reachable, even with nothing ready, and never rebinds', () => {
    const { onSelectModel, onOpenProviderSettings } = renderPicker({ readyProviders: [], currentProviderReady: false });
    fireEvent.click(trigger());
    expect(screen.getByTestId('chat-model-picker-unavailable')).toHaveTextContent('Deterministic Test Provider is not ready');
    expect(screen.getByRole('status')).toHaveTextContent('No AI provider is ready.');
    fireEvent.click(screen.getByTestId('chat-provider-edit'));
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it('says discovery is still running rather than that nothing is ready', () => {
    renderPicker({ readyProviders: [], discovery: 'loading', currentProviderReady: false });
    fireEvent.click(trigger());
    expect(screen.getByRole('status')).toHaveTextContent('Checking AI providers…');
    expect(screen.queryByTestId('chat-model-picker-unavailable')).toBeNull();
  });
});

describe('ChatModelPicker with OpenRouter', () => {
  const props = { providers: [fakeProvider, openRouter], currentProviderId: 'openrouter' as const, currentModelId: 'openrouter/auto' };

  it('lists main’s catalog when opened and binds an exact id beyond the default', async () => {
    const listOpenRouterModels = vi.fn(() => Promise.resolve(catalog));
    stubBridge({ ai: { listOpenRouterModels } });
    const { onSelectModel } = renderPicker(props);
    expect(listOpenRouterModels).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    expect(listOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('chat-model-picker-loading')).toHaveTextContent('Loading OpenRouter models…');
    await waitFor(() => { expect(screen.queryByTestId('chat-model-picker-loading')).toBeNull(); });

    // Auto leads; the long catalog is in the bounded, scrolling list.
    expect(optionIds().filter((id) => id.startsWith('openrouter:'))).toHaveLength(catalog.length + 1);
    expect(optionIds()).toContain('openrouter:openrouter/auto');
    fireEvent.change(search(), { target: { value: 'sonnet' } });
    expect(optionIds()).toEqual(['openrouter:anthropic/claude-sonnet-4.5']);
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelectModel.mock.calls).toEqual([['openrouter', 'anthropic/claude-sonnet-4.5', null]]);
  });

  it('keeps a saved id the catalog dropped as an unavailable, unchoosable row', async () => {
    stubBridge({ ai: { listOpenRouterModels: vi.fn(() => Promise.resolve(catalog)) } });
    const { onSelectModel } = renderPicker({ ...props, currentModelId: 'retired/model-x' });
    expect(trigger()).toHaveTextContent('retired/model-x');
    fireEvent.click(trigger());
    await waitFor(() => { expect(screen.queryByTestId('chat-model-picker-loading')).toBeNull(); });

    const saved = screen.getAllByRole('option').find((option) => option.dataset.modelId === 'retired/model-x')!;
    expect(saved).toHaveAttribute('aria-disabled', 'true');
    expect(saved).toHaveTextContent('Unavailable');
    fireEvent.click(saved);
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent('retired/model-x');
  });

  it('reports a failed listing with a retry and substitutes nothing', async () => {
    const listOpenRouterModels = vi.fn<() => Promise<AIModelInfo[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(catalog);
    stubBridge({ ai: { listOpenRouterModels } });
    const { onSelectModel } = renderPicker({ ...props, currentModelId: 'retired/model-x' });
    fireEvent.click(trigger());

    const error = await screen.findByTestId('chat-model-picker-catalog-error');
    expect(error).toHaveTextContent('Couldn’t load OpenRouter models.');
    // Not known to be unavailable while the catalog is unknown.
    const saved = screen.getAllByRole('option').find((option) => option.dataset.modelId === 'retired/model-x')!;
    expect(saved).not.toHaveAttribute('aria-disabled');
    expect(onSelectModel).not.toHaveBeenCalled();

    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(listOpenRouterModels).toHaveBeenLastCalledWith({ forceRefresh: true });
    await waitFor(() => { expect(screen.queryByTestId('chat-model-picker-catalog-error')).toBeNull(); });
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('never asks main for a catalog when OpenRouter is not ready', () => {
    const listOpenRouterModels = vi.fn(() => Promise.resolve(catalog));
    stubBridge({ ai: { listOpenRouterModels } });
    renderPicker({ providers: [fakeProvider, { ...openRouter, authentication: 'disconnected' }] });
    fireEvent.click(trigger());
    expect(listOpenRouterModels).not.toHaveBeenCalled();
  });
});
