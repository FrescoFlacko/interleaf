import { describe, expect, it, vi } from 'vitest';
import { parsePortableJson, isPortableRecord, type PortableRecord, type PortableValue } from '@shared/models/portable';
import {
  CHAT_LISTING_PROBES,
  ChatModelListingProbe,
  MAX_LISTED_CHAT_MODELS,
  listedChatModels,
  mergeListedReasoning,
  type ChatModelListing,
  type ListedChatProvider,
} from '@main/ai/chat-model-listing';
import { CLAUDE_REQUEST_ID, CODEX_MODEL_LIST_ID } from '@main/agents/model-discovery-probes';
import type { ProbeRequest } from '@main/agents/model-discovery';
import {
  claudeEntryReasoning,
  codexEntryReasoning,
  ollamaThinkingReasoning,
  ompEntryReasoning,
  openRouterReasoning,
  piEntryReasoning,
} from '@main/ai/providers/reasoning-metadata';
import { parseOllamaShow } from '@main/ai/providers/local-provider';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { aiProviderStatusSchema } from '@shared/schemas/ai';

/**
 * Per-model reasoning metadata is untrusted provider output. Each reader keeps
 * only the levels its provider documents, for the model it was listed with,
 * and fails closed to Default for anything missing or malformed.
 */

function record(value: PortableValue): PortableRecord {
  if (!isPortableRecord(value)) throw new Error('fixture is not a record');
  return value;
}

function json(text: string): PortableRecord {
  return record(parsePortableJson(text));
}

describe('provider reasoning readers', () => {
  it('reads Codex efforts, never ultra, and nothing from a malformed list', () => {
    expect(codexEntryReasoning(json('{"supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"low"},{"reasoningEffort":"ultra"},{"reasoningEffort":"low"}]}')))
      .toEqual({ levels: ['low', 'high'] });
    expect(codexEntryReasoning(json('{"supportedReasoningEfforts":"high"}'))).toBeNull();
    expect(codexEntryReasoning(json('{"supportedReasoningEfforts":[{"reasoningEffort":"ultra"}]}'))).toBeNull();
    expect(codexEntryReasoning(json('{}'))).toBeNull();
  });

  it('reads Claude levels only where the model says it supports effort', () => {
    expect(claudeEntryReasoning(json('{"supportsEffort":true,"supportedEffortLevels":["max","low","none","bogus"]}')))
      .toEqual({ levels: ['low', 'max'] });
    expect(claudeEntryReasoning(json('{"supportsEffort":false,"supportedEffortLevels":["low"]}'))).toBeNull();
    expect(claudeEntryReasoning(json('{"supportsEffort":true}'))).toBeNull();
  });

  it('reads Omp thinking levels, dropping auto', () => {
    expect(ompEntryReasoning(json('{"reasoning":true,"thinking":["auto","off","high"]}'))).toEqual({ levels: ['off', 'high'] });
    expect(ompEntryReasoning(json('{"reasoning":true,"thinking":null}'))).toBeNull();
    expect(ompEntryReasoning(json('{"reasoning":false,"thinking":["high"]}'))).toBeNull();
  });

  it('applies Pi’s own level rule to its thinking map', () => {
    expect(piEntryReasoning(json('{"reasoning":false}'))).toEqual({ levels: ['off'] });
    expect(piEntryReasoning(json('{"reasoning":true}'))).toEqual({ levels: ['off', 'minimal', 'low', 'medium', 'high'] });
    expect(piEntryReasoning(json('{"reasoning":true,"thinkingLevelMap":{"minimal":null,"xhigh":"x","max":null}}')))
      .toEqual({ levels: ['off', 'low', 'medium', 'high', 'xhigh'] });
    expect(piEntryReasoning(json('{"reasoning":true,"thinkingLevelMap":"all"}'))).toBeNull();
    expect(piEntryReasoning(json('{}'))).toBeNull();
  });

  it('reads OpenRouter’s catalog reasoning exactly as documented', () => {
    expect(openRouterReasoning(null)).toBeNull();
    expect(openRouterReasoning(json('{"mandatory":false}'))).toBeNull();
    expect(openRouterReasoning(json('{"supported_efforts":null}'))?.levels)
      .toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(openRouterReasoning(json('{"supported_efforts":["high","off","low"]}'))).toEqual({ levels: ['low', 'high'] });
    expect(openRouterReasoning(json('{"mandatory":true,"supported_efforts":["none","high"]}'))).toEqual({ levels: ['high'] });
    expect(openRouterReasoning(json('{"supported_efforts":[]}'))).toBeNull();
  });

  it('reads Ollama thinking values as named levels or an On/Off pair', () => {
    expect(ollamaThinkingReasoning(json('{"values":[true,false]}'))).toEqual({ levels: ['off', 'on'] });
    expect(ollamaThinkingReasoning(json('{"values":["low","medium","high","extreme"]}'))).toEqual({ levels: ['low', 'medium', 'high'] });
    expect(ollamaThinkingReasoning(json('{"values":[false]}'))).toBeNull();
    expect(ollamaThinkingReasoning(json('{"values":"high"}'))).toBeNull();
    expect(parseOllamaShow('{"model_info":{"a.context_length":8192},"thinking":{"values":[true,false]}}'))
      .toEqual({ contextWindow: 8192, reasoning: { levels: ['off', 'on'] } });
    expect(parseOllamaShow('not json').reasoning).toBeNull();
  });
});

