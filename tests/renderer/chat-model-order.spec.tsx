// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { modelsInDisplayOrder } from '../../src/renderer/features/chat/model-order';
import { pickerGroups } from '../../src/renderer/features/chat/model-picker-options';

function model(id: string, name = id): AIModelInfo {
  return { id, name, contextWindow: 128_000, maxOutputTokens: 4_096, supportsStreaming: true };
}

const catalog = [
  model('zeta/model-10', 'zeta model 10'),
  model('alpha/model-2', 'Alpha model 2'),
  model('omp-default', 'Omp CLI default'),
  model('beta/model', 'beta model'),
  model('alpha/model-10', 'Alpha model 10'),
];

describe('model display order', () => {
  it('lists the provider default first, then every model alphabetically by name', () => {
    expect(modelsInDisplayOrder(catalog).map((entry) => entry.id)).toEqual([
      'omp-default',
      'alpha/model-2',
      'alpha/model-10',
      'beta/model',
      'zeta/model-10',
    ]);
    // The caller's catalog is not reordered in place.
    expect(catalog[0]?.id).toBe('zeta/model-10');
  });

  it('lists the picker group in that order', () => {
    const provider = {
      id: 'omp', name: 'Omp', available: true, installed: true, authentication: 'connected', version: null, errorMessage: null,
      models: catalog,
      capabilities: { streaming: true, subscriptionAuth: false, apiKeyAuth: false, persistentSessions: true, toolFreeMode: true, hostedWebSearch: false },
    } satisfies AIProviderStatus;
    const [group] = pickerGroups([provider], { state: 'idle', models: [], configuredModel: null }, { providerId: 'omp', modelId: 'beta/model' });
    expect(group?.rows.map((row) => row.name)).toEqual(['Omp CLI default', 'Alpha model 2', 'Alpha model 10', 'beta model', 'zeta model 10']);
  });
});
