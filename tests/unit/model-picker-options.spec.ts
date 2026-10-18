import { describe, expect, it } from 'vitest';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import {
  filterGroups,
  flatRows,
  openRouterRows,
  pickerGroups,
  triggerLabel,
  type OpenRouterPickerSource,
} from '../../src/renderer/features/chat/model-picker-options';

function model(id: string, name = id): AIModelInfo {
  return { id, name, contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true };
}

function provider(id: AIProviderStatus['id'], name: string, models: AIModelInfo[]): AIProviderStatus {
  return {
    id, name, models, available: true, installed: true, authentication: 'connected', version: null, errorMessage: null,
    capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
  };
}

const idle: OpenRouterPickerSource = { state: 'idle', models: [], configuredModel: null };
const listed: OpenRouterPickerSource = {
  state: 'ready',
  models: [model('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5'), model('openai/gpt-5', 'OpenAI: GPT-5')],
  configuredModel: null,
};

describe('openRouterRows', () => {
  it('leads with Auto and keeps every listed id exact', () => {
    const rows = openRouterRows(listed, null);
    expect(rows.map((row) => row.modelId)).toEqual(['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5']);
    expect(rows[0]).toMatchObject({ name: 'OpenRouter Auto', detail: 'openrouter/auto', unavailable: false });
    // A name that only restates its id carries no second, mono line.
    expect(rows[1]).toMatchObject({ name: 'Anthropic: Claude Sonnet 4.5', detail: null });
    const named = openRouterRows({ ...listed, models: [model('google/gemini-3-pro-preview', 'Gemini 3 Pro')] }, null);
    expect(named[1]).toMatchObject({ name: 'Gemini 3 Pro', detail: 'google/gemini-3-pro-preview' });
  });

  it('names Auto as the Settings default when Settings configures a model', () => {
    const rows = openRouterRows({ ...listed, configuredModel: 'openai/gpt-5' }, 'openrouter/auto');
    expect(rows[0]).toMatchObject({ modelId: 'openrouter/auto', name: 'Settings default', detail: 'openai/gpt-5' });
  });

  it('keeps bound and configured ids the catalog lacks, unavailable only once it has answered', () => {
    const source = { ...listed, configuredModel: 'gone/configured' };
    const ready = openRouterRows(source, 'gone/bound');
    expect(ready.filter((row) => row.unavailable).map((row) => row.modelId).sort()).toEqual(['gone/bound', 'gone/configured']);

    for (const state of ['idle', 'loading', 'error'] as const) {
      const unknown = openRouterRows({ ...source, state }, 'gone/bound');
      expect(unknown.some((row) => row.modelId === 'gone/bound')).toBe(true);
      expect(unknown.some((row) => row.unavailable)).toBe(false);
    }
  });
});

describe('pickerGroups and filterGroups', () => {
  const groups = pickerGroups(
    [
      provider('claude', 'Claude Code', [model('claude-default', 'Claude Code default'), model('claude-opus-5-5', 'Claude Opus 5.5')]),
      provider('codex', 'Codex CLI', [model('gpt-6-sol', 'GPT-6 Sol')]),
      provider('openrouter', 'OpenRouter', [model('openrouter/auto', 'OpenRouter Auto')]),
    ],
    listed,
    { providerId: 'claude', modelId: 'claude-opus-5-5' }
  );

  it('makes one group per ready provider, in main’s order, with distinct row keys', () => {
    expect(groups.map((group) => group.providerId)).toEqual(['claude', 'codex', 'openrouter']);
    // Reader Chat names the codex binding plainly, never its transport CLI.
    expect(groups.map((group) => group.label)).toEqual(['Claude Code', 'ChatGPT', 'OpenRouter']);
    const keys = flatRows(groups).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => /^[A-Za-z0-9_-]+$/u.test(key))).toBe(true);
  });

  it('keeps distinct ids distinct after making them DOM-safe', () => {
    const rows = pickerGroups([provider('fake', 'Fake', [model('a/b'), model('a_b'), model('a.b')])], idle, { providerId: 'fake', modelId: null })[0]!.rows;
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it('matches every term against provider and model names and ids', () => {
    const ids = (query: string): string[] => flatRows(filterGroups(groups, query)).map((row) => row.modelId);
    expect(ids('')).toHaveLength(6);
    expect(ids('codex')).toEqual(['gpt-6-sol']);
    expect(ids('OPUS')).toEqual(['claude-opus-5-5']);
    expect(ids('anthropic/claude')).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(ids('openrouter gpt')).toEqual(['openai/gpt-5']);
    expect(ids('zzz')).toEqual([]);
    expect(filterGroups(groups, 'zzz')).toEqual([]);
  });
});

describe('triggerLabel', () => {
  const claude = provider('claude', 'Claude Code', [model('claude-opus-5-5', 'Claude Opus 5.5')]);

  it('names the model, then the provider', () => {
    expect(triggerLabel({ providerId: 'claude', providerInfo: claude, modelId: 'claude-opus-5-5', openRouter: idle }))
      .toEqual({ model: 'Claude Opus 5.5', lead: 'Claude ', provider: 'Claude Code' });
  });

  it('shows an id nothing names exactly, and a provider default as such', () => {
    expect(triggerLabel({ providerId: 'claude', providerInfo: claude, modelId: 'claude-x', openRouter: idle }).model).toBe('claude-x');
    expect(triggerLabel({ providerId: 'claude', providerInfo: claude, modelId: null, openRouter: idle }))
      .toEqual({ model: 'Claude Code default', lead: 'Claude ', provider: null });
  });

  it('names an OpenRouter catalog model from main’s listing', () => {
    const openRouter = provider('openrouter', 'OpenRouter', []);
    expect(triggerLabel({ providerId: 'openrouter', providerInfo: openRouter, modelId: 'openai/gpt-5', openRouter: listed }))
      .toEqual({ model: 'OpenAI: GPT-5', lead: '', provider: 'OpenRouter' });
    expect(triggerLabel({ providerId: 'openrouter', providerInfo: openRouter, modelId: null, openRouter: idle }))
      .toEqual({ model: 'OpenRouter Auto', lead: 'OpenRouter ', provider: null });
  });

  it('marks only a leading word that repeats the provider, never the whole name', () => {
    const codex = provider('codex', 'ChatGPT', [model('codex-default', 'ChatGPT default'), model('gpt-5.2', 'GPT-5.2')]);
    expect(triggerLabel({ providerId: 'codex', providerInfo: codex, modelId: 'codex-default', openRouter: idle }).lead).toBe('ChatGPT ');
    expect(triggerLabel({ providerId: 'codex', providerInfo: codex, modelId: 'gpt-5.2', openRouter: idle }).lead).toBe('');
    const bare = provider('claude', 'Claude Code', [model('claude', 'Claude')]);
    expect(triggerLabel({ providerId: 'claude', providerInfo: bare, modelId: 'claude', openRouter: idle }).lead).toBe('');
  });

  it('always names a provider main has not reported', () => {
    expect(triggerLabel({ providerId: 'openrouter', providerInfo: undefined, modelId: null, openRouter: idle }))
      .toEqual({ model: 'OpenRouter Auto', lead: 'OpenRouter ', provider: 'OpenRouter (status unavailable)' });
  });
});