function collect(providerId: ListedChatProvider, lines: readonly string[]): ChatModelListing | null {
  const collector = CHAT_LISTING_PROBES[providerId].createCollector();
  for (const line of lines) {
    const result = collector.accept(line);
    if (result !== null) return result;
  }
  return collector.finish();
}

describe('Reader Chat model listing collectors', () => {
  it('reads the Codex model/list answer and the default entry’s levels', () => {
    const frame = JSON.stringify({
      id: CODEX_MODEL_LIST_ID,
      result: {
        data: [
          { model: 'gpt-a', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
          { model: 'gpt-a', supportedReasoningEfforts: [] },
          { model: '--bad flag', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
          'not a record',
          { model: 'gpt-b' },
        ],
      },
    });
    expect(collect('codex', ['diagnostic line', '{broken', frame])).toEqual({
      models: [{ id: 'gpt-a', reasoning: { levels: ['high'] } }, { id: 'gpt-b', reasoning: null }],
      defaultReasoning: { levels: ['high'] },
    });
  });

  it('reads Claude’s list_models answer, keeping the default alias for the sentinel', () => {
    const frame = JSON.stringify({
      response: {
        request_id: CLAUDE_REQUEST_ID,
        subtype: 'success',
        response: {
          models: [
            { value: 'default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
            { value: 'opus', supportsEffort: true, supportedEffortLevels: ['xhigh'] },
          ],
        },
      },
    });
    const listing = collect('claude', [frame]);
    expect(listing?.defaultReasoning).toEqual({ levels: ['low', 'high'] });
    expect(listing?.models.find((model) => model.id === 'opus')?.reasoning).toEqual({ levels: ['xhigh'] });
  });

  it('reads Pi’s RPC model list only from the matching response', () => {
    const answer = (id: string) => JSON.stringify({
      type: 'response',
      id,
      command: 'get_available_models',
      success: true,
      data: { models: [{ provider: 'anthropic', id: 'claude-x', reasoning: true }, { provider: 'openai', id: 'tiny', reasoning: false }] },
    });
    expect(collect('pi', [answer('someone-else')])).toBeNull();
    expect(collect('pi', [answer('interleaf-chat-models')])).toEqual({
      models: [
        { id: 'anthropic/claude-x', reasoning: { levels: ['off', 'minimal', 'low', 'medium', 'high'] } },
        { id: 'openai/tiny', reasoning: { levels: ['off'] } },
      ],
      defaultReasoning: null,
    });
  });

  it('keeps at most the bounded number of entries', () => {
    const data = Array.from({ length: MAX_LISTED_CHAT_MODELS + 20 }, (_unused, index) => ({ model: `m-${String(index)}` }));
    const listing = collect('codex', [JSON.stringify({ id: CODEX_MODEL_LIST_ID, result: { data } })]);
    expect(listing?.models).toHaveLength(MAX_LISTED_CHAT_MODELS);
  });

  it('asks Pi for metadata only, with every project-extension surface off', () => {
    const pi = CHAT_LISTING_PROBES.pi;
    expect(pi.args).toEqual(expect.arrayContaining([
      '--mode', 'rpc', '--offline', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files',
    ]));
    expect(pi.stdin).toEqual([JSON.stringify({ id: 'interleaf-chat-models', type: 'get_available_models' })]);
    // No print mode, so nothing in the argv can start a turn.
    expect(pi.args).not.toContain('-p');
    expect(pi.args).not.toContain('--print');
  });
});

describe('ChatModelListingProbe', () => {
  const listing: ChatModelListing = { models: [{ id: 'gpt-a', reasoning: { levels: ['low'] } }], defaultReasoning: null };

  function probe(runProbe: (request: ProbeRequest<ChatModelListing>) => Promise<ChatModelListing | null>, now = () => 0) {
    const warn = vi.fn();
    return { warn, lister: new ChatModelListingProbe({ log: { warn }, probeCwd: '/safe/probe', now, runProbe }) };
  }

  it('runs the bounded probe in its own directory, caches the answer and joins a live probe', async () => {
    const runProbe = vi.fn<(request: ProbeRequest<ChatModelListing>) => Promise<ChatModelListing | null>>(() => Promise.resolve(listing));
    const { lister } = probe(runProbe);
    const [first, second] = await Promise.all([lister.list('codex', '/bin/codex'), lister.list('codex', '/bin/codex')]);
    expect(first).toBe(listing);
    expect(second).toBe(listing);
    await lister.list('codex', '/bin/codex');
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe.mock.calls[0]?.[0]).toMatchObject({ file: '/bin/codex', cwd: '/safe/probe', definition: CHAT_LISTING_PROBES.codex });
  });

  it('expires the cache and answers nothing for an empty listing', async () => {
    let clock = 0;
    const runProbe = vi.fn()
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce({ models: [], defaultReasoning: null });
    const { lister } = probe(runProbe, () => clock);
    await lister.list('claude', '/bin/claude');
    clock = 31 * 60 * 1000;
    expect(await lister.list('claude', '/bin/claude')).toBeNull();
    expect(runProbe).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a probe error without logging its message', async () => {
    const { lister, warn } = probe(() => Promise.reject(new Error('token=secret')));
    expect(await lister.list('pi', '/bin/pi')).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('cancels in-flight probes on close and waits for their cleanup', async () => {
    let signal: AbortSignal | undefined;
    const { lister } = probe((request) => new Promise((resolve) => {
      signal = request.signal;
      request.signal.addEventListener('abort', () => { resolve(null); });
    }));
    const pending = lister.list('codex', '/bin/codex');
    await vi.waitFor(() => { expect(signal).toBeDefined(); });
    await lister.close();
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeNull();
    expect(await lister.list('codex', '/bin/codex')).toBeNull();
  });

  it('keeps owning a probe a newer binary replaced: close aborts both and awaits their cleanup', async () => {
    const started: { file: string; signal: AbortSignal; settle: (value: ChatModelListing | null) => void }[] = [];
    const cleaned: string[] = [];
    const runProbe = vi.fn((request: ProbeRequest<ChatModelListing>) => new Promise<ChatModelListing | null>((resolve) => {
      const settle = (value: ChatModelListing | null): void => {
        // Resolves only once the child is cleaned up, as the real runner does.
        cleaned.push(request.file);
        resolve(value);
      };
      started.push({ file: request.file, signal: request.signal, settle });
      request.signal.addEventListener('abort', () => { settle(null); });
    }));
    const { lister } = probe(runProbe);
    const older = lister.list('codex', '/old/codex');
    const newer = lister.list('codex', '/new/codex');
    await vi.waitFor(() => { expect(started).toHaveLength(2); });
    await lister.close();
    expect(started.map((entry) => entry.signal.aborted)).toEqual([true, true]);
    expect(cleaned.sort()).toEqual(['/new/codex', '/old/codex']);
    expect(await older).toBeNull();
    expect(await newer).toBeNull();
  });

  it('never lets a replaced binary’s late answer overwrite the newer cache entry', async () => {
    const settles: ((value: ChatModelListing | null) => void)[] = [];
    const runProbe = vi.fn(() => new Promise<ChatModelListing | null>((resolve) => { settles.push(resolve); }));
    const { lister } = probe(runProbe);
    const stale: ChatModelListing = { models: [{ id: 'old-model', reasoning: null }], defaultReasoning: null };
    const older = lister.list('codex', '/old/codex');
    const newer = lister.list('codex', '/new/codex');
    await vi.waitFor(() => { expect(settles).toHaveLength(2); });
    settles[1]?.(listing);
    expect(await newer).toBe(listing);
    settles[0]?.(stale);
    // The obsolete probe still answers its own caller…
    expect(await older).toBe(stale);
    // …but the cache stays with the newer binary, and the older one is not cached.
    expect(await lister.list('codex', '/new/codex')).toBe(listing);
    expect(runProbe).toHaveBeenCalledTimes(2);
    const reprobe = lister.list('codex', '/old/codex');
    await vi.waitFor(() => { expect(settles).toHaveLength(3); });
    settles[2]?.(null);
    expect(await reprobe).toBeNull();
  });
});

describe('listed model catalog', () => {
  const sentinel: AIModelInfo = { id: 'claude-default', name: 'Default', contextWindow: 200_000, maxOutputTokens: 8_192, supportsStreaming: true };

  it('gives the sentinel the default entry’s levels and keeps the limits on every listed model', () => {
    const models = listedChatModels(sentinel, {
      models: [{ id: 'opus', reasoning: { levels: ['high'] } }, { id: '--evil', reasoning: { levels: ['low'] } }],
      defaultReasoning: { levels: ['low', 'high'] },
    });
    expect(models.map((model) => [model.id, model.reasoning?.levels ?? null])).toEqual([
      ['claude-default', ['low', 'high']],
      ['opus', ['high']],
    ]);
    expect(models[1]?.contextWindow).toBe(200_000);
    expect(listedChatModels(sentinel, null)).toEqual([sentinel]);
  });

  function status(models: readonly AIModelInfo[]): AIProviderStatus {
    return {
      id: 'claude', name: 'Claude Code', available: true, installed: true, authentication: 'connected',
      version: null, errorMessage: null, models: [...models],
      capabilities: { streaming: true, subscriptionAuth: true, apiKeyAuth: false, persistentSessions: false, toolFreeMode: true, hostedWebSearch: false },
    };
  }

  it.each([
    ['without an entry matching the sentinel', false],
    ['with an entry matching the sentinel', true],
  ])('caps a full listing %s at one provider status’s limit, default first', (_label, includesSentinel) => {
    const models = Array.from({ length: MAX_LISTED_CHAT_MODELS }, (_unused, index) => ({
      id: includesSentinel && index === 5 ? sentinel.id : `model-${String(index)}`,
      reasoning: index % 2 === 0 ? { levels: ['low' as const] } : null,
    }));
    const listed = listedChatModels(sentinel, { models, defaultReasoning: { levels: ['high'] } });
    expect(listed).toHaveLength(MAX_LISTED_CHAT_MODELS);
    expect(listed[0]).toEqual({ ...sentinel, reasoning: { levels: ['high'] } });
    const ids = listed.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === sentinel.id)).toHaveLength(1);
    // Every listed model keeps exactly its own levels.
    const byId = new Map(models.map((model) => [model.id, model.reasoning]));
    for (const model of listed.slice(1)) expect(model.reasoning ?? null).toEqual(byId.get(model.id));
    expect(aiProviderStatusSchema.safeParse(status(listed)).error?.issues ?? []).toEqual([]);
  });

  it('attaches listed levels by identifier and strips any the listing does not confirm', () => {
    const catalog: AIModelInfo[] = [
      { ...sentinel, id: 'a', reasoning: { levels: ['max'] } },
      { ...sentinel, id: 'b' },
    ];
    const merged = mergeListedReasoning(catalog, { models: [{ id: 'b', reasoning: { levels: ['low'] } }], defaultReasoning: null });
    expect(merged[0]).not.toHaveProperty('reasoning');
    expect(merged[1]?.reasoning).toEqual({ levels: ['low'] });
    expect(mergeListedReasoning(catalog, null)).toBe(catalog);
  });
});
