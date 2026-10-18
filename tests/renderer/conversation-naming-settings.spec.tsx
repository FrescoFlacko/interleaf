// @vitest-environment jsdom
/**
 * Settings > AI providers > Conversation naming.
 *
 * The section only edits a settings value. These tests assert what is offered
 * and what is saved; choosing a provider must never save anything until a model
 * is chosen, and a saved choice that is no longer available must stay visible
 * rather than be swapped for another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ConversationNamingSection } from '../../src/renderer/features/chat/ConversationNamingSection';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import type { AIProviderStatus } from '@shared/types/ai';
import { stubBridge } from '../helpers/interleaf-api';
import { chooseValue, optionNames, optionValues } from '../helpers/listbox-select';

afterEach(cleanup);

function settingsWith(conversationNaming: AppSettings['ai']['conversationNaming']): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ai: { ...DEFAULT_APP_SETTINGS.ai, conversationNaming } };
}

function status(id: AIProviderStatus['id'], overrides: Partial<AIProviderStatus> = {}): AIProviderStatus {
  return {
    id,
    name: id,
    available: true,
    installed: true,
    authentication: 'connected',
    version: null,
    errorMessage: null,
    models: [
      { id: `${id}-small`, name: `${id} small`, contextWindow: 8_000, maxOutputTokens: 512, supportsStreaming: true },
      { id: `${id}-large`, name: `${id} large`, contextWindow: 64_000, maxOutputTokens: 4_096, supportsStreaming: true },
    ],
    capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
    ...overrides,
  };
}

function renderSection(overrides: Partial<Parameters<typeof ConversationNamingSection>[0]> = {}) {
  const onSettingsChange = vi.fn<(next: AppSettings) => void>();
  const listOpenRouterModels = vi.fn(() => Promise.resolve([
    { id: 'vendor/tiny', name: 'Vendor Tiny', contextWindow: 8_000, maxOutputTokens: 256, supportsStreaming: true },
  ]));
  stubBridge({ ai: { listOpenRouterModels } });
  const props = {
    settings: DEFAULT_APP_SETTINGS,
    onSettingsChange,
    providers: [
      status('local'),
      status('claude'),
      status('openrouter', { models: [] }),
      status('cursor', { available: false }),
      status('pi', { capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: false, toolFreeMode: false, hostedWebSearch: false } }),
    ],
    providersReady: true,
    settingsReady: true,
    ...overrides,
  };
  const view = render(<ConversationNamingSection {...props} />);
  return { onSettingsChange, listOpenRouterModels, props, view };
}

const providerSelect = (): HTMLElement => screen.getByTestId('conversation-naming-provider');
const modelSelect = (): HTMLElement => screen.getByTestId('conversation-naming-model');

describe('Conversation naming settings', () => {
  it('is Automatic by default and offers only providers ready for Reader Chat', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Conversation naming' })).toBeTruthy();
    expect(screen.getByText(/excerpt of the first question/u).textContent).toMatch(/charged under that provider/u);
    expect(providerSelect().textContent).toContain('Automatic');
    expect(screen.getByTestId('conversation-naming-note').textContent).toMatch(/small model from each conversation's own provider/u);
    expect(providerSelect().getAttribute('aria-describedby')).toBe('conversation-naming-note');
    expect(screen.queryByTestId('conversation-naming-model')).toBeNull();
    expect(optionValues(providerSelect())).toEqual(['auto', '', 'local', 'claude', 'openrouter']);
  });

  it('saves nothing when a provider is chosen, then saves the exact model chosen', () => {
    const { onSettingsChange } = renderSection();
    chooseValue(providerSelect(), 'claude');
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('conversation-naming-note').textContent).toBe('Choose a model to name with it.');

    chooseValue(modelSelect(), 'claude-small');
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const next = onSettingsChange.mock.calls[0]?.[0];
    expect(next?.ai.conversationNaming).toEqual({ providerId: 'claude', modelId: 'claude-small' });
    // Every unrelated setting is carried through unchanged.
    expect({ ...next, ai: { ...next?.ai, conversationNaming: 'auto' } }).toEqual(DEFAULT_APP_SETTINGS);
  });

  it.each<[string, AppSettings['ai']['conversationNaming']]>([['', null], ['auto', 'auto']])(
    'saves %j from an explicit model, and nothing for the mode already saved',
    (value, mode) => {
      const { onSettingsChange, props, view } = renderSection({ settings: settingsWith({ providerId: 'local', modelId: 'local-small' }) });
      expect(modelSelect().textContent).toContain('local small');
      chooseValue(providerSelect(), value);
      expect(onSettingsChange.mock.calls.map(([next]) => next.ai.conversationNaming)).toEqual([mode]);
      view.rerender(<ConversationNamingSection {...props} settings={settingsWith(mode)} />);
      chooseValue(providerSelect(), value);
      expect(onSettingsChange).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a saved binding that is no longer available visible and changeable', () => {
    const { onSettingsChange } = renderSection({ settings: settingsWith({ providerId: 'cursor', modelId: 'retired-model' }) });
    expect(providerSelect().textContent).toContain('Cursor (unavailable)');
    expect(modelSelect().textContent).toContain('retired-model (unavailable)');
    expect(screen.getByTestId('conversation-naming-note').textContent).toMatch(/not available right now/u);
    expect(onSettingsChange).not.toHaveBeenCalled();

    chooseValue(providerSelect(), 'local');
    chooseValue(modelSelect(), 'local-large');
    expect(onSettingsChange.mock.calls[0]?.[0].ai.conversationNaming).toEqual({ providerId: 'local', modelId: 'local-large' });
  });

  it('lists the OpenRouter catalog once OpenRouter is chosen', async () => {
    const { onSettingsChange, listOpenRouterModels } = renderSection();
    expect(listOpenRouterModels).not.toHaveBeenCalled();
    chooseValue(providerSelect(), 'openrouter');
    await vi.waitFor(() => { expect(optionNames(modelSelect())).toContain('Vendor Tiny'); });
    expect(listOpenRouterModels).toHaveBeenCalledTimes(1);
    chooseValue(modelSelect(), 'vendor/tiny');
    expect(onSettingsChange.mock.calls[0]?.[0].ai.conversationNaming).toEqual({ providerId: 'openrouter', modelId: 'vendor/tiny' });
  });

  it('offers nothing to choose until settings and provider checks are ready', () => {
    renderSection({ settingsReady: false, providersReady: false });
    expect(providerSelect().hasAttribute('disabled')).toBe(true);
  });

  it('has no detectable accessibility violations', async () => {
    renderSection({ settings: settingsWith({ providerId: 'local', modelId: 'local-small' }) });
    const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
